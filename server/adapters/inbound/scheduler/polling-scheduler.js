// Adaptador de entrada temporizado: igual que la API HTTP dispara casos de uso cuando
// llega una petición, éste los dispara según el reloj: la lectura de cada fuente según su
// intervalo, la detección de alertas y la recarga de los catálogos estáticos.
const FIRST_RETRY_MS = 30_000;
const MIN_RETRY_CAP_MS = 10 * 60_000;
const DETECT_DEBOUNCE_MS = 1500;
const DETECT_HEARTBEAT_MS = 30_000; // las alertas dependen del tiempo transcurrido, no sólo de datos nuevos
const CATALOG_REFRESH_MS = 6 * 3600_000; // estaciones y trazados cambian pocas veces al día

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
 * @param {{ feeds: Array<{ id: string, interval: number }>,
 *           ingestSource: (id: string) => Promise<boolean>,
 *           detectAlerts: () => unknown, refreshCatalogs?: () => Promise<unknown>,
 *           log: import('../../../application/ports.js').LoggerPort }} deps
 *   feeds: qué fuentes leer y cada cuánto (ms). El planificador sólo conoce su id: leerlas es
 *   cosa del caso de uso ingestSource.
 */
export function startPolling({ feeds, ingestSource, detectAlerts, refreshCatalogs, log }) {
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

  const loop = async (feed, failures = 0) => {
    if (stopped) return;
    // Pase lo que pase en la lectura, se programa la siguiente: si un fallo inesperado (al avisar de
    // otro fallo, por ejemplo) escapara de aquí, la fuente dejaría de leerse hasta reiniciar.
    let ok = false;
    try {
      ok = await ingestSource(feed.id);
    } catch (err) {
      log.error(`[${feed.id}] ${err?.stack ?? err}`);
    }
    scheduleDetect();
    const nextFailures = ok ? 0 : failures + 1;
    if (!stopped) timers.set(feed.id, setTimeout(() => loop(feed, nextFailures), nextDelay(feed.interval, nextFailures)));
  };

  // Arranque escalonado para no lanzar todas las peticiones a la vez.
  feeds.forEach((f, i) => timers.set(f.id, setTimeout(() => loop(f), i * 250)));
  const heartbeat = setInterval(scheduleDetect, DETECT_HEARTBEAT_MS);
  // La primera carga de los catálogos la hace el arranque; aquí, las siguientes.
  const catalogs = refreshCatalogs && setInterval(() => {
    Promise.resolve().then(refreshCatalogs).catch((err) => log.warn(`[catálogos] ${err.message}`));
  }, CATALOG_REFRESH_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(catalogs);
      clearTimeout(pending);
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
