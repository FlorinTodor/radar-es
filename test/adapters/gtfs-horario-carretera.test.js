// Un autobús según horario cuyo operador no publica el trazado (ALSA): con las carreteras de CartoCiudad va por la
// carretera entre sus paradas en cuanto se saben todos sus tramos; mientras falte alguno, en la última parada, como antes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';

// A las 12:00 de Madrid el autobús va por la mitad entre A y B (de 11:55 a 12:05).
const NOW = Date.parse('2026-11-01T11:00:00Z');
const gtfs = zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,ALSA\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,715,3\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.98\nC,Gamma,37.01,-5.98\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:55:00,11:55:00,A,1\nT1,12:05:00,12:05:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
});
// Lo mismo, con Beta a 7 km de Alfa (para un tramo largo sin carretera).
const gtfsFiles = {
  'agency.txt': strToU8('agency_id,agency_name\nA,ALSA\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,715,3\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:55:00,11:55:00,A,1\nT1,12:05:00,12:05:00,B,2\nT1,12:15:00,12:15:00,C,3\n'),
};
const gtfsFar = zipSync({ ...gtfsFiles, 'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.92\nC,Gamma,37.01,-5.92\n') });
const napOf = (zip) => ({ gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' });
// La carretera de A a B da un rodeo de unos 600 m hacia el norte; de B a C, recta.
const ROAD_AB = Float32Array.from([-6.0, 37.0, -5.995, 37.004, -5.99, 37.0055, -5.985, 37.004, -5.98, 37.0]);
const ROAD_BC = Float32Array.from([-5.98, 37.0, -5.98, 37.01]);

/** Carreteras de prueba: sólo las que se le den con `give`; las demás, pendientes (y apuntadas como pedidas). */
function fakeRoads() {
  const known = new Map();
  const asked = new Set();
  let version = 0;
  const key = (a, b) => `${a}>${b}`;
  return {
    segment(a, b) {
      if (known.has(key(a, b))) return known.get(key(a, b));
      asked.add(key(a, b));
      return undefined;
    },
    version: () => version,
    give(a, b, road) {
      known.set(key(a, b), road);
      version++;
    },
    hurry(points) { return this.missing(points); },
    missing(points) {
      let n = 0;
      for (let i = 0; i + 1 < points.length; i++) if (!known.has(key(points[i], points[i + 1]))) n++;
      return n;
    },
    asked,
  };
}

test('sin todos sus tramos, en la última parada; con ellos, por la carretera, y lo que le queda también', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const roads = fakeRoads();
  const source = createGtfsScheduleSource({ nap: napOf(gtfs), http: {}, roads }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  let { vehicles: [v] } = await source.fetch();
  assert.deepEqual([v.lon, v.lat], [-6.0, 37.0], 'mientras faltan tramos, en su última parada');
  assert.equal(v.atLastStop, true);
  assert.equal(v.byRoad, undefined);
  assert.equal(roads.asked.size, 2, 'pide los dos tramos de su viaje');

  roads.give([-6.0, 37.0], [-5.98, 37.0], ROAD_AB);
  ({ vehicles: [v] } = await source.fetch());
  assert.equal(v.atLastStop, true, 'con un tramo aún pendiente, sigue igual');

  roads.give([-5.98, 37.0], [-5.98, 37.01], ROAD_BC);
  ({ vehicles: [v] } = await source.fetch());
  assert.equal(v.atLastStop, false);
  assert.equal(v.byRoad, true);
  assert.ok(v.lat > 37.003, `a mitad de camino va por el rodeo, no por la recta (${v.lat})`);
  assert.equal(v.ahead, true);
  const ahead = source.ahead(v.id);
  assert.deepEqual(ahead.at(-1), [-5.98, 37.01], 'lo que le queda llega a su última parada');
  assert.ok(source.path(v.id).length > 1, 'y lo recorrido, también por la carretera');
});

test('un tramo sin carretera (CartoCiudad no la encuentra) va en recta si es corto; si es largo, sin carretera', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const roads = fakeRoads();
  roads.give([-6.0, 37.0], [-5.98, 37.0], ROAD_AB);
  roads.give([-5.98, 37.0], [-5.98, 37.01], null); // 1,1 km: en recta
  const source = createGtfsScheduleSource({ nap: napOf(gtfs), http: {}, roads }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.byRoad, true);

  // 1,8 km sin carretera (CartoCiudad da un rodeo imposible): en recta ese tramo, y el resto por su carretera.
  const near = fakeRoads();
  near.give([-6.0, 37.0], [-5.98, 37.0], null);
  near.give([-5.98, 37.0], [-5.98, 37.01], ROAD_BC);
  const mid = createGtfsScheduleSource({ nap: napOf(gtfs), http: {}, roads: near }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [u] } = await mid.fetch();
  assert.equal(u.byRoad, true);
  assert.ok(Math.abs(u.lat - 37.0) < 1e-6 && Math.abs(u.lon - -5.99) < 1e-4, `a mitad de la recta (${u.lat}, ${u.lon})`);

  // 7 km sin carretera: en recta cruzaría el campo; el viaje se queda sin carretera.
  const far = fakeRoads();
  far.give([-6.0, 37.0], [-5.92, 37.0], null);
  far.give([-5.92, 37.0], [-5.92, 37.01], Float32Array.from([-5.92, 37.0, -5.92, 37.01]));
  const other = createGtfsScheduleSource({ nap: napOf(gtfsFar), http: {}, roads: far }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [w] } = await other.fetch();
  assert.equal(w.atLastStop, true);
  assert.equal(w.byRoad, undefined);
});

test('una ruta que vuelve por la misma calle: cada parada, en su sitio del viaje (no en la otra pasada)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  // De Alfa a Beta (1,8 km al este), y de Beta da la vuelta 450 m más allá y vuelve por la misma calle, pasando otra vez
  // por Beta, hasta Gamma. La copia de los tramos redondea a 5 decimales: el final del primer tramo queda a medio metro
  // de Beta, y la vuelta pasa justo por ella. Encajando las paradas en el trazado (stopsAlongShape), Beta caía en la
  // vuelta; en el L4 de Sarbus, la parada siguiente ya no se encontraba y el viaje entero se quedaba sin carretera.
  const loop = zipSync({
    ...gtfsFiles,
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.000004,-5.980004\nC,Gamma,37.0,-5.99\n'),
  });
  const roads = fakeRoads();
  roads.give([-6.0, 37.0], [-5.980004, 37.000004], Float32Array.from([-6.0, 37.0, -5.99, 37.0, -5.98, 37.0]));
  roads.give([-5.980004, 37.000004], [-5.99, 37.0], Float32Array.from([-5.98, 37.0, -5.975, 37.0, -5.980004, 37.000004, -5.99, 37.0]));
  const source = createGtfsScheduleSource({ nap: napOf(loop), http: {}, roads }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  // 12:00: a mitad de camino entre Alfa (11:55) y Beta (12:05), en la ida.
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.byRoad, true);
  assert.ok(Math.abs(v.lon - -5.99) < 0.0005, `a mitad de la ida, no más allá (${v.lon})`);
  assert.ok(Math.abs(v.heading - 90) < 10, `va hacia el este (${v.heading})`);
  assert.deepEqual(source.ahead(v.id).at(-1), [-5.99, 37.0], 'lo que le queda acaba en Gamma');
});

