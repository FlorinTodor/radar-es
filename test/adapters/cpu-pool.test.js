import { test } from 'node:test';
import assert from 'node:assert/strict';
import { threadId } from 'node:worker_threads';
import { zipSync, strToU8 } from 'fflate';
import { createCpuPool, defaultThreads, effectiveCpus, parseThreads } from '../../server/adapters/outbound/workers/cpu-pool.js';
import { parseSchedule } from '../../server/adapters/outbound/gtfs/gtfs-schedule.js';

const TEST_WORKER = new URL('./fixtures/test-worker.js', import.meta.url);
const quietLog = () => {
  const warnings = [];
  return { warnings, info() {}, error() {}, warn: (m) => warnings.push(m) };
};
// Lo que haría el hilo, pero aquí: para comprobar cuándo se usa la vía de reserva.
const inlineStub = () => {
  const calls = [];
  const inline = async (task, args) => {
    calls.push(task);
    if (task === 'fail') throw new TypeError('dato no válido');
    return { args, threadId, inline: true };
  };
  return { calls, inline };
};

test('CPU efectivas: la cuota del contenedor (cpu.max) manda sobre los núcleos visibles', () => {
  assert.equal(effectiveCpus({ cores: 16, cpuMax: '200000 100000\n' }), 2);
  assert.equal(effectiveCpus({ cores: 4, cpuMax: '150000 100000' }), 2); // 1,5 CPU → 2 hilos de ejecución
  assert.equal(effectiveCpus({ cores: 4, cpuMax: 'max 100000' }), 4);
  assert.equal(effectiveCpus({ cores: 8, cpuMax: null }), 8); // fuera de un contenedor
  assert.equal(effectiveCpus({ cores: 1, cpuMax: '400000 100000' }), 1);
});

test('hilos por defecto y WORKER_THREADS', () => {
  assert.equal(defaultThreads(1), 0); // con 1 CPU no compensa
  assert.equal(defaultThreads(2), 2);
  assert.equal(defaultThreads(16), 4);
  assert.equal(parseThreads(undefined, 2), 2);
  assert.equal(parseThreads('', 2), 2);
  assert.equal(parseThreads(' 0 ', 2), 0);
  assert.equal(parseThreads('3', 2), 3);
  assert.equal(parseThreads('-1', 2), 2);
  assert.equal(parseThreads('dos', 2), 2);
  assert.equal(parseThreads('1.5', 2), 2);
  assert.equal(parseThreads('99', 2), 16);
});

test('sin hilos todo se hace en el hilo principal', async () => {
  const { calls, inline } = inlineStub();
  const pool = createCpuPool({ threads: 0, inline });
  assert.equal(pool.threads(), 0);
  const r = await pool.run('echo', [1, 2]);
  assert.deepEqual(r.args, [1, 2]);
  assert.equal(r.threadId, threadId);
  assert.deepEqual(calls, ['echo']);
  await pool.close();
});

test('con hilos el trabajo va a otro hilo y los errores de la tarea llegan tal cual', async () => {
  const { calls, inline } = inlineStub();
  const pool = createCpuPool({ threads: 2, workerUrl: TEST_WORKER, inline });
  try {
    assert.equal(pool.threads(), 2);
    const r = await pool.run('echo', [{ a: 1 }, /re/g, new Map([['k', 1]])]);
    assert.notEqual(r.threadId, threadId);
    assert.deepEqual(r.args[0], { a: 1 });
    assert.ok(r.args[1] instanceof RegExp);
    assert.equal(r.args[2].get('k'), 1);
    // Un error de la propia tarea (un ZIP dañado…) no se repite en el principal: fallaría igual.
    await assert.rejects(pool.run('fail', []), { name: 'TypeError', message: 'dato no válido' });
    assert.deepEqual(calls, []);
  } finally {
    await pool.close();
  }
});

