// Renfe: origen, destino, próxima parada y final del recorrido de cada tren. Ni el nombre de la línea
// ni el trazado dicen el sentido de un viaje de Cercanías: lo dicen sus paradas (stop_times).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { cercaniasNext, createRenfeSources, createTimetables, routeEnds } from '../../server/adapters/outbound/sources/renfe.js';

const pad = (s) => s.padEnd(40);
const NAMES = { 65000: 'València-Estació del Nord', 64102: 'Alfafar-Benetússer', 64103: 'Massanassa', 64200: 'Moixent' };
const stations = {
  get: (code) => (NAMES[code] ? { name: NAMES[code], place: 'Valencia' } : undefined),
  name: (code) => (code ? NAMES[code] ?? `Estación ${code}` : null),
};
const log = { warn: () => {}, info: () => {} };

// Como la C2 de Valencia: la línea «Moixent - Valencia Nord» con un trazado que va al revés (de
// Valencia a Moixent), y un viaje corto que no llega a Moixent.
function cercaniasZip() {
  return zipSync({
    'routes.txt': strToU8(`route_id,route_short_name,route_long_name,route_type\n40T0006C2,C2,${pad('Moixent')}-Valencia Nord,2\n10T0001C3,C3,${pad('Chamartín - Clara Campoamor')}-Aranjuez,2\n`),
    'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\n40T0006C2,S,SUBE,40_C2_INV\n40T0006C2,S,CORTO,40_C2_INV\n10T0001C3,S,SIN_PARADAS,10_C3\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n64200,Moixent,38.87,-0.75\n64103,Massanassa,39.41,-0.39\n64102,Alfafar-Benetússer,39.42,-0.39\n65000,València Nord,39.4669,-0.3772\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + 'SUBE,08:00:00,08:00:00,64200,1\nSUBE,09:00:00,09:00:00,64103,2\nSUBE,09:05:00,09:05:00,64102,3\nSUBE,09:15:00,09:15:00,65000,4\n'
      + 'CORTO,10:00:00,10:00:00,64200,1\nCORTO,10:30:00,10:30:00,64103,2\n'),
  });
}

function ldZip() {
  return zipSync({
    'routes.txt': strToU8('route_id,route_short_name\nR1,AVE\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,0515212026-10-30,05152\n'),
    'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n0515212026-10-30,65000,1\n0515212026-10-30,64200,2\n'),
  });
}

const cacheWith = (zips) => ({ bytes: async (url, name) => zips[name] });

test('el nombre de la línea son dos columnas de 40 caracteres, aunque un nombre lleve guion', () => {
  assert.deepEqual(routeEnds(`${pad('Chamartín - Clara Campoamor')}-Aranjuez       `), { origin: 'Chamartín - Clara Campoamor', destination: 'Aranjuez' });
  assert.deepEqual(routeEnds('Principe Pio -Aeropuerto-T4'), { origin: 'Principe Pio', destination: 'Aeropuerto-T4' });
  assert.deepEqual(routeEnds(undefined), { origin: null, destination: null });
});

test('Cercanías: origen, destino y final salen de las paradas del viaje, no de la línea ni del trazado', async () => {
  const t = createTimetables({ cache: cacheWith({ 'renfe-fomento_transit.zip': cercaniasZip() }), stations, log });
  await t.loadCercanias();
  const sube = t.cercanias('SUBE');
  assert.equal(sube.origin, 'Moixent');
  assert.equal(sube.destination, 'València-Estació del Nord', 'el nombre oficial de la estación, no el del GTFS');
  assert.deepEqual(sube.end, [-0.3772, 39.4669]);
  assert.equal(sube.shape, '40_C2_INV');
  assert.deepEqual([...sube.stops], ['64200', '64103', '64102', '65000']);
  const corto = t.cercanias('CORTO');
  assert.equal(corto.destination, 'Massanassa', 'un viaje corto acaba donde acaba, no al final de la línea');
  assert.deepEqual(corto.end, [-0.39, 39.41]);
});

test('Cercanías sin paradas en el horario: el nombre de la línea, sin final (no se dibuja hacia ningún lado)', async () => {
  const t = createTimetables({ cache: cacheWith({ 'renfe-fomento_transit.zip': cercaniasZip() }), stations, log });
  await t.loadCercanias();
  const c3 = t.cercanias('SIN_PARADAS');
  assert.equal(c3.origin, 'Chamartín - Clara Campoamor');
  assert.equal(c3.destination, 'Aranjuez');
  assert.equal(c3.end, null);
});

test('Cercanías en camino: stopId es la estación que acaba de dejar; la próxima es la siguiente del viaje', () => {
  const stops = ['64200', '64103', '64102', '65000'];
  assert.equal(cercaniasNext('IN_TRANSIT_TO', '64103', stops), '64102');
  assert.equal(cercaniasNext('IN_TRANSIT_TO', '65000', stops), null, 'tras la última no hay próxima');
  assert.equal(cercaniasNext('IN_TRANSIT_TO', '99999', stops), null, 'si no es de su viaje, mejor nada que una equivocada');
  assert.equal(cercaniasNext('IN_TRANSIT_TO', '64103', null), null);
  assert.equal(cercaniasNext('INCOMING_AT', '64103', stops), '64103', 'llegando: es a la que llega');
  assert.equal(cercaniasNext('STOPPED_AT', '64103', stops), '64103');
});

