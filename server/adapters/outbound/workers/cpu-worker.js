// Hilo de cálculo: recibe { id, task, args }, ejecuta la tarea de tasks.js y devuelve el resultado,
// empaquetado si la tarea lo pide y transfiriendo (sin copiar) sus arrays tipados.
import { parentPort } from 'node:worker_threads';
import { setPriority } from 'node:os';
import { TASKS } from './tasks.js';

// Prioridad baja (nice 10) para este hilo, que en Linux es por hilo y no por proceso: cuando los hilos
// de cálculo y el principal compiten por las 2 CPU del contenedor, el principal (el que atiende las
// peticiones) pasa antes. Bajar la prioridad no necesita permisos.
try {
  setPriority(10);
} catch { /* sistema sin prioridades: se sigue igual */ }

parentPort.on('message', async ({ id, task, args }) => {
  try {
    const t = Object.hasOwn(TASKS, task) ? TASKS[task] : null;
    if (!t) throw new Error(`Tarea desconocida: ${task}`);
    const result = await t.run(...args);
    const { value, transfer } = t.pack ? t.pack(result) : { value: result, transfer: [] };
    parentPort.postMessage({ id, ok: true, result: value }, transfer);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { name: err?.name, message: err?.message ?? String(err) } });
  }
});
