// Adaptador de entrada temporizado: igual que la API HTTP dispara casos de uso cuando
// llega una petición, éste los dispara según el intervalo de cada fuente.
const FIRST_RETRY_MS = 30_000;
const MIN_RETRY_CAP_MS = 10 * 60_000;
const DETECT_DEBOUNCE_MS = 1500;
const DETECT_HEARTBEAT_MS = 30_000; // las alertas dependen del tiempo transcurrido, no sólo de datos nuevos

/**
 * Espera hasta la siguiente lectura. Si la fuente ha fallado, se reintenta pronto (30 s, 1, 2,
 * 4 min…) para que un fallo puntual no deje una capa vacía durante horas, pero sin pasar del
 * intervalo normal de la fuente (o de 10 min si es menor), para no machacar un servidor caído.
 */
export function nextDelay(interval, failures) {
  if (!failures) return interval;
  return Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), Math.max(interval, MIN_RETRY_CAP_MS));
}

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
    if (!stopped) timers.set(source.id, setTimeout(() => loop(source, nextFailures), nextDelay(source.interval, nextFailures)));
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
