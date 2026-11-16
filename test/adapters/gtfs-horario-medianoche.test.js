// Un viaje que sale un día y llega al siguiente (horas de más de 24 h en su GTFS): la hora de su próxima parada lleva la
// fecha del día en que llega, no la del día en que salió (el Algeciras 23:00 → Barcelona 17:55 de ALSA salía con la de ayer).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

// 16:30 del lunes 16 de noviembre en Madrid (15:30 UTC): el viaje del domingo 15 va entre Tarragona y Barcelona.
const NOW = Date.parse('2026-11-16T15:30:00Z');
const zip = zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,ALSA\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,Al-Ba,3\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,0,0,0,0,0,0,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Algeciras,36.13,-5.44\nT,Tarragona,41.12,1.25\nB,Barcelona,41.39,2.18\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,23:00:00,23:00:00,A,1\nT1,40:20:00,40:20:00,T,2\nT1,41:55:00,41:55:00,B,3\n'),
});
const nap = { gtfs: async () => zip, updatedAt: async () => '2026-11-01T00:00:00' };

test('la próxima parada de un viaje de ayer que llega hoy, con la fecha de hoy', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap, http: {} }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles } = await source.fetch();
  assert.equal(vehicles.length, 1);
  const [v] = vehicles;
  assert.match(v.id, /:20261115$/, 'es el viaje del domingo');
  assert.equal(v.next, 'Barcelona');
  assert.equal(v.nextEta, '2026-11-16T17:55:00');
});
