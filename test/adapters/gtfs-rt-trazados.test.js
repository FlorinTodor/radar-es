// Autobuses con GPS cuyo tiempo real dice qué viaje hacen: el trazado de ese viaje (de su horario) para su recorrido y lo
// que les queda (AUVASA, EMT Málaga, EMT Fuenlabrada; Euskadi, con su recorrido tal cual).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsRtVehicleSource, tripStartMs } from '../../server/adapters/outbound/sources/gtfs-rt.js';
import { createTripTracker, readTripShapes } from '../../server/adapters/outbound/gtfs/trip-shapes.js';
import { createMoveuskadiBusSource } from '../../server/adapters/outbound/sources/moveuskadi-bus.js';

const require = createRequire(import.meta.url);
const { transit_realtime: rt } = require('gtfs-realtime-bindings');
const NOW = Date.parse('2026-11-16T12:00:00Z'); // 13:00 en Madrid
const log = { info() {}, warn() {}, error() {} };

// Horario con dos viajes: T1 con trazado (1 km hacia el este, desordenado a propósito) y T2 sin él.
const gtfs = zipSync({
  'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\nL1,S,T1,SH1\nL1,S,T2,\n'),
  'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH1,40.4,-3.69,3\nSH1,40.4,-3.7,1\nSH1,40.4,-3.695,2\n'),
});

const feed = (vehicles) => rt.FeedMessage.encode(rt.FeedMessage.fromObject({
  header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000 },
  entity: vehicles.map(([id, tripId, lon, extra = {}]) => ({
    id, vehicle: { vehicle: { id }, trip: tripId ? { tripId, ...extra } : undefined, position: { latitude: 40.4001, longitude: lon }, timestamp: NOW / 1000 },
  })),
})).finish();

test('readTripShapes: cada viaje, su trazado ordenado por secuencia; sin shapes.txt, ninguno', async () => {
  const shapes = await readTripShapes(gtfs);
  assert.equal(shapes.trips, 1);
  const sh = shapes.shapeOf('T1');
  assert.ok(Math.abs(sh.coords[0] - -3.7) < 1e-6 && Math.abs(sh.coords.at(-2) - -3.69) < 1e-6, 'de oeste a este, como dice la secuencia');
  assert.equal(shapes.shapeOf('T2'), null);
  assert.equal(shapes.shapeOf(undefined), null);
  const bare = await readTripShapes(zipSync({ 'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n') }));
  assert.equal(bare.shapeOf('T1'), null);
});

test('createTripTracker: desde cuándo hace su viaje; al cambiar de viaje empieza de nuevo; los que no salen, fuera', () => {
  const tracker = createTripTracker();
  const sh = { coords: new Float32Array(4), dist: new Float32Array(2) };
  tracker.see('v1', 'T1', sh, 1000);
  tracker.see('v1', 'T1', sh, 2000);
  assert.equal(tracker.get('v1').since, 1000);
  tracker.see('v1', 'T9', sh, 3000, 2500);
  assert.equal(tracker.get('v1').since, 2500, 'el feed dice que empezó a las 2500');
  tracker.see('v1', 'T9', null, 4000);
  assert.equal(tracker.get('v1'), null, 'sin trazado, nada');
  tracker.see('v2', 'T1', sh, 1000);
  tracker.keep(new Set());
  assert.equal(tracker.get('v2'), null);
});

test('tripStartMs: start_date y start_time en hora de Madrid, también pasada la medianoche del horario', () => {
  assert.equal(tripStartMs({ startDate: '20261116', startTime: '13:00:00' }), Date.parse('2026-11-16T12:00:00Z'));
  assert.equal(tripStartMs({ startDate: '20261116', startTime: '25:10:00' }), Date.parse('2026-11-17T00:10:00Z'));
  assert.equal(tripStartMs({ startDate: '20261116' }), null);
  assert.equal(tripStartMs(undefined), null);
});

test('una fuente GTFS-RT con su horario: los vehículos de un viaje con trazado lo saben y llevan `ahead`', async () => {
  const jobs = [];
  const pool = { queue: (fn) => { const job = fn(); jobs.push(job); return job; } };
  const http = { bytes: async () => feed([['1', 'T1', -3.698, { startDate: '20261116', startTime: '12:50:00' }], ['2', 'T2', -3.7], ['3', null, -3.7]]) };
  const source = createGtfsRtVehicleSource({ http, log, now: () => NOW, pool }, { id: 'bus-prueba', name: 'Prueba', url: 'u', mode: 'bus', operator: 'Bus', shapesZip: async () => gtfs });
  const first = await source.fetch();
  assert.ok(!first.vehicles.some((v) => v.ahead), 'la primera lectura no espera al horario');
  await Promise.all(jobs);
  const { vehicles } = await source.fetch();
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  assert.equal(byId.get('bus-prueba:1').ahead, true);
  assert.equal(byId.get('bus-prueba:2').ahead, undefined, 'viaje sin trazado');
  assert.equal(byId.get('bus-prueba:3').ahead, undefined, 'sin viaje');
  const trip = source.tripShape('bus-prueba:1');
  assert.equal(trip.tripId, 'T1');
  assert.equal(trip.since, Date.parse('2026-11-16T11:50:00Z'), 'desde la hora a la que empezó su viaje');
  assert.equal(source.tripShape('bus-prueba:2'), null);
  assert.equal(source.tripShape('otra:1'), undefined, 'de otra fuente');
  assert.equal(source.rawTrack, false);
});

test('Euskadi: el horario de cada operador con vehículos; su recorrido, tal cual (rawTrack); otros «bus-…», no son suyos', async () => {
  const jobs = [];
  const pool = { queue: (fn) => { const job = fn(); jobs.push(job); return job; } };
  const http = {
    json: async (url) => (url.includes('gtfs-rt')
      ? { data: { Dbus: [{ url: 'https://x/dbus_vehicle_positions.pb' }], Vacio: [{ url: 'https://x/vacio_vehicle_positions.pb' }] } }
      : { data: { Dbus: [{ url: 'https://x/gtfs_dbus.zip' }] } }),
    bytes: async (url) => (url.includes('dbus') ? feed([['7', 'T1', -3.698]]) : feed([])),
  };
  const asked = [];
  const cache = { bytes: async (url) => { asked.push(url); return gtfs; } };
  const source = createMoveuskadiBusSource({ http, log, cache, pool, now: () => NOW });
  await source.fetch();
  await Promise.all(jobs);
  const { vehicles } = await source.fetch();
  assert.equal(vehicles[0].id, 'bus-dbus:7');
  assert.equal(vehicles[0].ahead, true);
  assert.deepEqual(asked, ['https://x/gtfs_dbus.zip'], 'sólo el horario del operador que tiene vehículos');
  assert.equal(source.tripShape('bus-dbus:7').tripId, 'T1');
  assert.equal(source.rawTrack, true);
  assert.equal(source.tripShape('bus-vacio:1'), null, 'de uno de sus operadores, aún sin trazados');
  assert.equal(source.tripShape('bus-urbanos:0:T1:20261116'), undefined, 'un autobús por horario no es suyo');
});
