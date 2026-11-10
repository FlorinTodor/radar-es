// Adaptador de entrada temporizado: igual que la API HTTP dispara casos de uso cuando
// llega una petición, éste los dispara según el reloj: la lectura de cada fuente según su
// intervalo, la detección de alertas, la recarga de los catálogos estáticos, la copia del historial
// de posiciones y el registro del día en cifras.
const FIRST_RETRY_MS = 30_000;
const MIN_RETRY_CAP_MS = 10 * 60_000;
// Cada evaluación de alertas recorre todos los vehículos: tras una lectura se espera un poco por si
// llegan otras, y así se agrupan (con unas 50 fuentes, era una cada segundo y medio).
const DETECT_DEBOUNCE_MS = 5000;
const DETECT_HEARTBEAT_MS = 30_000; // las alertas dependen del tiempo transcurrido, no sólo de datos nuevos
// Cada hora: si están al día no cuesta nada, y lo que falló la vez anterior (una red de líneas, las
// fotos de las estaciones) se reintenta pronto. Cada catálogo decide cuándo renovarse entero.
const CATALOG_REFRESH_MS = 3600_000;
// La copia del historial de posiciones: lo que se pierde en un despliegue es, como mucho, esto.
const TRACKS_SAVE_MS = 60_000;
// El día en cifras suma lo que se ve una vez por minuto.
const DAY_RECORD_MS = 60_000;

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
 *           detectAlerts: () => unknown, refreshCatalogs?: () => Promise<unknown>, saveTracks?: () => Promise<unknown>,
 *           recordDay?: () => Promise<unknown>, log: import('../../../application/ports.js').LoggerPort }} deps
 *   feeds: qué fuentes leer y cada cuánto (ms). El planificador sólo conoce su id: leerlas es
 *   cosa del caso de uso ingestSource.
 *   saveTracks: guarda el historial de posiciones (caso de uso keep-tracks), cada minuto.
 *   recordDay: suma el minuto al día en cifras (caso de uso day-in-figures), cada minuto.
 */
export function startPolling({ feeds, ingestSource, detectAlerts, refreshCatalogs, saveTracks, recordDay, log }) {
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
  // Si una copia tarda más de un minuto (un disco lento), no se empieza otra encima.
  let saving = false;
  const tracksTimer = saveTracks && setInterval(() => {
    if (saving) return;
    saving = true;
    Promise.resolve().then(saveTracks).catch((err) => log.warn(`[estelas] ${err.message}`)).finally(() => { saving = false; });
  }, TRACKS_SAVE_MS);
  // Igual: si un minuto tarda más (leer el histórico, guardar el registro), no se empieza otro encima.
  let recording = false;
  const dayTimer = recordDay && setInterval(() => {
    if (recording) return;
    recording = true;
    Promise.resolve().then(recordDay).catch((err) => log.warn(`[día en cifras] ${err.message}`)).finally(() => { recording = false; });
  }, DAY_RECORD_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(catalogs);
      clearInterval(tracksTimer);
      clearInterval(dayTimer);
      clearTimeout(pending);
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
