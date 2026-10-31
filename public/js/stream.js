// Conexión SSE con el servidor. EventSource reconecta solo si se corta la red, pero si el servidor
// responde con un error (un 502 de Cloudflare mientras se reinicia en un despliegue, o un 429 por
// exceso de conexiones) la cierra para siempre: entonces se vuelve a abrir aquí, con esperas
// crecientes (5 s, 10 s, 20 s… hasta 1 min) y algo de azar para no volver todos a la vez.
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 60_000;

/**
 * @param {{ buses?: boolean }} [options]  buses: pedir también los autobuses (sólo si su capa está activa).
 * @returns {{ setBuses: (on: boolean) => void }}  Cambiar si se piden autobuses reabre la conexión.
 */
export function connect(handlers, { buses = false } = {}) {
  let retry = RETRY_FIRST_MS;
  let timer = null;
  let current = null;

  const open = () => {
    const es = new EventSource(buses ? '/api/stream?buses=1' : '/api/stream');
    current = es;
    const on = (name, fn) => es.addEventListener(name, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error(`[stream] ${name}`, err);
      }
    });
    on('snapshot', handlers.snapshot);
    on('source', handlers.source);
    on('health', handlers.health);
    on('alerts', handlers.alerts);
    es.addEventListener('open', () => {
      retry = RETRY_FIRST_MS;
      handlers.status?.('live');
    });
    es.addEventListener('error', () => {
      if (es !== current) return; // una conexión ya sustituida por setBuses
      if (es.readyState !== EventSource.CLOSED) return handlers.status?.('connecting'); // reconecta él solo
      handlers.status?.('error');
      clearTimeout(timer);
      timer = setTimeout(open, retry * (0.75 + Math.random() / 2));
      retry = Math.min(retry * 2, RETRY_MAX_MS);
    });
  };
  open();
  return {
    setBuses(on) {
      if (on === buses) return;
      buses = on;
      clearTimeout(timer);
      current?.close();
      open(); // el snapshot de la conexión nueva sustituye todo el estado
    },
  };
}
