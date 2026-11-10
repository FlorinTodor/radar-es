// Cada fuente de vehículos rellena lo que se puede seguir de ellos (domain/seguir.js): todas traen al menos su
// línea (o toda la red de su operador) con una clave válida, y un servicio cuando sus datos lo hacen estable
// entre días. Con datos de prueba, sin red ni esperas reales. Una fuente de vehículos nueva tiene que
// añadirse a COVERED con la familia de adaptador que la prueba (ver docs/vehiculos.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { createSources } from '../../server/adapters/outbound/sources/index.js';
import { createRenfeSources, renfeFollow } from '../../server/adapters/outbound/sources/renfe.js';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { vehiclesFromFeed } from '../../server/adapters/outbound/sources/gtfs-rt.js';
import { createFgcSource } from '../../server/adapters/outbound/sources/fgc.js';
import { isFollowKey, followKind, scheduledServiceKey } from '../../server/domain/seguir.js';

const noop = () => {};
const quiet = { info: noop, warn: noop, error: noop };

/** Las claves de un vehículo valen y hay al menos una de línea. */
function assertFollow(v, what = v.id) {
  assert.ok(Array.isArray(v.follow) && v.follow.length, `${what}: sin claves`);
  for (const key of v.follow) assert.ok(isFollowKey(key), `${what}: ${key}`);
  assert.ok(v.follow.some((k) => followKind(k) === 'linea'), `${what}: sin línea`);
}

// Fuente de vehículos → familia de adaptador que la prueba aquí abajo.
const COVERED = {
  'renfe-cercanias': 'renfe', 'renfe-ld': 'renfe', fgc: 'fgc', 'ouigo-horario': 'horario con número', euskotren: 'horario',
  'metro-bilbao': 'gtfs-rt', 'moveuskadi-bus': 'gtfs-rt', 'alsa-horario': 'horario', 'amb-bus': 'horario', 'la-union': 'gtfs-rt',
  auvasa: 'gtfs-rt', 'emt-malaga': 'gtfs-rt', 'emt-fuenlabrada': 'gtfs-rt',
};
const covered = (id) => COVERED[id] ?? (/^(horario|bus)-/.test(id) ? 'horario' : null);

test('todas las fuentes de vehículos están cubiertas por una familia de adaptador probada aquí', () => {
  const deps = {
    http: { json: async () => ({}), bytes: async () => new Uint8Array(), text: async () => '' },
    cache: { bytes: async () => new Uint8Array() },
    stations: { get: () => undefined, name: () => null, nearest: () => null, all: () => [] },
    nap: { enabled: true, gtfs: async () => new Uint8Array(), updatedAt: async () => null },
    log: quiet, geocoder: { locate: async () => null }, pool: { run: async () => null },
  };
  const vehicles = createSources(deps).filter((s) => s.kind === 'vehicles');
  assert.ok(vehicles.length > 20);
  for (const s of vehicles) assert.ok(covered(s.id), `${s.id}: fuente de vehículos nueva, añádela a COVERED y prueba sus claves follow`);
});

// ---------- Renfe ----------

const pad = (s) => s.padEnd(40);
const NAMES = { 65000: 'València-Estació del Nord', 64103: 'Massanassa', 64200: 'Moixent' };
const stations = { get: (code) => (NAMES[code] ? { name: NAMES[code], lat: 39, lon: -0.4 } : undefined), name: (code) => NAMES[code] ?? null };
const cercaniasZip = zipSync({
  'routes.txt': strToU8(`route_id,route_short_name,route_long_name,route_type\n40T0006C2,C2,${pad('Moixent')}-Valencia Nord,2\n`),
  'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\n40T0006C2,S,4006J24054C2,40_C2\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n64200,Moixent,38.87,-0.75\n64103,Massanassa,39.41,-0.39\n65000,València Nord,39.4669,-0.3772\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n4006J24054C2,08:00:00,08:00:00,64200,1\n'
    + '4006J24054C2,09:00:00,09:00:00,64103,2\n4006J24054C2,09:15:00,09:15:00,65000,3\n'),
});
const ldZip = zipSync({
  'routes.txt': strToU8('route_id,route_short_name\nR1,AVANT\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,0805812026-11-10,08058\n'),
  'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n0805812026-11-10,65000,1\n0805812026-11-10,64200,2\n'),
});

