// «Parado en» una estación con la posición a kilómetros. En Cercanías, la posición no está al día (Renfe
// deja de renovarla durante minutos) o es de relleno: se marca para no fiarse de ella. En AV/LD/MD es
// otra cosa: al salir de una estación, Renfe da durante minutos la siguiente como «parado en» con el
// tren ya en marcha; la posición es buena y el tren va de camino.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createRenfeSources } from '../../server/adapters/outbound/sources/renfe.js';

const STATIONS = {
  21010: { name: 'Ferrol', place: 'Ferrol', lat: 43.4894, lon: -8.2253 },
  21004: { name: 'Pontedeume', place: 'Pontedeume', lat: 43.4065, lon: -8.1717 },
  21002: { name: 'Betanzos-Infesta', place: 'Betanzos', lat: 43.2857, lon: -8.2154 },
  98305: { name: 'Valdebebas', place: 'Madrid', lat: 40.48191, lon: -3.61629 },
  31412: { name: 'A Coruña', place: 'A Coruña', lat: 43.34969, lon: -8.41556 },
  31400: { name: 'Santiago de Compostela-Daniel Castelao', place: 'Santiago de Compostela', lat: 42.87084, lon: -8.5447 },
  99159: { name: 'Santiago-Turístico', place: 'Santiago de Compostela', lat: 42.87084, lon: -8.5447 },
  22100: { name: 'Ourense', place: 'Ourense', lat: 42.35039, lon: -7.87278 },
};
const stations = { get: (code) => STATIONS[code], name: (code) => STATIONS[code]?.name ?? null };
const log = { warn: () => {}, info: () => {} };
const noTimetables = { bytes: async () => { throw new Error('sin horario en la prueba'); } };

const ld = (number, stopId, currentStatus, latitude, longitude, date = '2026-11-01') => ({ vehicle: {
  trip: { tripId: `${number}1${date}` }, vehicle: { id: number }, stopId, currentStatus, position: { latitude, longitude },
} });
const sources = (feeds, cache = noTimetables) => {
  const http = { json: async (url) => feeds[url.split('/').at(-1)] ?? { entity: [] } };
  return createRenfeSources({ http, cache, stations, log });
};
const byLabel = (vehicles) => Object.fromEntries(vehicles.map((v) => [v.label, v]));

test('Cercanías parado en una estación a más de 1,5 km de su posición: se marca con la distancia; cerca, no', async () => {
  const c1 = (number, latitude, longitude) => ({ vehicle: {
    trip: { tripId: `1005L${number}C1` }, vehicle: { id: number, label: `C1-${number}-PLATF.(2)` }, stopId: '98305', currentStatus: 'STOPPED_AT', position: { latitude, longitude },
  } });
  const [cercanias] = sources({ 'vehicle_positions.json': { entity: [c1('19945', 40.49240, -3.59348), c1('19947', 40.4820, -3.6165)] } });
  const by = byLabel((await cercanias.fetch()).vehicles);
  assert.equal(by['19945'].farFromStop, 2.3, 'la posición es la de T4, a 2,3 km');
  assert.equal(by['19945'].current, 'Valdebebas');
  assert.equal(by['19947'].farFromStop, undefined);
  assert.equal(by['19947'].stopped, true);
});

test('AV/LD/MD «parado» lejos de la estación: va de camino hacia ella, sin marca de posición vieja', async () => {
  const [, largaDistancia] = sources({ 'vehicle_positions_LD.json': { entity: [
    ld('12692', '21010', 'STOPPED_AT', 43.41187, -8.18034), // «parado en Ferrol» a 9,4 km, saliendo de Pontedeume
    ld('12690', '21004', 'STOPPED_AT', 43.4069, -8.1722), // en Pontedeume de verdad
    ld('12694', '21010', 'IN_TRANSIT_TO', 43.41187, -8.18034), // de camino a Ferrol
  ] } });
  const by = byLabel((await largaDistancia.fetch()).vehicles);
  assert.equal(by['12692'].farFromStop, undefined);
  assert.equal(by['12692'].stopped, false);
  assert.equal(by['12692'].current, null);
  assert.equal(by['12692'].next, 'Ferrol');
  assert.equal(by['12690'].stopped, true);
  assert.equal(by['12690'].current, 'Pontedeume');
  assert.equal(by['12694'].next, 'Ferrol');
});

