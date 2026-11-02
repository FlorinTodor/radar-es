// Las consultas usan el reloj que se les inyecta (ClockPort), no la hora del sistema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuerySituation } from '../../server/application/use-cases/query-situation.js';
import { buildRailNetwork } from '../../server/domain/rail-match.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 18, 18, 0);

function fakeSituation({ vehicles = [], tracks = new Map() } = {}) {
  return {
    vehicles: () => vehicles,
    events: () => [],
    tracks: () => tracks,
    metrics: () => ({}),
    health: () => [],
    activeAlerts: () => new Map(),
    resolvedAlerts: () => [],
    kpis: () => null,
    kpiHistory: () => [],
  };
}

test('generatedAt sale del reloj inyectado', () => {
  const query = makeQuerySituation({ situation: fakeSituation(), stations: {}, network: {}, clock: { now: () => T0 } });
  assert.equal(query.live().generatedAt, T0);
  assert.equal(query.liveEvents().generatedAt, T0);
  assert.equal(query.liveBuses().generatedAt, T0);
  assert.equal(query.snapshot().generatedAt, T0);
});

test('las estelas cortan la ventana de minutos con el reloj inyectado', () => {
  const point = (minutesAgo, lon) => ({ t: T0 - minutesAgo * MIN, lat: 40, lon });
  const tracks = new Map([['a', [point(30, -3.9), point(20, -3.8), point(10, -3.7), point(0, -3.6)]]]);
  const situation = fakeSituation({ vehicles: [{ id: 'a', mode: 'cercanias' }], tracks });
  const query = makeQuerySituation({ situation, stations: {}, network: {}, clock: { now: () => T0 } });
  const [trail] = query.trails(15).features;
  assert.deepEqual(trail.geometry.coordinates.map(([lon]) => lon), [-3.7, -3.6], 'sólo los puntos de los últimos 15 min');
  assert.equal(query.trails(45).features[0].geometry.coordinates.length, 4);
});

// Recorrido de los trenes de Larga Distancia por la vía (red de Adif). Red en L cerca de Oviedo:
// 2 km hacia el este y luego 2 km hacia el norte.
const ESQUINA = [-5.80, 43.36];
const railNet = buildRailNetwork([[[-5.825, 43.36], ESQUINA], [ESQUINA, [-5.80, 43.378]]]);
const LD = { id: 'renfe-ld', onRailNetwork: true };
const CERCANIAS = { id: 'renfe-cercanias' };

test('el recorrido de un tren de la red general va por la vía y se calcula una vez por posición nueva', () => {
  const track = [{ t: T0 - 2 * MIN, lat: 43.3601, lon: -5.81 }, { t: T0, lat: 43.37, lon: -5.8001 }];
  const tracks = new Map([['renfe-ld:00123', track], ['renfe-cercanias:C1', track]]);
  const query = makeQuerySituation({
    situation: fakeSituation({ tracks }), stations: {}, network: {}, clock: { now: () => T0 },
    sources: [LD, CERCANIAS], railNetwork: { network: () => railNet },
  });
  const path = query.track('renfe-ld:00123');
  assert.ok(path.some(({ lon, lat }) => lon === ESQUINA[0] && lat === ESQUINA[1]), 'dobla la esquina por la vía');
  assert.deepEqual(Object.keys(path[0]), ['lon', 'lat']);
  assert.equal(query.track('renfe-ld:00123'), path, 'sin posición nueva, el mismo recorrido ya calculado');
  track.push({ t: T0 + 20_000, lat: 43.375, lon: -5.8001 });
  const longer = query.track('renfe-ld:00123');
  assert.notEqual(longer, path);
  assert.ok(longer.length > path.length);
  assert.equal(query.track('renfe-cercanias:C1'), track, 'las fuentes sin onRailNetwork, tal cual');
  assert.equal(query.track('renfe-ld:otro'), null);
});

test('mientras no hay red (o sin ella) el recorrido son las posiciones tal cual', () => {
  const track = [{ t: T0 - MIN, lat: 43.3601, lon: -5.81 }, { t: T0, lat: 43.37, lon: -5.8001 }];
  const tracks = new Map([['renfe-ld:00123', track]]);
  const deps = { situation: fakeSituation({ tracks }), stations: {}, network: {}, clock: { now: () => T0 }, sources: [LD] };
  assert.equal(makeQuerySituation({ ...deps, railNetwork: { network: () => null } }).track('renfe-ld:00123'), track);
  assert.equal(makeQuerySituation(deps).track('renfe-ld:00123'), track);
});

test('lo que le queda a un tren de la red general: por la vía hasta su destino, calculado una vez por posición', () => {
  const track = [{ t: T0, lat: 43.3601, lon: -5.81 }];
  const tracks = new Map([['renfe-ld:00123', track]]);
  const destino = [-5.80, 43.375];
  const trips = { 'renfe-ld:00123': { gauge: 'iberian', stops: [destino] }, 'renfe-ld:00456': null };
  const source = { ...LD, railTrip: (id) => (id.startsWith('renfe-ld:') ? trips[id] ?? null : undefined) };
  const deps = { situation: fakeSituation({ tracks }), stations: {}, network: {}, clock: { now: () => T0 }, sources: [source] };
  const query = makeQuerySituation({ ...deps, railNetwork: { network: () => railNet } });
  const ahead = query.ahead('renfe-ld:00123');
  assert.ok(ahead.some(([lon, lat]) => lon === ESQUINA[0] && lat === ESQUINA[1]), 'dobla la esquina por la vía');
  assert.deepEqual(ahead.at(-1), destino);
  assert.equal(query.ahead('renfe-ld:00123'), ahead, 'sin posición nueva, el mismo cálculo');
  assert.equal(query.ahead('renfe-ld:00456'), null, 'viaje desconocido');
  assert.equal(query.ahead('renfe-cercanias:C1'), null);
  assert.equal(makeQuerySituation({ ...deps, railNetwork: { network: () => null } }).ahead('renfe-ld:00123'), null, 'sin red, nada');
});