test('los dos hilos trabajan a la vez y el resultado llega con sus arrays tipados', async () => {
  const pool = createCpuPool({ threads: 2, workerUrl: TEST_WORKER });
  try {
    const t = performance.now();
    const [a, b] = await Promise.all([pool.run('slow', ['a', 300]), pool.run('slow', ['b', 300])]);
    assert.deepEqual([a, b], ['a', 'b']);
    assert.ok(performance.now() - t < 550, 'en paralelo, no uno detrás de otro');
    const data = await pool.run('typed', [1000]);
    assert.ok(data instanceof Float32Array);
    assert.equal(data.length, 1000);
    assert.equal(data[999], 1.5);
  } finally {
    await pool.close();
  }
});

test('si un hilo se cae, su trabajo se repite en el principal y se crea otro hilo', async () => {
  const { calls, inline } = inlineStub();
  const log = quietLog();
  const pool = createCpuPool({ threads: 1, workerUrl: TEST_WORKER, inline, log, maxRestarts: 3 });
  try {
    const r = await pool.run('crash', ['x']);
    assert.equal(r.inline, true);
    assert.deepEqual(calls, ['crash']);
    assert.match(log.warnings[0], /se ha caído/);
    // Un error sin capturar dentro del hilo, igual.
    assert.equal((await pool.run('uncaught', [])).inline, true);
    // Y el hilo nuevo sigue atendiendo.
    const ok = await pool.run('echo', [7]);
    assert.notEqual(ok.threadId, threadId);
    assert.equal(pool.threads(), 1);
  } finally {
    await pool.close();
  }
});

test('tras varias caídas deja los hilos y sigue en un solo hilo', async () => {
  const { inline } = inlineStub();
  const log = quietLog();
  const pool = createCpuPool({ threads: 1, workerUrl: TEST_WORKER, inline, log, maxRestarts: 1 });
  try {
    await pool.run('crash', []);
    await pool.run('crash', []);
    // Da tiempo a que se procese la segunda salida.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(pool.threads(), 0);
    assert.ok(log.warnings.some((w) => /sigo con todo en el hilo principal/.test(w)));
    assert.equal((await pool.run('echo', [1])).inline, true);
  } finally {
    await pool.close();
  }
});

test('si no se puede arrancar el hilo, se trabaja en el principal', async () => {
  const { inline } = inlineStub();
  const pool = createCpuPool({ threads: 1, workerUrl: new URL('./fixtures/no-existe.js', import.meta.url), inline, log: quietLog(), maxRestarts: 0 });
  try {
    assert.equal((await pool.run('echo', [1])).inline, true);
  } finally {
    await pool.close();
  }
});

test('los turnos limitan los trabajos pesados a uno por hilo (o uno sin hilos)', async () => {
  for (const threads of [0, 2]) {
    const pool = createCpuPool({ threads, workerUrl: TEST_WORKER });
    let running = 0;
    let max = 0;
    const job = () => pool.queue(async () => {
      max = Math.max(max, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    });
    await Promise.all(Array.from({ length: 6 }, job));
    assert.equal(max, Math.max(1, threads));
    await pool.close();
  }
});

test('un horario leído en un hilo es igual que leído en el principal', async () => {
  const gtfs = zipSync({
    'agency.txt': strToU8('agency_id,agency_name\nA,Metro\n'),
    'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nR1,A,L1,1\n'),
    'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nS1,SOL,40.4168,-3.7038\nS2,"Gran Vía, 1",40.4200,-3.7050\n'),
    'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,0,0,20260101,20261231\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\nR1,W,T1,SH\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:30,S1,1\nT1,08:05:00,08:05:00,S2,2\n'),
    'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,40.4168,-3.7038,1\nSH,40.4200,-3.7050,2\n'),
  });
  const days = { today: { ymd: '20261102', weekday: 0 }, yesterday: { ymd: '20261101', weekday: 6 } };
  const local = await parseSchedule(gtfs, undefined, days, {});
  const pool = createCpuPool({ threads: 1 });
  try {
    const remote = await pool.run('schedule', [gtfs, undefined, days, {}]);
    assert.deepEqual(remote, local);
    assert.equal(remote.trips.length, 1);
    assert.deepEqual([...remote.times], [1, 0, 28800, 28830, 2, 1, 29100, 29100]);
    assert.equal(remote.stopList[1].name, 'Gran Vía, 1');
    assert.ok(remote.shapes[0].coords instanceof Float32Array);
  } finally {
    await pool.close();
  }
});
