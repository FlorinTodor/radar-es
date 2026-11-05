// Horario con tiempo real (Euskotren, AMB): los viajes que su feed da como cancelados no se colocan en el
// mapa como si circularan; salen como cancelaciones, con su horario. Las paradas suprimidas de los
// autobuses, una vez por línea. Sin esperas reales: el reloj es simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { strToU8, zipSync } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

const { transit_realtime: rt } = createRequire(import.meta.url)('gtfs-realtime-bindings');
const csv = (rows) => strToU8(rows.join('\n'));
const quiet = { info() {}, warn() {} };
const NOW = Date.parse('2026-11-01T11:00:00Z'); // 12:00 en Madrid

const gtfs = (routeType) => () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_type', `L1,L1,${routeType}`]),
  'trips.txt': csv(['route_id,service_id,trip_id', 'L1,S,T1', 'L1,S,T2', 'L1,S,T3']),
  'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
  'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'A,Alfa,37.0,-6.0', 'B,Beta,37.0,-5.99', 'C,Gamma,37.0,-5.98']),
  'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    'T1,11:55:00,11:55:00,A,1', 'T1,12:30:00,12:31:00,B,2', 'T1,13:30:00,13:30:00,C,3',
    'T2,11:50:00,11:50:00,A,1', 'T2,12:20:00,12:21:00,B,2', 'T2,13:20:00,13:20:00,C,3',
    'T3,11:45:00,11:45:00,A,1', 'T3,12:15:00,12:16:00,B,2', 'T3,13:15:00,13:15:00,C,3']),
});
const tripUpdate = (tripId, relation, skippedSeq = []) => ({
  id: tripId,
  tripUpdate: {
    trip: { tripId, startDate: '20261101', scheduleRelationship: relation },
    stopTimeUpdate: relation === 'CANCELED' ? [] : [
      { stopSequence: 1, arrival: { delay: 60 } },
      ...skippedSeq.map((stopSequence) => ({ stopSequence, scheduleRelationship: 'SKIPPED' })),
    ],
  },
});
const feed = (entity) => rt.FeedMessage.encode(rt.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1_793_530_000 }, entity })).finish();
const source = (routeType, entities, extra = {}) => createGtfsScheduleSource({
  nap: { gtfs: async () => gtfs(routeType)(), updatedAt: async () => '2026-10-30T10:00:00' }, http: { bytes: async () => feed(entities) }, log: quiet,
}, { id: 'prueba', name: 'Prueba', ficheroId: 1, dataset: 1, operator: 'Euskotren', tripUpdatesUrl: 'https://ejemplo/trip-updates', ...extra });

test('tren cancelado: no se coloca en el mapa y sale como cancelación con su horario y su día', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const s = source(2, [tripUpdate('T1', 'CANCELED'), tripUpdate('T2', 'SCHEDULED', [2]), tripUpdate('T3', 'SCHEDULED')], {
    cancellationCredit: 'Open Data Euskadi (cancelaciones)',
  });
  const { vehicles, events } = await s.fetch();
  assert.deepEqual(vehicles.map((v) => v.id.split(':')[1]).sort(), ['T2', 'T3'], 'el cancelado no circula');
  const byId = new Map(events.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), ['prueba-cancelado:T1:20261101', 'prueba-cancelado:T2:20261101']);
  const cancelled = byId.get('prueba-cancelado:T1:20261101');
  assert.equal(cancelled.title, 'Euskotren L1 cancelado: Alfa 11:55 → Gamma');
  assert.equal(cancelled.trip.date, '2026-11-01');
  assert.deepEqual(cancelled.trip.stops.map((st) => st.time), ['11:55', '12:30', '13:30']);
  assert.equal(cancelled.credit, 'Open Data Euskadi (cancelaciones)', 'la atribución de sus cancelaciones, no la de la posición estimada');
  assert.equal(cancelled.trip.feedUrl, 'https://ejemplo/trip-updates');
  assert.equal(cancelled.seen, NOW);
  const partial = byId.get('prueba-cancelado:T2:20261101');
  assert.equal(partial.title, 'Euskotren L1 no para en Beta');
  assert.equal(partial.type, 'parcial');
});

test('autobuses con paradas suprimidas en varias expediciones: una cancelación por línea, con todas las que suprime', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // Cada expedición trae las suyas (las que le quedan): la línea las junta.
  const s = source(3, [tripUpdate('T1', 'SCHEDULED', [1]), tripUpdate('T2', 'SCHEDULED', [1, 2]), tripUpdate('T3', 'SCHEDULED')], { operator: 'AMB', mode: 'bus' });
  const { events } = await s.fetch();
  assert.equal(events.length, 1);
  const [line] = events;
  assert.equal(line.id, 'prueba-suprimidas:L1');
  assert.equal(line.title, 'Línea L1 de AMB no para en 2 paradas');
  assert.equal(line.severity, 'baja');
  assert.equal(line.trip.trips, 2);
  assert.deepEqual(line.trip.skipped, ['Alfa', 'Beta']);
  assert.equal(line.trip.stops, null, 'sin la lista entera de paradas: son varias expediciones');
  assert.equal(line.trip.departure, null, 'ni una hora en concreto');
  assert.deepEqual([line.lon, line.lat], [-6, 37], 'en la primera parada suprimida');
  assert.match(line.description, /estas 2 paradas en 2 expediciones: Alfa; Beta\./);
});

test('sin tiempo real, no hay cancelaciones (ni la lista vacía)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const s = createGtfsScheduleSource({ nap: { gtfs: async () => gtfs(3)(), updatedAt: async () => '2026-10-30T10:00:00' }, http: {}, log: quiet },
    { id: 'sin-rt', name: 'Sin', ficheroId: 1, dataset: 1, operator: 'X', mode: 'bus' });
  const result = await s.fetch();
  assert.equal(result.events, undefined);
});
