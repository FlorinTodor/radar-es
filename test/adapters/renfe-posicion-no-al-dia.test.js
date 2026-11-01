// Renfe da a veces un tren «parado en» una estación con una posición a kilómetros: la posición no está
// al día (deja de renovarla durante minutos) o es de relleno. Se marca para no fiarse de ella.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenfeSources } from '../../server/adapters/outbound/sources/renfe.js';

const STATIONS = { 21010: { name: 'Ferrol', place: 'Ferrol', lat: 43.4894, lon: -8.2253 }, 21004: { name: 'Pontedeume', place: 'Pontedeume', lat: 43.4065, lon: -8.1717 } };
const stations = { get: (code) => STATIONS[code], name: (code) => STATIONS[code]?.name ?? null };
const log = { warn: () => {}, info: () => {} };
const cache = { bytes: async () => { throw new Error('sin horario en la prueba'); } };

const ld = (number, stopId, currentStatus, latitude, longitude) => ({ vehicle: {
  trip: { tripId: `${number}12026-11-01` }, vehicle: { id: number }, stopId, currentStatus, position: { latitude, longitude },
} });

test('parado en una estación a más de 1,5 km de su posición: se marca con la distancia; cerca o en camino, no', async () => {
  const feed = { entity: [
    ld('12692', '21010', 'STOPPED_AT', 43.41187, -8.18034), // «parado en Ferrol» a 9,4 km
    ld('12690', '21004', 'STOPPED_AT', 43.4069, -8.1722), // en Pontedeume de verdad
    ld('12694', '21010', 'IN_TRANSIT_TO', 43.41187, -8.18034), // de camino a Ferrol: lejos es normal
  ] };
  const http = { json: async (url) => (url.endsWith('vehicle_positions_LD.json') ? feed : { entity: [] }) };
  const [, source] = createRenfeSources({ http, cache, stations, log });
  const { vehicles } = await source.fetch();
  const by = Object.fromEntries(vehicles.map((v) => [v.label, v]));
  assert.equal(by['12692'].farFromStop, 9.4);
  assert.equal(by['12692'].current, 'Ferrol');
  assert.equal(by['12690'].farFromStop, undefined);
  assert.equal(by['12694'].farFromStop, undefined);
});
