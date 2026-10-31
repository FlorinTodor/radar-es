// Hilo de cálculo: recibe { id, task, args }, ejecuta la tarea de tasks.js y devuelve el resultado,
// transfiriendo (sin copiar) los arrays tipados grandes que la tarea indique.
import { parentPort } from 'node:worker_threads';
import { TASKS } from './tasks.js';

parentPort.on('message', async ({ id, task, args }) => {
  try {
    const t = TASKS[task];
    if (!t) throw new Error(`Tarea desconocida: ${task}`);
    const result = await t.run(...args);
    parentPort.postMessage({ id, ok: true, result }, t.transfer?.(result) ?? []);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { name: err?.name, message: err?.message ?? String(err) } });
  }
});