test('AV/LD/MD «parado» en una estación que ya ha dejado atrás: es la última y le queda desde la siguiente', async () => {
  const zip = zipSync({
    'routes.txt': strToU8('route_id,route_short_name\nR1,MD\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,1269212026-11-02,12692\nR1,A,1269612026-11-02,12696\n'),
    'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n'
      + '1269212026-11-02,21002,1\n1269212026-11-02,21004,2\n1269212026-11-02,21010,3\n'
      + '1269612026-11-02,21002,1\n1269612026-11-02,21004,2\n1269612026-11-02,21010,3\n'),
  });
  const [, largaDistancia] = sources({ 'vehicle_positions_LD.json': { entity: [
    // A medio camino entre Pontedeume y Ferrol (5 km de cada una): «parado en Pontedeume» es que acaba de salir.
    ld('12692', '21004', 'STOPPED_AT', 43.4480, -8.1985, '2026-11-02'),
    // Entre Betanzos y Pontedeume, «parado en Pontedeume»: va hacia allí.
    ld('12696', '21004', 'STOPPED_AT', 43.3400, -8.1900, '2026-11-02'),
  ] } }, { bytes: async () => zip });
  const by = byLabel((await largaDistancia.fetch()).vehicles);
  assert.equal(by['12692'].stopped, false);
  assert.equal(by['12692'].current, 'Pontedeume');
  assert.equal(by['12692'].next, 'Ferrol');
  assert.deepEqual(largaDistancia.railTrip('renfe-ld:12692').stops, [[-8.2253, 43.4894]]);
  assert.equal(by['12696'].current, null);
  assert.equal(by['12696'].next, 'Pontedeume');
  assert.deepEqual(largaDistancia.railTrip('renfe-ld:12696').stops, [[-8.1717, 43.4065], [-8.2253, 43.4894]]);
});

test('AV/LD/MD «en camino hacia» una parada ficticia del mismo sitio que una estación ya dejada atrás: va a la siguiente', async () => {
  // El Avant A Coruña → Ourense del 4-nov-2026: «hacia Santiago-Turístico» a 59 km pasado Santiago.
  const zip = zipSync({
    'routes.txt': strToU8('route_id,route_short_name\nR1,Avant\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,0920112026-11-03,09201\nR1,A,0920312026-11-03,09203\n'),
    'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n'
      + '0920112026-11-03,31412,1\n0920112026-11-03,31400,3\n0920112026-11-03,99159,4\n0920112026-11-03,22100,5\n'
      + '0920312026-11-03,31412,1\n0920312026-11-03,31400,3\n0920312026-11-03,99159,4\n0920312026-11-03,22100,5\n'),
  });
  const [, largaDistancia] = sources({ 'vehicle_positions_LD.json': { entity: [
    ld('09201', '99159', 'IN_TRANSIT_TO', 42.47431, -8.087117, '2026-11-03'),
    // Entre A Coruña y Santiago, de camino a Santiago-Turístico: no la ha dejado atrás.
    ld('09203', '99159', 'IN_TRANSIT_TO', 43.10, -8.48, '2026-11-03'),
  ] } }, { bytes: async () => zip });
  const by = byLabel((await largaDistancia.fetch()).vehicles);
  assert.equal(by['09201'].next, 'Ourense');
  assert.deepEqual(largaDistancia.railTrip('renfe-ld:09201').stops, [[-7.87278, 42.35039]]);
  assert.equal(by['09203'].next, 'Santiago-Turístico');
});
