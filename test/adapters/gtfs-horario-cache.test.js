// Horarios guardados en disco: tras un despliegue o un reinicio, el mismo día y con el mismo GTFS,
// se leen de ahí en vez de volver a calcularlos (en el servidor son minutos de CPU al arrancar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';
import { createCpuPool } from '../../server/adapters/outbound/workers/cpu-pool.js';

// A las 12:00 de Madrid el metro va entre Beta y Gamma, por su trazado.
const NOW = Date.parse('2026-11-01T11:00:00Z');
const gtfs = (lastStop = '12:15:00') => zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,L1,1\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\nL1,S,T1,SH\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20271231\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.99\nC,Gamma,37.01,-5.99\n'),
  'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,37.0,-6.0,1\nSH,37.0,-5.99,2\nSH,37.005,-5.991,3\nSH,37.01,-5.99,4\n'),
  'stop_times.txt': strToU8(`trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,11:50:00,11:50:00,A,1\nT1,11:55:00,11:55:00,B,2\nT1,${lastStop},${lastStop},C,3\n`),
});

async function setup(t) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = await mkdtemp(join(tmpdir(), 'horarios-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cache = createFileCache({ http: {}, dir: pathToFileURL(`${dir}/`), log: { warn() {} } });
  const inline = createCpuPool({ threads: 0 });
  const counter = { runs: 0 };
  const pool = { ...inline, run: (task, args) => { counter.runs++; return inline.run(task, args); } };
  let zip = gtfs();
  const nap = { gtfs: async () => zip, updatedAt: async () => '2026-10-31T00:00:00' };
  const make = () => createGtfsScheduleSource({ nap, http: {}, cache, pool }, { id: 'horario-prueba', name: 'Prueba', operator: 'Operador', ficheroId: 7, dataset: 1 });
  return { make, counter, setZip: (z) => { zip = z; } };
}

test('el horario guardado da los mismos vehículos, recorrido y lo que les queda, sin volver a leer el GTFS', async (t) => {
  const { make, counter } = await setup(t);
  const first = make();
  const a = await first.fetch();
  assert.equal(counter.runs, 1);
  const second = make(); // como tras un despliegue: otra instancia, la misma carpeta
  const b = await second.fetch();
  assert.equal(counter.runs, 1, 'se ha leído de disco');
  assert.equal(b.vehicles.length, 1);
  assert.deepEqual(b.vehicles, a.vehicles);
  const id = a.vehicles[0].id;
  assert.deepEqual(second.path(id), first.path(id));
  assert.deepEqual(second.ahead(id), first.ahead(id));
});

test('con otro GTFS o al cambiar de día, se vuelve a calcular', async (t) => {
  const { make, counter, setZip } = await setup(t);
  await make().fetch();
  setZip(gtfs('12:20:00'));
  await make().fetch();
  assert.equal(counter.runs, 2, 'el NAP ha publicado otro horario');
  t.mock.timers.tick(24 * 3600_000);
  await make().fetch();
  assert.equal(counter.runs, 3, 'otro día de servicio');
  await make().fetch();
  assert.equal(counter.runs, 3);
});
