// Las consultas usan el reloj que se les inyecta (ClockPort), no la hora del sistema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuerySituation } from '../../server/application/use-cases/query-situation.js';

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

test('Cercanías: lo que le queda y la flecha salen de sus paradas, no sólo del trazado de Renfe', () => {
  // Trazado en «U» por el norte; el tren va de W a E. Con sus paradas sobre el trazado, se dibuja; si su
  // próxima parada no está en él (va por el sur), no se dibuja nada en vez de dar la vuelta.
  const U = [[-3.70, 40.40], [-3.70, 40.45], [-3.65, 40.45], [-3.65, 40.40]];
  const network = { lines: () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: U }, properties: { network: 'Cercanías Renfe', shapes: ['10_C7'] } }] }) };
  const stops = { 'renfe-c:A': [[-3.70, 40.43], [-3.65, 40.45], [-3.65, 40.40]], 'renfe-c:B': [[-3.675, 40.40], [-3.65, 40.40]] };
  const source = { id: 'renfe-cercanias', shapeNetwork: 'Cercanías Renfe', stopsAhead: (id) => stops[id] ?? null };
  const v = (id) => ({ id, source: 'renfe-cercanias', mode: 'cercanias', shape: '10_C7', ahead: true, lon: -3.70, lat: 40.40 });
  const situation = fakeSituation({ vehicles: [v('renfe-c:A'), v('renfe-c:B')] });
  const query = makeQuerySituation({ situation, stations: {}, network, clock: { now: () => T0 }, sources: [source] });
  const a = query.ahead('renfe-c:A');
  assert.deepEqual(a.at(-1), [-3.65, 40.4]);
  assert.equal(query.ahead('renfe-c:B'), null);
  const live = Object.fromEntries(query.live().vehicles.map((x) => [x.id, x]));
  assert.equal(live['renfe-c:A'].heading, 0, 'hacia el norte, por su vía');
  assert.equal(live['renfe-c:B'].heading, undefined, 'sin camino ni rastro, sin flecha');
});
