// Cola de los mensajes del bot con los límites de Telegram: como mucho uno por segundo a cada chat y unos 25
// por segundo en total; si Telegram pide esperar (429 con retry_after), se espera. Acotada: si se llena (una
// huelga con miles de avisos a la vez), se tiran los más viejos y se cuenta. Sin temporizadores: quien la vacía
// le dice la hora (`now`), así se prueba sin esperas reales.

/**
 * @param {{ max?: number, perChatMs?: number, globalMs?: number, maxTries?: number }} [opts]
 *   perChatMs: entre dos mensajes al mismo chat; globalMs: entre dos mensajes cualesquiera (40 ms: 25 por segundo).
 */
export function createSendQueue({ max = 5000, perChatMs = 1000, globalMs = 40, maxTries = 3 } = {}) {
  let items = []; // { chatId, text, buttons, tries }, en orden de llegada
  const notBefore = new Map(); // chat → no antes de (epoch ms)
  let globalNotBefore = 0;
  let dropped = 0;

  return {
    /** @param {{ chatId: number, text: string, buttons?: object[] }} msg */
    push(msg) {
      items.push({ ...msg, tries: 0 });
      if (items.length > max) {
        dropped += items.length - max;
        items = items.slice(items.length - max);
      }
    },

    /** El primero que se puede mandar ya (respetando los dos límites), o null. Sale de la cola. */
    next(now) {
      if (now < globalNotBefore) return null;
      const i = items.findIndex((m) => (notBefore.get(m.chatId) ?? 0) <= now);
      if (i < 0) return null;
      const [m] = items.splice(i, 1);
      notBefore.set(m.chatId, now + perChatMs);
      globalNotBefore = now + globalMs;
      if (notBefore.size > 2 * max) for (const [chat, t] of notBefore) if (t <= now) notBefore.delete(chat);
      return m;
    },

    /**
     * Vuelve a la cola, el primero, para mandarlo pasados `afterMs` (a su chat). Tras `maxTries` intentos se
     * tira: devuelve false.
     */
    retry(m, now, afterMs) {
      if (++m.tries >= maxTries) return false;
      notBefore.set(m.chatId, now + afterMs);
      items.unshift(m);
      return true;
    },

    /** Telegram pide esperar a todo el bot. */
    pause(now, ms) {
      globalNotBefore = Math.max(globalNotBefore, now + ms);
    },

    /** Lo pendiente de un chat que ya no está. */
    forget(chatId) {
      items = items.filter((m) => m.chatId !== chatId);
      notBefore.delete(chatId);
    },

    size: () => items.length,

    /** Cuántos se han tirado por estar llena desde la última vez que se preguntó. */
    takeDropped() {
      const n = dropped;
      dropped = 0;
      return n;
    },
  };
}
