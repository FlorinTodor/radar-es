// Viajes por frecuencia de un GTFS del NAP: una fila con headway_secs=1e-300 colgaba la lectura (el bucle de
// las repeticiones no terminaba) y una con 1 s daba miles de vehículos. Ahora esas filas no dan ninguno y cada
// viaje plantilla tiene un tope de repeticiones a la vez.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { MAX_TRIP_REPETITIONS } from '../../server/domain/schedule.js';

const NOW = Date.parse('2026-11-01T11:00:00Z'); // 12:00 en Madrid
// Un viaje plantilla de 48 h (de A a B) que circula todos los días, con las filas de frecuencia que se pasen.
const gtfs = (frequencies) => zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,L1,3\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.0\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,00:00:00,00:00:00,A,1\nT1,47:59:00,47:59:00,B,2\n'),
  'frequencies.txt': strToU8(`trip_id,start_time,end_time,headway_secs\n${frequencies.map((f) => `T1,00:00:00,48:00:00,${f}`).join('\n')}\n`),
});
const source = (zip) => createGtfsScheduleSource({ nap: { gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' }, http: {} },
  { id: 'frecuencias-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 1, dataset: 1, mode: 'bus' });

test('una fila con headway diminuto o de 1 s no da vehículos y la lectura termina', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { vehicles } = await source(gtfs(['1e-300', '1', '0.5'])).fetch();
  assert.equal(vehicles.length, 0);
});

test('cada minuto durante 48 h: como mucho el tope de repeticiones por viaje y día de servicio', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // Sin tope serían 721 de hoy y 2.161 de ayer (que sigue pasada la medianoche), y con dos filas, el doble.
  const { vehicles } = await source(gtfs(['60', '60'])).fetch();
  assert.equal(vehicles.length, 2 * MAX_TRIP_REPETITIONS);
});

test('una fila normal sigue dando sus repeticiones', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // Cada 6 h y el viaje dura 48 h: a las 12:00 circulan las de hoy de las 00:00, 06:00 y 12:00, y las de ayer
  // de las 00:00 a las 36:00 (las 12:00 de hoy).
  const { vehicles } = await source(gtfs(['21600'])).fetch();
  assert.equal(vehicles.length, 3 + 7);
});
