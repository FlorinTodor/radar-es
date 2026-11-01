// Hilo de pruebas con el mismo protocolo que workers/cpu-worker.js y tareas que fallan a propósito.
import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', ({ id, task, args }) => {
  switch (task) {
    case 'echo': return parentPort.postMessage({ id, ok: true, result: { args, threadId } });
    case 'slow': return setTimeout(() => parentPort.postMessage({ id, ok: true, result: args[0] }), args[1]);
    case 'fail': return parentPort.postMessage({ id, ok: false, error: { name: 'TypeError', message: 'dato no válido' } });
    case 'crash': return process.exit(3); // en un hilo, sólo termina el hilo
    case 'uncaught': return setImmediate(() => { throw new Error('fallo interno'); });
    case 'typed': {
      const data = new Float32Array(args[0]).fill(1.5);
      return parentPort.postMessage({ id, ok: true, result: data }, [data.buffer]);
    }
    default: return parentPort.postMessage({ id, ok: false, error: { message: `Tarea desconocida: ${task}` } });
  }
});
