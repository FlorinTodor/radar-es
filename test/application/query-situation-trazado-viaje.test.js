// Vehículos con GPS que hacen un viaje con trazado (tripShape de su fuente): su recorrido, por el trazado desde que hacen
// ese viaje (salvo si su licencia pide no alterar el contenido) y lo que les queda, desde donde van hasta el final.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuerySituation } from '../../server/application/use-cases/query-situation.js';
import { buildShape } from '../../server/domain/schedule.js';

const T0 = Date.UTC(2026, 10, 16, 12, 0);
const MIN = 60_000;
// 2 km hacia el este con un quiebro hacia el norte a mitad (la recta entre dos posiciones cruzaría la manzana).
const shape = buildShape([-3.7, 40.4, -3.6882, 40.4, -3.6882, 40.401, -3.6764, 40.401]);
const track = [
  { lon: -3.6999, lat: 40.4002, t: T0 - 20 * MIN }, // del viaje anterior: no cuenta (since)
  { lon: -3.695, lat: 40.4001, t: T0 - 4 * MIN },
  { lon: -3.6866, lat: 40.4011, t: T0 - 1 * MIN },
];

function setup({ raw = false } = {}) {
  const situation = {
    vehicles: () => [], events: () => [], metrics: () => ({}), health: () => [], activeAlerts: () => new Map(), resolvedAlerts: () => [],
    kpis: () => null, kpiHistory: () => [], tracks: () => new Map([['bus-prueba:1', track]]),
  };
  const source = {
    id: 'bus-prueba', rawTrack: raw,
    tripShape: (id) => (id.startsWith('bus-prueba:') ? (id === 'bus-prueba:1' ? { shape, since: T0 - 5 * MIN, tripId: 'T1' } : null) : undefined),
  };
  return makeQuerySituation({ situation, stations: {}, network: { lines: () => null }, clock: { now: () => T0 }, sources: [source] });
}

test('su recorrido va por el trazado de su viaje, desde que lo hace, y pasa por el quiebro', () => {
  const path = setup().track('bus-prueba:1');
  assert.ok(path.length >= 3, JSON.stringify(path));
  assert.ok(path.some((p) => Math.abs(p.lon - -3.6882) < 1e-4), 'por la esquina, no en recta');
  assert.ok(path[0].lon > -3.697, 'sin la posición del viaje anterior');
});

test('lo que le queda: desde donde va hasta el final de su viaje', () => {
  const ahead = setup().ahead('bus-prueba:1');
  assert.ok(Math.abs(ahead[0][0] - -3.6866) < 2e-4);
  assert.deepEqual(ahead.at(-1), [-3.6764, 40.401]);
});

test('si su licencia pide no alterar el contenido, su recorrido va tal cual; lo que le queda, igual por su trazado', () => {
  const query = setup({ raw: true });
  assert.deepEqual(query.track('bus-prueba:1'), track);
  assert.ok(query.ahead('bus-prueba:1').length > 1);
});

test('un vehículo de esa fuente sin trazado de viaje: recorrido tal cual y sin lo que le queda', () => {
  const query = setup();
  assert.equal(query.track('bus-prueba:2'), null, 'sin recorrido guardado');
  assert.equal(query.ahead('bus-prueba:2'), null);
});

test('la flecha de un autobús con GPS sale del trazado de su viaje', () => {
  const situation = {
    vehicles: () => [{ id: 'bus-prueba:1', mode: 'bus', source: 'bus-prueba', ahead: true, lat: 40.4011, lon: -3.6866 }], events: () => [], metrics: () => ({}),
    health: () => [], activeAlerts: () => new Map(), resolvedAlerts: () => [], kpis: () => null, kpiHistory: () => [],
    tracks: () => new Map([['bus-prueba:1', track]]),
  };
  const source = { id: 'bus-prueba', tripShape: (id) => (id === 'bus-prueba:1' ? { shape, since: T0 - 5 * MIN, tripId: 'T1' } : undefined) };
  const query = makeQuerySituation({ situation, stations: {}, network: { lines: () => null }, clock: { now: () => T0 }, sources: [source] });
  const [bus] = query.liveBuses().vehicles;
  assert.ok(Math.abs(bus.heading - 90) < 5, `hacia el este por la calle de arriba (${bus.heading})`);
});
