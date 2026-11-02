// Renfe AV/LD/MD: las paradas de cada viaje, en orden, y las que le quedan a cada tren desde su próxima
// parada (stopId), con el ancho de vía de su producto: con eso se dibuja por la vía lo que le queda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createRenfeSources, createTimetables } from '../../server/adapters/outbound/sources/renfe.js';

const AT = { 65000: [-0.3772, 39.4669], 64102: [-0.39, 39.42], 64103: [-0.39, 39.41], 64200: [-0.75, 38.87] };
const stations = {
  get: (code) => (AT[code] ? { name: `Estación ${code}`, lon: AT[code][0], lat: AT[code][1] } : undefined),
  name: (code) => (code ? `Estación ${code}` : null),
};
const log = { warn() {}, info() {} };

// Dos viajes con las mismas paradas (filas desordenadas, como permite el GTFS) y un AVE.
const zip = zipSync({
  'routes.txt': strToU8('route_id,route_short_name\nR1,MD\nR2,AVE\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,1800012026-11-02,18000\nR1,A,1800212026-11-02,18002\nR2,A,0500012026-11-02,05000\n'),
  'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n'
    + '1800012026-11-02,64103,3\n1800012026-11-02,65000,1\n1800012026-11-02,99999,4\n1800012026-11-02,64102,2\n1800012026-11-02,64200,5\n'
    + '1800212026-11-02,65000,1\n1800212026-11-02,64102,2\n1800212026-11-02,64103,3\n1800212026-11-02,99999,4\n1800212026-11-02,64200,5\n'
    + '0500012026-11-02,65000,1\n0500012026-11-02,64200,2\n'),
});
const cache = { bytes: async () => zip };

test('cada viaje guarda sus paradas en orden, compartidas entre los viajes que las repiten', async () => {
  const t = createTimetables({ cache, stations, log });
  await t.loadLd();
  const a = t.ld('1800012026-11-02');
  assert.deepEqual([...a.stops], ['65000', '64102', '64103', '99999', '64200']);
  assert.equal(t.ld('1800212026-11-02').stops, a.stops, 'la misma lista, no una copia por viaje');
  assert.equal(a.gauge, 'iberian');
  assert.equal(t.ld('0500012026-11-02').gauge, 'standard');
});

test('railTrip: ancho y paradas que le quedan desde la próxima; el tren lleva ahead', async () => {
  const position = (tripId, stopId) => ({ vehicle: {
    trip: { tripId }, position: { latitude: 39.43, longitude: -0.38 }, vehicle: { id: tripId.slice(0, 5) }, stopId, currentStatus: 'IN_TRANSIT_TO',
  } });
  const feed = { entity: [position('1800012026-11-02', '64103'), position('0500012026-11-02', '11111')] };
  const http = { json: async (url) => (url.endsWith('vehicle_positions_LD.json') ? feed : { entity: [] }) };
  const [, ld] = createRenfeSources({ http, cache, stations, log });
  const { vehicles } = await ld.fetch();
  const md = vehicles.find((v) => v.id === 'renfe-ld:18000');
  const ave = vehicles.find((v) => v.id === 'renfe-ld:05000');
  assert.equal(md.ahead, true);
  assert.equal(ave.ahead, undefined, 'su próxima parada no está en su viaje: no se sabe lo que le queda');
  // Desde la próxima (64103) hasta el destino; la parada sin coordenadas (99999) se salta.
  assert.deepEqual(ld.railTrip('renfe-ld:18000'), { gauge: 'iberian', stops: [AT[64103], AT[64200]] });
  assert.deepEqual(ld.railTrip('renfe-ld:05000'), { gauge: 'standard', stops: null });
  assert.equal(ld.railTrip('renfe-ld:77777'), null, 'tren de la fuente sin viaje conocido');
  assert.equal(ld.railTrip('renfe-c:1'), undefined, 'tren de otra fuente');
});
