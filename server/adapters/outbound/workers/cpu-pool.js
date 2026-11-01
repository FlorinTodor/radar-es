// Hilos para el trabajo de CPU de los adaptadores de salida (leer horarios GTFS, construir trazados,
// analizar el XML de la DGT). Es infraestructura: los adaptadores reciben el pool por inyección (lo
// crea main.js) y el dominio y los casos de uso no saben que existe. El estado sigue en un solo
// proceso y las fuentes se consultan una sola vez: los hilos sólo calculan y devuelven el resultado.
//
// Si no hay hilos (0, o no se pueden crear) o uno se cae a mitad de un trabajo (memoria, error
// interno), el trabajo se hace en el hilo principal, como antes. Tras varias caídas se deja de usar
// hilos y todo sigue en el principal.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';

import { TASKS } from './tasks.js';

const WORKER_URL = new URL('./cpu-worker.js', import.meta.url);
const taskOf = (name) => (Object.hasOwn(TASKS, name) ? TASKS[name] : null);
const runInline = async (task, args) => {
  if (!taskOf(task)) throw new Error(`Tarea desconocida: ${task}`);
  return taskOf(task).run(...args);
};

/**
 * CPU que puede usar el proceso: los núcleos visibles, limitados por la cuota del contenedor
 * (cgroup v2 cpu.max, lo que pone `cpus:` en compose.yaml). Node sólo ve los núcleos de la máquina:
 * en el VPS diría 4 aunque el contenedor sólo pueda usar 2.
 * @param {{ cores?: number, cpuMax?: string|null }} [probe]  Para los tests.
 */
export function effectiveCpus({ cores = availableParallelism(), cpuMax = readCpuMax() } = {}) {
  const [quota, period] = (cpuMax ?? '').trim().split(/\s+/);
  const limit = quota && quota !== 'max' && +period > 0 ? Math.ceil(+quota / +period) : Infinity;
  return Math.max(1, Math.min(cores, limit));
}

function readCpuMax() {
  try {
    return readFileSync('/sys/fs/cgroup/cpu.max', 'utf8');
  } catch {
    return null;
  }
}

/**
 * Hilos de cálculo por defecto: uno por CPU disponible (con 2 CPU, 2 hilos). El hilo principal casi
 * no usa CPU mientras se cargan los horarios (espera a la red y atiende peticiones), así que no hace
 * falta reservarle un núcleo. Con 1 CPU no compensa: todo en el principal.
 */
export function defaultThreads(cpus = effectiveCpus()) {
  return cpus >= 2 ? Math.min(cpus, 4) : 0;
}

/**
 * WORKER_THREADS de .env: número de hilos (0 = ninguno). Vacío o no válido = ninguno, de momento:
 * con 2 hilos el pico de memoria al cargar los horarios subió de ~350 a ~530 MB en el contenedor (y a
 * 850 MB con glibc), y aún falta medir el peor caso (arranque en frío y cambio de día) con el límite
 * de 1 GB. Para activarlos: WORKER_THREADS=2 (o el valor de defaultThreads()) y vigilar la memoria.
 */
export function parseThreads(value, fallback = 0) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 16) : fallback;
}

/**
 * @typedef {object} CpuPool
 * @property {() => number} threads  Hilos en marcha (0: todo en el hilo principal).
 * @property {(task: string, args: any[]) => Promise<any>} run  Ejecuta una tarea de tasks.js en un hilo
 *   (el menos ocupado) o, si no hay, en el principal. Los argumentos se copian, así que si el hilo se
 *   cae se puede repetir en el principal con los mismos.
 * @property {<T>(fn: () => Promise<T>) => Promise<T>} queue  Turno para un trabajo pesado: como mucho
 *   uno por hilo a la vez (uno si no hay hilos), para no juntar en memoria muchos ZIP descomprimidos.
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ threads?: number, log?: import('../../../application/ports.js').LoggerPort, heapMb?: number,
 *           maxRestarts?: number, workerUrl?: URL, inline?: (task: string, args: any[]) => Promise<any> }} [options]
 *   heapMb: techo de memoria de cada hilo (montón de V8); si lo pasa, el hilo se cae y el trabajo se
 *   repite en el principal. maxRestarts: hilos que se vuelven a crear tras una caída antes de dejarlos.
 *   workerUrl e inline, para los tests.
 * @returns {CpuPool}
 */
