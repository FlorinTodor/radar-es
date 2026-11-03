// Con la red de vías, un vehículo según horario va por la vía aunque su operador no publique trazado (o lo
// publique en recta entre estaciones): su posición, lo que ha recorrido y lo que le queda. Los autobuses no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { buildRailNetwork, nearestOnRail } from '../../server/domain/rail-match.js';

// A las 12:00 de Madrid el vehículo va por la mitad entre A y B.
const NOW = Date.parse('2026-11-01T11:00:00Z');
const gtfs = (routeType) => zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8(`route_id,agency_id,route_short_name,route_type\nL1,A,L1,${routeType}\n`),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.99\nC,Gamma,37.01,-5.99\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:55:00,11:55:00,A,1\nT1,12:05:00,12:05:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
});
const napOf = (zip) => ({ gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' });
// La vía de A a B baja en curva unos 300 m hacia el sur (la recta se sale); de B a C va recta.
const curve = Array.from({ length: 21 }, (_, i) => {
  const k = i / 20;
  return [-6.0 + 0.01 * k, 37.0 - 0.0108 * k * (1 - k)];
});
const net = buildRailNetwork([curve, [[-5.99, 37.0], [-5.99, 37.01]]]);
const railGeometry = { network: () => net };
const onRail = ([lon, lat], m = 15) => Boolean(nearestOnRail(net, lon, lat, m));

test('metro sin trazado: con la red de vías va por ella, y lo que le queda también', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: napOf(gtfs(1)), http: {}, railGeometry }, { id: 'horario-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 1, dataset: 1 });
  const { vehicles: [v] } = await source.fetch();
  assert.ok(onRail([v.lon, v.lat]), `el metro, en la vía (${v.lon}, ${v.lat})`);
  assert.ok(v.lat < 36.998, 'en la curva, no en la recta de A a B');
  const ahead = source.ahead(v.id);
  assert.ok(ahead.length > 3 && ahead.every((p) => onRail(p)), 'lo que le queda, por la vía');
  const path = source.path(v.id);
  assert.ok(path.length > 1 && path.every((p) => onRail(p)), 'lo recorrido, por la vía');
});

test('tren sin trazado: con la red de vías se dibuja por ella', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: napOf(gtfs(2)), http: {}, railGeometry }, { id: 'ouigo-prueba', name: 'Prueba', operator: 'Ouigo', ficheroId: 1, dataset: 1, mode: 'av' });
  const { vehicles: [v] } = await source.fetch();
  assert.ok(onRail([v.lon, v.lat]));
  assert.equal(v.ahead, true);
  assert.ok(source.ahead(v.id).every((p) => onRail(p)));
});

test('un autobús no se lleva a la vía', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: napOf(gtfs(3)), http: {}, railGeometry }, { id: 'bus-prueba', name: 'Prueba', operator: 'Bus', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [v] } = await source.fetch();
  assert.deepEqual([v.lon, v.lat], [-6.0, 37.0], 'sin trazado se queda en su última parada, como siempre');
});