test('Renfe: Cercanías por su número y su línea con el núcleo; AV/LD/MD por su número y su producto', async () => {
  const position = (tripId, id, label) => ({ vehicle: {
    trip: { tripId }, position: { latitude: 39.41, longitude: -0.39 }, currentStatus: 'STOPPED_AT', stopId: '64103', vehicle: { id, label },
  } });
  const feeds = {
    'vehicle_positions.json': { entity: [position('4006J24054C2', '24054', 'C2-24054-PLATF.(2)'), position('4099J99999C9', '99999', 'C9-99999')] },
    'vehicle_positions_LD.json': { entity: [position('0805812026-11-10', '08058')] },
  };
  const http = { json: async (url) => feeds[url.split('/').pop()] ?? { entity: [] } };
  const cache = { bytes: async (url, name) => (name === 'renfe-fomento_transit.zip' ? cercaniasZip : ldZip) };
  const [cercanias, ld] = createRenfeSources({ http, cache, stations, log: quiet });
  const { vehicles: [c2, unknown] } = await cercanias.fetch();
  assert.deepEqual(c2.follow, ['s-renfe-24054', 'l-renfe-40-C2']);
  assert.deepEqual(unknown.follow, ['s-renfe-99999', 'l-renfe-40-C9'], 'sin su viaje en el horario: el núcleo, del viaje');
  const { vehicles: [avant] } = await ld.fetch();
  assert.deepEqual(avant.follow, ['s-renfe-8058', 'l-renfe-Avant']);
  for (const v of [c2, unknown, avant]) assertFollow(v);
});

test('Renfe: el mismo número en Rodalies y en AV/LD/MD es el mismo servicio', () => {
  const rodalies = renfeFollow({ number: '18093', line: 'R16', lineKey: '51|R16', tripId: '5113M18093R16' });
  const regional = renfeFollow({ number: '18093', line: 'Regional Exprés' });
  assert.equal(rodalies[0], regional[0]);
  assert.equal(rodalies[0], 's-renfe-18093');
  assert.notEqual(rodalies[1], regional[1]);
});

// ---------- Horarios GTFS (metros, tranvías, autobuses, Ouigo, Euskotren, AMB, ALSA) ----------

const csv = (rows) => strToU8(rows.join('\n'));
const NOW = Date.parse('2026-11-01T11:00:00Z'); // 12:00 en Madrid
// Un autobús de 11:55 a 13:30 y otro por frecuencias (cada 10 min de 11:00 a 13:00, 30 min de viaje).
const busGtfs = () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_type', 'L1,L-1,3']),
  'trips.txt': csv(['route_id,service_id,trip_id,trip_short_name', 'L1,S,T1,', 'L1,S,F1,']),
  'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
  'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'A,Alfa,37.0,-6.0', 'B,Beta,37.0,-5.99']),
  'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'T1,11:55:00,11:55:00,A,1', 'T1,13:30:00,13:30:00,B,2',
    'F1,08:00:00,08:00:00,B,1', 'F1,08:30:00,08:30:00,A,2']),
  'frequencies.txt': csv(['trip_id,start_time,end_time,headway_secs', 'F1,11:00:00,13:00:00,600']),
});

