// Las consultas usan el reloj que se les inyecta (ClockPort), no la hora del sistema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeQuerySituation } from '../../server/application/use-cases/query-situation.js';
import { buildRailNetwork } from '../../server/domain/rail-match.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 18, 18, 0);

function fakeSituation({ vehicles = [], tracks = new Map(), events = [] } = {}) {
  return {
    vehicles: () => vehicles,
    events: () => events,
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

test('lo que le queda de un id inventado no monta la lista de vehículos (no tiene coste ni gasta presupuesto)', () => {
  let lists = 0;
  const situation = { ...fakeSituation({ vehicles: [{ id: 'renfe-c:A', source: 'renfe-cercanias', shape: '10_C7', lon: -3.7, lat: 40.4 }] }), vehicles: () => { lists++; return []; } };
  const source = { id: 'renfe-cercanias', shapeNetwork: 'Cercanías Renfe', stopsAhead: (id) => (id === 'renfe-c:A' ? [[-3.65, 40.4]] : null) };
  const query = makeQuerySituation({ situation, stations: {}, network: { lines: () => ({ features: [] }) }, clock: { now: () => T0 }, sources: [source] });
  for (let i = 0; i < 100; i++) assert.equal(query.ahead(`inventado-${i}`), null);
  assert.equal(lists, 0);
  query.ahead('renfe-c:A');
  assert.equal(lists, 1, 'un tren con paradas sí se busca');
});

test('la flecha de cientos de Cercanías: lo calculado de los que acaban su viaje sale del memo sin recorrerlo en cada cálculo', () => {
  // Muchos trenes que pasan por el memo y luego desaparecen: el memo no crece sin fin y las flechas siguen saliendo.
  const U = [[-3.70, 40.40], [-3.70, 40.45]];
  const network = { lines: () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: U }, properties: { network: 'Cercanías Renfe', shapes: ['S'] } }] }) };
  const source = { id: 'renfe-cercanias', shapeNetwork: 'Cercanías Renfe', stopsAhead: () => [[-3.70, 40.44]] };
  let vehicles = [];
  const tracks = new Map();
  const situation = { ...fakeSituation(), vehicles: () => vehicles, tracks: () => tracks };
  const query = makeQuerySituation({ situation, stations: {}, network, clock: { now: () => T0 }, sources: [source] });
  for (let round = 0; round < 30; round++) {
    tracks.clear();
    vehicles = Array.from({ length: 200 }, (_, i) => ({ id: `renfe-c:${round}-${i}`, source: 'renfe-cercanias', mode: 'cercanias', shape: 'S', lon: -3.70, lat: 40.40 + i / 1e5 }));
    for (const v of vehicles) tracks.set(v.id, [{ t: T0, lat: v.lat, lon: v.lon }]);
    const live = query.live().vehicles;
    assert.ok(live.every((v) => v.heading === 0), `ronda ${round}: todas hacia el norte`);
  }
});

test('un aviso oficial que ya pasó de su vigencia no sale aunque su fuente no haya vuelto a responder', () => {
  const events = [
    { id: 'corte-viejo', category: 'emergencia', power: true, expires: T0 - MIN },
    { id: 'corte-en-vigor', category: 'emergencia', power: true, expires: T0 + MIN },
    { id: 'obra', category: 'carretera' }, // sin vigencia: la decide su fuente en cada lectura
  ];
  const query = makeQuerySituation({ situation: fakeSituation({ events }), stations: {}, network: {}, clock: { now: () => T0 } });
  assert.deepEqual(query.events().map((e) => e.id), ['corte-en-vigor', 'obra']);
  assert.deepEqual(query.events({ category: 'emergencia' }).map((e) => e.id), ['corte-en-vigor']);
  assert.deepEqual(query.liveEvents().events.map((e) => e.id), ['corte-en-vigor', 'obra']);
  assert.deepEqual(query.snapshot().events.map((e) => e.id), ['corte-en-vigor', 'obra']);
});

test('un plan activado por un apagón se muestra como plan, no como corte de luz, pasado un día', () => {
  const plateca = {
    id: 'plateca', category: 'emergencia', type: 'apagon', power: true, severity: 'alta', area: 'La Palma',
    title: 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma',
  };
  const events = [{ ...plateca, issued: T0 - 25 * 60 * MIN, expires: T0 + 60 * 60 * MIN }];
  const query = makeQuerySituation({ situation: fakeSituation({ events }), stations: {}, network: {}, clock: { now: () => T0 } });
  assert.deepEqual(query.events().map((e) => [e.type, e.power]), [['plan', false]]);
  assert.deepEqual(query.liveEvents().events.map((e) => e.type), ['plan'], 'también en el mapa');
});

test('las paradas de un vehículo las da la fuente que lo conoce; si ninguna, null', () => {
  const list = { partial: false, stops: [{ name: 'A' }, { name: 'B' }] };
  const sources = [
    { id: 'otra', tripStops: (id) => (id.startsWith('otra:') ? null : undefined) },
    { id: 'renfe-ld', tripStops: (id) => (id === 'renfe-ld:1' ? list : id.startsWith('renfe-ld:') ? null : undefined) },
  ];
  const query = makeQuerySituation({ situation: fakeSituation(), stations: {}, network: {}, clock: { now: () => T0 }, sources });
  assert.equal(query.stops('renfe-ld:1'), list);
  assert.equal(query.stops('otra:9'), null, 'la fuente lo conoce pero no sabe sus paradas');
  assert.equal(query.stops('nadie:1'), null);
});

test('Cercanías cuyo trazado no llega a su destino: lo que falta va por la vía; sin red, hasta donde llega el trazado', () => {
  // El trazado de Renfe acaba en ESQUINA (como el de un C6 a Vinaròs, que acaba en Castelló) y la vía sigue al norte.
  const end = [-5.80, 43.378];
  const network = { lines: () => ({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-5.825, 43.36], ESQUINA] }, properties: { network: 'Cercanías Renfe', shapes: ['40_C6'] } }] }) };
  const source = { id: 'renfe-cercanias', shapeNetwork: 'Cercanías Renfe', stopsAhead: () => [ESQUINA, end] };
  const v = { id: 'renfe-c:A', source: 'renfe-cercanias', mode: 'cercanias', shape: '40_C6', ahead: true, lon: -5.82, lat: 43.36 };
  const make = (railNetwork) => makeQuerySituation({ situation: fakeSituation({ vehicles: [v] }), stations: {}, network, clock: { now: () => T0 }, sources: [source], railNetwork });
  const km = (a, b) => Math.hypot((a[0] - b[0]) * 81, (a[1] - b[1]) * 111);
  const byRail = make({ network: () => railNet }).ahead('renfe-c:A');
  assert.ok(km(byRail.at(-1), end) < 0.05, 'llega a su destino por la vía');
  const byShape = make(undefined).ahead('renfe-c:A');
  assert.ok(km(byShape.at(-1), ESQUINA) < 0.05, 'sin red, se corta donde acaba el trazado');
});