test('sin carreteras (ROAD_ROUTES=off), los autobuses sin trazado siguen como siempre', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: napOf(gtfs), http: {} }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [v] } = await source.fetch();
  assert.deepEqual([v.lon, v.lat], [-6.0, 37.0]);
});

test('mientras espera su carretera, el autobús lo dice (roadPending), y al abrir su ficha sus tramos pasan delante', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const roads = fakeRoads();
  const hurried = [];
  roads.hurry = (points) => { hurried.push(points.length); return points.length - 1; };
  const source = createGtfsScheduleSource({ nap: napOf(gtfs), http: {}, roads }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  const { vehicles: [v] } = await source.fetch();
  assert.equal(v.roadPending, true);
  assert.ok(Number.isFinite(v.heading), 'en su última parada, la flecha apunta a la próxima');
  assert.ok(Math.abs(v.heading - 90) < 5, `hacia el este, donde está B (${v.heading})`);
  source.tripStops(v.id);
  assert.deepEqual(hurried, [3], 'sus tres paradas');
});

test('si alguien mira un autobús que espera su carretera, la fuente pide leerse en cuanto llegan sus tramos', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const roads = fakeRoads();
  const source = createGtfsScheduleSource({ nap: napOf(gtfs), http: {}, roads }, { id: 'alsa-prueba', name: 'Prueba', operator: 'ALSA', ficheroId: 1, dataset: 1, mode: 'bus' });
  let { vehicles: [v] } = await source.fetch();
  assert.equal(v.roadPending, true);
  roads.give([-6.0, 37.0], [-5.98, 37.0], ROAD_AB);
  assert.equal(source.readSoon(), false, 'nadie lo mira: espera a su intervalo');
  source.tripStops(v.id); // alguien abre su ficha
  assert.equal(source.readSoon(), false, 'aún le falta un tramo');
  roads.give([-5.98, 37.0], [-5.98, 37.01], ROAD_BC);
  assert.equal(source.readSoon(), true, 'ya están todos: que se lea ya');
  ({ vehicles: [v] } = await source.fetch());
  assert.equal(v.byRoad, true);
  assert.equal(source.readSoon(), false, 'leída: ya no lo pide');
});
