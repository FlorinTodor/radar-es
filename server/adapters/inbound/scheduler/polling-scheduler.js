// Adaptador de entrada temporizado: igual que la API HTTP dispara casos de uso cuando
// llega una petición, éste los dispara según el intervalo de cada fuente.
const MAX_BACKOFF = 8;
const DETECT_DEBOUNCE_MS = 1500;
const DETECT_HEARTBEAT_MS = 30_000; // las alertas dependen del tiempo transcurrido, no sólo de datos nuevos

/**
 * @param {{ sources: import('../../../application/ports.js').DataSourcePort[],
 *           ingestSource: (s: import('../../../application/ports.js').DataSourcePort) => Promise<boolean>,
 *           detectAlerts: () => unknown, log: import('../../../application/ports.js').LoggerPort }} deps
 */
export function startPolling({ sources, ingestSource, detectAlerts, log }) {
  const timers = new Map();
  let pending = null;
  let stopped = false;

  const scheduleDetect = () => {
    if (pending || stopped) return;
    pending = setTimeout(() => {
      pending = null;
      try {
        detectAlerts();
      } catch (err) {
        log.error(`[alertas] ${err.stack ?? err.message}`);
      }
    }, DETECT_DEBOUNCE_MS);
  };

  const loop = async (source, failures = 0) => {
    if (stopped) return;
    const ok = await ingestSource(source);
    scheduleDetect();
    const nextFailures = ok ? 0 : failures + 1;
    // Backoff exponencial si la fuente falla, para no machacar un servidor caído.
    const delay = source.interval * Math.min(2 ** nextFailures, MAX_BACKOFF);
    if (!stopped) timers.set(source.id, setTimeout(() => loop(source, nextFailures), delay));
  };

  // Arranque escalonado para no lanzar todas las peticiones a la vez.
  sources.forEach((s, i) => timers.set(s.id, setTimeout(() => loop(s), i * 250)));
  const heartbeat = setInterval(scheduleDetect, DETECT_HEARTBEAT_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearTimeout(pending);
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