test('la ficha de un Cercanías en camino: última estación la que ha dejado, próxima la siguiente, sin vía', async () => {
  const feed = { header: { timestamp: '1' }, entity: [{ vehicle: {
    trip: { tripId: 'SUBE' }, position: { latitude: 39.415, longitude: -0.39 }, currentStatus: 'IN_TRANSIT_TO', stopId: '64103',
    vehicle: { id: '24054', label: 'C2-24054-PLATF.(2)' },
  } }] };
  const http = { json: async (url) => (url.endsWith('vehicle_positions.json') ? feed : { entity: [] }) };
  const [cercanias] = createRenfeSources({ http, cache: cacheWith({ 'renfe-fomento_transit.zip': cercaniasZip() }), stations, log });
  const { vehicles: [v] } = await cercanias.fetch();
  assert.equal(v.origin, 'Moixent');
  assert.equal(v.destination, 'València-Estació del Nord');
  assert.equal(v.current, 'Massanassa');
  assert.equal(v.next, 'Alfafar-Benetússer');
  assert.equal(v.platform, null, 'la vía era la de la estación que ha dejado');
  assert.deepEqual(v.end, [-0.3772, 39.4669]);
});

test('Larga distancia: con el horario de otro periodo, el tren se encuentra por su número', async () => {
  const t = createTimetables({ cache: cacheWith({ 'renfe-google_transit.zip': ldZip() }), stations, log });
  await t.loadLd();
  assert.equal(t.ldExact('0515212026-10-31'), false);
  assert.deepEqual(t.ld('0515212026-10-31', '05152'), { service: 'AVE', mode: 'av', origin: 'València-Estació del Nord', destination: 'Moixent' });
  assert.equal(t.ld('9999912026-10-31', '99999'), undefined);
});

test('Larga distancia: si muchos trenes no están en el horario guardado, se vuelve a leer (una vez por hora)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T10:00:00Z') });
  const reads = [];
  const cache = { bytes: async (url, name, maxAgeMs) => { reads.push(maxAgeMs); return ldZip(); } };
  const feed = { entity: ['0515212026-10-31', '0600012026-10-31'].map((tripId, i) => ({ vehicle: {
    trip: { tripId }, position: { latitude: 40, longitude: -3 }, vehicle: { id: tripId.slice(0, 5) }, stopId: '65000', currentStatus: 'IN_TRANSIT_TO', timestamp: i,
  } })) };
  const http = { json: async (url) => (url.endsWith('vehicle_positions_LD.json') ? feed : { entity: [] }) };
  const [, ld] = createRenfeSources({ http, cache, stations, log });
  const first = await ld.fetch();
  assert.equal(first.vehicles[0].origin, 'València-Estació del Nord', 'mientras tanto, por número');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, [24 * 3600_000, 3600_000], 'la copia de un día y, al ver que no están, una de menos de una hora');
  await ld.fetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2, 'no otra vez en la misma hora');
  t.mock.timers.tick(61 * 60_000);
  await ld.fetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 3, 'pasada la hora, sí');
});

test('Larga distancia por número: el periodo vigente (el último que ya empezó), no uno futuro', async () => {
  const zip = zipSync({
    'routes.txt': strToU8('route_id,route_short_name\nR1,AVE\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,0515212000-01-01,05152\nR1,B,0515212001-01-01,05152\nR1,C,0515212999-01-01,05152\n'),
    'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n'
      + '0515212000-01-01,65000,1\n0515212000-01-01,64103,2\n'
      + '0515212001-01-01,65000,1\n0515212001-01-01,64200,2\n'
      + '0515212999-01-01,65000,1\n0515212999-01-01,64102,2\n'),
  });
  const t = createTimetables({ cache: cacheWith({ 'renfe-google_transit.zip': zip }), stations, log });
  await t.loadLd();
  assert.equal(t.ld('desconocido', '05152').destination, 'Moixent');
});

test('un autobús de Renfe (route_type 3) va con los autobuses, no como tren de Cercanías', async () => {
  const zip = zipSync({
    'routes.txt': strToU8(`route_id,route_short_name,route_long_name,route_type\n41T0025C2,C2,${pad('Aguilas')}-Lorca-Sutullena,3\n`),
    'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\n41T0025C2,S,BUS,41_C2\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n64200,Moixent,38.87,-0.75\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nBUS,08:00:00,08:00:00,64200,1\n'),
  });
  const feed = { entity: [{ vehicle: { trip: { tripId: 'BUS' }, position: { latitude: 37.6, longitude: -1.7 }, currentStatus: 'IN_TRANSIT_TO', vehicle: { id: '84922', label: 'C2-84922' } } }] };
  const http = { json: async (url) => (url.endsWith('vehicle_positions.json') ? feed : { entity: [] }) };
  const [cercanias] = createRenfeSources({ http, cache: cacheWith({ 'renfe-fomento_transit.zip': zip }), stations, log });
  const { vehicles: [v] } = await cercanias.fetch();
  assert.equal(v.mode, 'bus');
  assert.equal(v.service, 'Autobús de Renfe');
});
