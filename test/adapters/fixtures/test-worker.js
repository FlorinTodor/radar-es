// Hilo de pruebas con el mismo protocolo que workers/cpu-worker.js y tareas que fallan a propósito.
import { parentPort, threadId } from 'node:worker_threads';

parentPort.on('message', ({ id, task, args }) => {
  switch (task) {
    case 'echo': return parentPort.postMessage({ id, ok: true, result: { args, threadId } });
    case 'meet': {
      // Cita con el otro hilo en memoria compartida: sólo llegan los dos si trabajan a la vez (en
      // serie, el primero esperaría al segundo para siempre: se rinde a los 30 s). No depende de lo
      // rápida que sea la máquina.
      const shared = new Int32Array(args[0]);
      Atomics.add(shared, 0, 1);
      Atomics.notify(shared, 0);
      const end = Date.now() + 30_000;
      while (Atomics.load(shared, 0) < 2 && Date.now() < end) Atomics.wait(shared, 0, 1, 100);
      return parentPort.postMessage({ id, ok: true, result: Atomics.load(shared, 0) >= 2 });
    }
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
