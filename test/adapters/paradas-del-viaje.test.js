// Paradas del viaje de cada vehículo (/api/stops/<id>) en cada fuente que las sabe: Renfe AV/LD/MD (con
// la hora de su horario), Cercanías (las de su viaje), FGC (las que le quedan) y las posiciones según
// horario (metros, tranvías, autobuses…).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { cercaniasFrom, createRenfeSources } from '../../server/adapters/outbound/sources/renfe.js';
import { createFgcSource, fgcTripCodes } from '../../server/adapters/outbound/sources/fgc.js';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

const log = { warn() {}, info() {} };
const AT = { 65000: [-0.3772, 39.4669], 64102: [-0.39, 39.42], 64200: [-0.75, 38.87] };
const stations = {
  get: (code) => (AT[code] ? { name: `Estación ${code}`, lon: AT[code][0], lat: AT[code][1] } : undefined),
  name: (code) => (code ? `Estación ${code}` : null),
};

test('Renfe AV/LD/MD: todas las paradas con la hora del horario, las pasadas y la prevista con su retraso', async () => {
  const zip = zipSync({
    'routes.txt': strToU8('route_id,route_short_name\nR1,MD\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,1800012026-11-04,18000\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + '1800012026-11-04,10:30:00,10:32:00,64102,2\n1800012026-11-04,10:00:00,10:00:00,65000,1\n'
      + '1800012026-11-04,11:15:00,11:15:00,64200,3\n'),
  });
  const feed = { entity: [{ vehicle: {
    trip: { tripId: '1800012026-11-04' }, position: { latitude: 39.43, longitude: -0.385 }, vehicle: { id: '18000' }, stopId: '64102', currentStatus: 'IN_TRANSIT_TO',
  } }] };
  const updates = { entity: [{ tripUpdate: { trip: { tripId: '1800012026-11-04' }, delay: 300, stopTimeUpdate: [] } }] };
  const http = { json: async (url) => (url.endsWith('vehicle_positions_LD.json') ? feed : url.endsWith('trip_updates_LD.json') ? updates : { entity: [] }) };
  const [, ld] = createRenfeSources({ http, cache: { bytes: async () => zip }, stations, log });
  const { vehicles: [v] } = await ld.fetch();
  assert.equal(v.stops, true);
  assert.deepEqual(ld.tripStops('renfe-ld:18000'), {
    partial: false,
    stops: [
      { name: 'Estación 65000', lon: -0.3772, lat: 39.4669, time: '10:00', eta: null, passed: true },
      { name: 'Estación 64102', lon: -0.39, lat: 39.42, time: '10:30', eta: '10:35', passed: false },
      { name: 'Estación 64200', lon: -0.75, lat: 38.87, time: '11:15', eta: '11:20', passed: false },
    ],
  });
  assert.equal(ld.tripStops('renfe-ld:77777'), null, 'tren de la fuente sin viaje conocido');
  assert.equal(ld.tripStops('fgc:1'), undefined, 'vehículo de otra fuente');
});

test('Cercanías: desde cuál le quedan según su estado (parado en una aún no la ha pasado)', () => {
  const stops = ['A', 'B', 'C'];
  assert.equal(cercaniasFrom('IN_TRANSIT_TO', 'B', stops), 2, 'en camino: stopId es la que acaba de dejar');
  assert.equal(cercaniasFrom('STOPPED_AT', 'B', stops), 1);
  assert.equal(cercaniasFrom('INCOMING_AT', 'B', stops), 1);
  assert.equal(cercaniasFrom('IN_TRANSIT_TO', 'X', stops), -1);
});

