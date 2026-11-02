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

test('la lista de estaciones junta las de Renfe y las de otras redes; la ficha se busca en las dos', () => {
  const renfe = new Map([['71801', { code: '71801', name: 'Barcelona-Sants', place: 'Barcelona', lat: 41.38, lon: 2.14, photo: {} }]]);
  const others = new Map([['tmb:1', { code: 'tmb:1', name: 'Sants Estació', network: 'Metro de Barcelona (TMB)', networkId: 'tmb', mode: 'metro', lat: 41.379, lon: 2.14, lines: [] }]]);
  const catalog = (m) => ({ all: () => [...m.values()], get: (c) => m.get(c) });
  const query = makeQuerySituation({ situation: fakeSituation(), stations: catalog(renfe), networkStations: catalog(others), network: {}, clock: { now: () => T0 } });
  const list = query.stations();
  assert.deepEqual(list.map((s) => s.code), ['71801', 'tmb:1']);
  assert.equal('photo' in list[0], false, 'la lista va ligera: la foto, en la ficha');
  assert.equal('network' in list[0], false);
  assert.deepEqual([list[1].network, list[1].networkId, list[1].mode], ['Metro de Barcelona (TMB)', 'tmb', 'metro']);
  assert.equal(query.station('tmb:1').name, 'Sants Estació');
  assert.equal(query.station('71801').name, 'Barcelona-Sants');
  assert.equal(query.station('tmb:9'), null);
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