test('horario: cada viaje por su línea, su origen y su hora (también los de frecuencias), y su línea', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: { gtfs: async () => busGtfs(), updatedAt: async () => null }, http: {}, log: quiet }, {
    id: 'bus-prueba', name: 'Prueba', mode: 'bus', ficheroId: 1, dataset: 1, operator: 'Sagalés Vic',
  });
  const { vehicles } = await source.fetch();
  assert.ok(vehicles.length >= 3, 'el de horario y varias repeticiones del de frecuencias');
  for (const v of vehicles) {
    assertFollow(v);
    assert.equal(v.follow[1], 'l-sagalesvic-L_2D1');
  }
  const t1 = vehicles.find((v) => v.origin === 'Alfa');
  assert.equal(t1.follow[0], scheduledServiceKey({ operator: 'Sagalés Vic', line: 'L-1', origin: 'A', departure: 11 * 3600 + 55 * 60 }));
  const repeats = vehicles.filter((v) => v.origin === 'Beta').map((v) => v.follow[0]);
  assert.equal(new Set(repeats).size, repeats.length, 'cada repetición, su hora de salida');
  assert.ok(repeats.every((k) => /-(1[12])[0-5]0$/.test(k)), repeats.join(' '));
  const again = (await source.fetch()).vehicles.find((v) => v.origin === 'Alfa');
  assert.deepEqual(again.follow, t1.follow, 'en la lectura siguiente, la misma');
});

test('horario con número de tren propio (Ouigo): se sigue por su número', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const zip = zipSync({
    'routes.txt': csv(['route_id,route_short_name,route_type', 'R,TGV,2']),
    'trips.txt': csv(['route_id,service_id,trip_id,trip_short_name', 'R,S,X1,TGV 06247']),
    'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
    'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'M,Madrid,40.4,-3.7', 'B,Barcelona,41.4,2.1']),
    'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'X1,11:30:00,11:30:00,M,1', 'X1,14:30:00,14:30:00,B,2']),
  });
  const source = createGtfsScheduleSource({ nap: { gtfs: async () => zip, updatedAt: async () => null }, http: {}, log: quiet }, {
    id: 'ouigo-horario', name: 'Ouigo', operator: 'Ouigo', ficheroId: 1, dataset: 1, mode: 'av',
    label: (trip) => trip.label?.replace(/^TGV\s*/i, '') ?? trip.id, numberedService: true,
  });
  const { vehicles: [v] } = await source.fetch();
  assert.deepEqual(v.follow, ['s-ouigo-6247', 'l-ouigo-TGV']);
});

// ---------- Sólo GPS (GTFS-RT de posiciones: Metro Bilbao, autobuses de Euskadi, AUVASA, EMT…) y FGC ----------

test('sólo GPS: su línea, o toda la red si no la dice; nunca un servicio (el número es el del coche)', () => {
  const feed = { entity: [
    { id: '1', vehicle: { position: { latitude: 43.2, longitude: -2.9 }, vehicle: { id: '489' }, trip: { routeId: '5' } } },
    { id: '2', vehicle: { position: { latitude: 43.2, longitude: -2.9 }, vehicle: { id: '509' }, trip: { routeId: 'MB' } } },
  ] };
  const [dbus] = vehiclesFromFeed(feed, { id: 'bus-dbus', mode: 'bus', operator: 'Dbus' });
  assert.deepEqual(dbus.follow, ['l-dbus-5']);
  const [, metro] = vehiclesFromFeed(feed, { id: 'metro-bilbao', mode: 'metro', operator: 'Metro Bilbao', line: () => null });
  assert.deepEqual(metro.follow, ['l-metrobilbao']);
  for (const v of [dbus, metro]) assertFollow(v);
});

test('FGC: su línea (da la unidad, no un número de servicio que se repita)', async () => {
  const record = { lin: 'S2', ut: '1f2cc2fd0376', geo_point_2d: { lat: 41.5, lon: 2.1 }, origen: 'PC', desti: 'SB', properes_parades: '' };
  const { vehicles: [v] } = await createFgcSource({ http: { json: async () => ({ results: [record] }) }, nap: { enabled: false } }).fetch();
  assert.deepEqual(v.follow, ['l-fgc-S2']);
  assertFollow(v);
});