export function createCpuPool({ threads = 0, log, heapMb = 256, maxRestarts = 3, workerUrl = WORKER_URL, inline = runInline } = {}) {
  /** @type {Array<{ worker: Worker, jobs: Map<number, { task: string, args: any[], resolve: Function, reject: Function }> }>} */
  const slots = [];
  let restarts = 0;
  let nextId = 1;
  let closed = false;
  let disabled = threads <= 0;

  function giveUp(reason) {
    if (disabled) return;
    disabled = true;
    log?.warn(`[hilos] ${reason}: sigo con todo en el hilo principal`);
  }

  function spawn() {
    let worker;
    try {
      worker = new Worker(workerUrl, { resourceLimits: { maxOldGenerationSizeMb: heapMb } });
    } catch (err) {
      giveUp(`no se puede crear un hilo (${err.message})`);
      return;
    }
    const slot = { worker, jobs: new Map() };
    slots.push(slot);
    worker.unref(); // sin trabajos, un hilo no mantiene vivo el proceso
    worker.on('message', ({ id, ok, result, error }) => {
      const job = slot.jobs.get(id);
      if (!job) return;
      slot.jobs.delete(id);
      if (!slot.jobs.size) worker.unref();
      if (ok) {
        try {
          const unpack = taskOf(job.task)?.unpack;
          job.resolve(unpack ? unpack(result) : result);
        } catch (err) {
          job.reject(err);
        }
      } else job.reject(Object.assign(new Error(error?.message ?? 'Error en el hilo'), { name: error?.name ?? 'Error' }));
    });
    let failure = null;
    worker.on('error', (err) => { failure = err; });
    worker.on('exit', (code) => {
      slots.splice(slots.indexOf(slot), 1);
      const pending = [...slot.jobs.values()];
      slot.jobs.clear();
      if (closed) {
        for (const job of pending) job.reject(new Error('Pool de hilos cerrado'));
        return;
      }
      const why = failure?.message ?? `código ${code}`;
      log?.warn(`[hilos] un hilo se ha caído (${why})${pending.length ? `: repito ${pending.length} trabajo(s) en el hilo principal` : ''}`);
      // El trabajo que lo tumbó se repite en el principal: en el peor caso, como antes de los hilos.
      for (const job of pending) inline(job.task, job.args).then(job.resolve, job.reject);
      if (restarts < maxRestarts) {
        restarts++;
        spawn();
      } else {
        giveUp(`${restarts + 1} caídas de hilos`);
      }
    });
  }

  for (let i = 0; i < threads; i++) spawn();

  const alive = () => (disabled || closed ? 0 : slots.length);

  function run(task, args) {
    if (!alive()) return inline(task, args);
    const slot = slots.reduce((best, s) => (s.jobs.size < best.jobs.size ? s : best));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      slot.jobs.set(id, { task, args, resolve, reject });
      slot.worker.ref();
      try {
        slot.worker.postMessage({ id, task, args });
      } catch (err) {
        // Argumentos que no se pueden copiar a otro hilo: se hace aquí.
        slot.jobs.delete(id);
        if (!slot.jobs.size) slot.worker.unref();
        inline(task, args).then(resolve, reject);
      }
    });
  }

  // Turnos para los trabajos pesados: tantos a la vez como hilos vivos (o uno).
  let running = 0;
  const waiting = [];
  function pump() {
    while (waiting.length && running < Math.max(1, alive())) {
      const { fn, resolve, reject } = waiting.shift();
      running++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          running--;
          pump();
        });
    }
  }
  const queue = (fn) => new Promise((resolve, reject) => {
    waiting.push({ fn, resolve, reject });
    pump();
  });

  return {
    threads: alive,
    run,
    queue,
    async close() {
      closed = true;
      await Promise.all(slots.map((s) => s.worker.terminate()));
    },
  };
}
