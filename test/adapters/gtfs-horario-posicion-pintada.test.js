// Lo que le queda y el recorrido de un vehículo estimado, desde la posición que pinta la web (la de la lista que tiene):
// cada minuto, al recalcularse el horario, la lista y lo que le queda salían de lecturas distintas durante unos segundos
// y la línea empezaba a más de 1 km del autobús.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

// A las 12:00 de Madrid el autobús va por la mitad entre A y B (de 11:55 a 12:05), sobre su trazado (recto, al este).
const NOW = Date.parse('2026-11-01T11:00:00Z');
const zip = zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,1,3\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\nL1,S,T1,SH\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.98\nC,Gamma,37.0,-5.96\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:55:00,11:55:00,A,1\nT1,12:05:00,12:05:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
  'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,37.0,-6.0,1\nSH,37.0,-5.995,2\nSH,37.0,-5.99,3\nSH,37.0,-5.985,4\nSH,37.0,-5.98,5\nSH,37.0,-5.97,6\nSH,37.0,-5.96,7\n'),
});
const nap = { gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' };

test('lo que le queda empieza y el recorrido acaba donde la web pinta el autobús, si está sobre su trazado y cerca', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap, http: {} }, { id: 'bus-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [v] } = await source.fetch();
  assert.ok(Math.abs(v.lon - -5.99) < 1e-6, `a mitad de camino (${v.lon})`);
  assert.deepEqual(source.ahead(v.id)[0], [-5.99, 37]);
  // La web aún tiene la lista de la lectura anterior: el autobús, 900 m más atrás.
  const shown = [-6.0 + 0.0001, 37.0];
  assert.deepEqual(source.ahead(v.id, shown)[0], [-5.9999, 37], 'lo que le queda, desde donde se ve');
  assert.deepEqual(source.path(v.id, shown).at(-1), [-5.9999, 37], 'el recorrido, hasta donde se ve');
  assert.deepEqual(source.ahead(v.id, [-5.99, 37.01])[0], [-5.99, 37], 'a 1 km del trazado: no es él, donde va ahora');
  assert.deepEqual(source.ahead(v.id, [-5.94, 37.0])[0], [-5.99, 37], 'más allá del final del viaje: donde va ahora');
  assert.deepEqual(source.ahead(v.id, null), source.ahead(v.id), 'sin posición, como siempre');
});
