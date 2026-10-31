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
