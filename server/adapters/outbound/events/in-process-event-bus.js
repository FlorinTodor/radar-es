// Bus de eventos en proceso. Para escalar a varios procesos se sustituye por uno
// basado en Redis pub/sub, NATS, etc., con el mismo puerto EventPublisher.
import { EventEmitter } from 'node:events';

/** @returns {import('../../../application/ports.js').EventPublisherPort} */
export function createInProcessEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0); // un listener por cliente SSE conectado
  return {
    publish: (topic, payload) => emitter.emit(topic, payload),
    subscribe(topic, handler) {
      emitter.on(topic, handler);
      return () => emitter.off(topic, handler);
    },
  };
}
