// Hilo de pruebas con el mismo protocolo que workers/cpu-worker.js y tareas que fallan a propósito.
import { parentPort, receiveMessageOnPort, threadId } from 'node:worker_threads';

parentPort.on('message', ({ id, task, args }) => {
  switch (task) {
    case 'echo': return parentPort.postMessage({ id, ok: true, result: { args, threadId } });
    case 'meet': {
      // Cita con el otro hilo en memoria compartida, sin reloj: ni tope de tiempo ni esperas que
      // dependan de lo rápida que sea la máquina. [0] cuenta los hilos que han llegado; [1] lo pone el
      // principal cuando ya ha enviado los dos encargos (la prueba sólo manda dos «meet»).
      const shared = new Int32Array(args[0]);
      Atomics.add(shared, 0, 1);
      Atomics.notify(shared, 0);
      Atomics.wait(shared, 1, 0); // el principal lo pone justo después de enviar: no hay que esperar más
      // Si el otro encargo ha venido a este mismo hilo (en serie), ya está en su cola y no llegaría
      // nunca mientras éste espera: se contesta a los dos que no se han encontrado.
      const other = receiveMessageOnPort(parentPort)?.message;
      if (other) {
        parentPort.postMessage({ id: other.id, ok: true, result: false });
        return parentPort.postMessage({ id, ok: true, result: false });
      }
      // Si no, lo tiene otro hilo, que llegará: se le espera sin tope.
      while (Atomics.load(shared, 0) < 2) Atomics.wait(shared, 0, 1);
      return parentPort.postMessage({ id, ok: true, result: true });
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
