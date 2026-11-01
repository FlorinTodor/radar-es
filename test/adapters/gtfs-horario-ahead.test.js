// Posiciones según horario sin trazado (shapes.txt): un metro o tranvía va en línea recta entre
// paradas y lo que le queda se dibuja igual; un tren de larga distancia no (la recta se sale de la vía).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

// A las 12:00 de Madrid el vehículo va por la mitad entre A y B.
const NOW = Date.parse('2026-11-01T11:00:00Z');
const zip = zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,L1,1\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.99\nC,Gamma,37.01,-5.99\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:55:00,11:55:00,A,1\nT1,12:05:00,12:05:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
});
const nap = { gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' };

test('metro sin trazado: lo que le queda une sus paradas desde donde va', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap, http: {} }, { id: 'horario-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 1, dataset: 1 });
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.mode, 'metro');
  assert.equal(v.ahead, true);
  assert.deepEqual(source.ahead(v.id), [[-5.995, 37], [-5.99, 37], [-5.99, 37.01]]);
  assert.equal(source.path(v.id), undefined, 'su estela son sus posiciones, que ya van en recta');
});

test('tren de larga distancia sin trazado: no se dibuja lo que le queda ni lo dice la ficha', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap, http: {} }, { id: 'ouigo-prueba', name: 'Prueba', operator: 'Ouigo', ficheroId: 1, dataset: 1, mode: 'av' });
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.mode, 'av');
  assert.equal(v.ahead, undefined);
  assert.equal(source.ahead(v.id), undefined);
});
