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
/** Espera a que se cumpla una condición, como mucho 10 s: en el VPS los tests corren mientras la web
 * está en marcha y todo va más lento. Si se cumple antes, sigue al momento. */
async function until(condition) {
  const end = Date.now() + 10_000;
  while (!condition() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return condition();
}

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
  assert.equal(parseThreads(undefined), 0, 'sin WORKER_THREADS: sin hilos, hasta medir su memoria en el peor caso');
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
    // Primero se arrancan los dos hilos: en el VPS, construyendo la imagen con la web en marcha,
    // arrancar un hilo puede tardar más de 250 ms y no debe contar como trabajo en serie.
    const [e1, e2] = await Promise.all([pool.run('echo', [1]), pool.run('echo', [2])]);
    assert.notEqual(e1.threadId, e2.threadId, 'cada trabajo va a un hilo distinto');
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
    // Espera a que se procese la segunda salida.
    assert.ok(await until(() => pool.threads() === 0), 'deja los hilos');
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
    'calendar_dates.txt': strToU8('service_id,date,exception_type\nW,20261102,2\nF,20261102,1\n'),
    'trips.txt': strToU8('route_id,service_id,trip_id,shape_id,trip_short_name\nR1,W,T1,SH,\nR1,F,T2,SH,Exprés\n'),
    'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:30,S1,1\nT1,08:05:00,08:05:00,S2,2\n'
      + 'T2,07:00:00,07:00:00,S2,1\nT2,07:06:00,07:06:00,S1,2\n'),
    'frequencies.txt': strToU8('trip_id,start_time,end_time,headway_secs\nT2,07:00:00,10:00:00,600\n'),
    'shapes.txt': strToU8('shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,40.4168,-3.7038,1\nSH,40.4200,-3.7050,2\n'),
  });
  const days = { today: { ymd: '20261102', weekday: 0 }, yesterday: { ymd: '20261101', weekday: 6 } };
  const local = await parseSchedule(gtfs, undefined, days, {});
  const pool = createCpuPool({ threads: 1 });
  try {
    const remote = await pool.run('schedule', [gtfs, undefined, days, {}]);
    assert.deepEqual(remote, local);
    assert.equal(remote.trips.length, 1); // T1 no circula el lunes 2 (excepción), T2 sí
    assert.equal(remote.trips[0].label, 'Exprés');
    assert.deepEqual(remote.trips[0].freqs, [{ start: 25200, end: 36000, headway: 600 }]);
    // Sólo queda el calendario de los servicios de los viajes que se guardan.
    assert.equal(remote.exceptions.get('F').get('20261102'), 1);
    assert.ok(!remote.calendar.has('W') && !remote.exceptions.has('W'));
    assert.equal(remote.stopList[1].name, 'Gran Vía, 1');
    assert.ok(remote.shapes[0].coords instanceof Float32Array);
    const tuesday = await pool.run('schedule', [gtfs, undefined, { today: { ymd: '20261103', weekday: 1 }, yesterday: { ymd: '20261102', weekday: 0 } }, {}]);
    assert.deepEqual(tuesday.calendar.get('W').days, [true, true, true, true, true, false, false]);
    assert.deepEqual(tuesday.trips.map((t) => t.id), ['T1']); // T2 sólo circula el lunes (excepción) y acaba antes de medianoche
  } finally {
    await pool.close();
  }
});