test('Cercanías: las paradas de su viaje con el nombre del catálogo o del GTFS, y la prevista de su trip update', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-04T10:00:00Z') });
  const zip = zipSync({
    'routes.txt': strToU8('route_id,route_short_name,route_long_name,route_type\nC1,C1,Valencia - Gandia,2\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\nC1,S,T1,SH1\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n65000,Valencia Nord,39.4669,-0.3772\n64102,Sedaví,39.42,-0.39\n99999,Apeadero,39.3,-0.4\n'),
    'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\nT1,65000,1\nT1,64102,2\nT1,99999,3\n'),
  });
  const feed = { entity: [{ vehicle: {
    trip: { tripId: 'T1' }, position: { latitude: 39.43, longitude: -0.385 }, vehicle: { label: 'C1-23000' }, stopId: '65000', currentStatus: 'IN_TRANSIT_TO',
  } }] };
  const arrival = Date.parse('2026-11-04T10:06:00Z') / 1000;
  const updates = { entity: [{ tripUpdate: { trip: { tripId: 'T1' }, stopTimeUpdate: [{ stopId: '64102', arrival: { time: String(arrival) } }] } }] };
  const http = { json: async (url) => (url.endsWith('/vehicle_positions.json') ? feed : url.endsWith('/trip_updates.json') ? updates : { entity: [] }) };
  const [cercanias] = createRenfeSources({ http, cache: { bytes: async () => zip }, stations, log });
  const { vehicles: [v] } = await cercanias.fetch();
  assert.equal(v.stops, true);
  const { stops } = cercanias.tripStops(v.id);
  assert.deepEqual(stops.map((s) => [s.name, s.passed, s.eta]), [
    ['Estación 65000', true, null], ['Estación 64102', false, '11:06'], ['Apeadero', false, null],
  ]);
  assert.deepEqual([stops[2].lon, stops[2].lat], [-0.4, 39.3], 'la que no está en el catálogo, del GTFS de Cercanías');
  assert.equal(cercanias.tripStops('renfe-c:otro'), null);
});

test('FGC: el origen y la última en la que ha estado, pasadas; las que le quedan, hasta su destino', () => {
  assert.deepEqual(fgcTripCodes({ origen: 'NA', desti: 'PC', estacionat_a: 'MN', properes_parades: '{"parada": "SG"};{"parada": "GR"};{"parada": "PC"}' }),
    { codes: ['NA', 'MN', 'SG', 'GR', 'PC'], from: 2, partial: true, here: false });
  assert.deepEqual(fgcTripCodes({ origen: 'PC', desti: 'NA', estacionat_a: 'PC', properes_parades: '{"parada": "PR"}' }),
    { codes: ['PC', 'PR', 'NA'], from: 0, partial: false, here: true }, 'aún en el origen: está en él, ninguna pasada y el destino al final');
  assert.equal(fgcTripCodes({ origen: 'PC', desti: 'PC', properes_parades: '' }), null);
});

test('FGC: tripStops con los nombres y la posición de su GTFS', async () => {
  const gtfs = zipSync({ 'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nNA,Terrassa Nacions Unides,41.57,2.02\nMN,Muntaner,41.399,2.14\nPC,Barcelona - Pl. Catalunya,41.386,2.167\n') });
  const nap = { enabled: true, gtfs: async () => gtfs };
  const record = { ut: '113', lin: 'S1', origen: 'NA', desti: 'PC', estacionat_a: 'MN', properes_parades: '{"parada": "PC"}', geo_point_2d: { lat: 41.4, lon: 2.14 } };
  const http = { json: async () => ({ results: [record] }) };
  const fgc = createFgcSource({ http, nap, log });
  const { vehicles: [v] } = await fgc.fetch();
  assert.equal(v.stops, true);
  const data = fgc.tripStops('fgc:113');
  assert.equal(data.partial, true);
  assert.deepEqual(data.stops.map((s) => [s.name, s.passed, s.lon]), [
    ['Terrassa Nacions Unides', true, 2.02], ['Muntaner', true, 2.14], ['Barcelona - Pl. Catalunya', false, 2.167],
  ]);
  assert.equal(fgc.tripStops('renfe-ld:1'), undefined);
});

test('posición según horario: sus paradas con la hora del horario y las que ya ha pasado', async (t) => {
  // A las 12:00 de Madrid el vehículo va entre Alfa (11:55) y Beta (12:05).
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T11:00:00Z') });
  const zip = zipSync({
    'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
    'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,L1,1\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
    'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.99\nC,Gamma,37.01,-5.99\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:54:00,11:55:00,A,1\nT1,12:05:00,12:06:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
  });
  const nap = { gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' };
  const source = createGtfsScheduleSource({ nap, http: {} }, { id: 'horario-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 1, dataset: 1 });
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.stops, true);
  assert.deepEqual(source.tripStops(v.id).stops.map((s) => [s.name, s.time, s.passed]), [
    ['Alfa', '11:55', true], ['Beta', '12:05', false], ['Gamma', '12:15', false],
  ], 'la primera con su hora de salida; sin retraso real, sin prevista');
  assert.equal(source.tripStops('horario-prueba:T1:20260101'), null, 'un viaje que no circula');
  assert.equal(source.tripStops('horario-pruebas:T1'), undefined, 'otra fuente, aunque empiece igual');
});
