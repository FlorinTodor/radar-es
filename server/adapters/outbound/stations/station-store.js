// Lo que comparten los dos catálogos de estaciones (el de Renfe y el de las otras redes): la copia
// guardada en disco con su versión y su fecha, la renovación en segundo plano y la estación más
// cercana. Cada catálogo pone lo suyo: cómo se descargan sus estaciones y qué dice el registro.
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../http/file-cache.js';
import { distanceKm } from '../../../domain/geo.js';

const KM_PER_DEGREE = 111.19; // de latitud, con el radio de la Tierra de domain/geo.js

/**
 * La estación más cercana a menos de `maxKm`, o null. Fuerza bruta con prefiltro por caja (unos miles
 * de estaciones, de sobra para unos cientos de trenes). La caja siempre contiene el círculo de `maxKm`:
 * los grados de longitud se miden en el paralelo más alejado del ecuador, así que el prefiltro sólo
 * ahorra cálculos y nunca cambia el resultado.
 * @template {{ lat: number, lon: number }} S
 * @param {Iterable<S>} stations
 * @returns {{ station: S, km: number } | null}
 */
export function nearestStation(stations, lat, lon, maxKm = 50) {
  const dLat = maxKm / KM_PER_DEGREE;
  const widest = Math.min(89, Math.abs(lat) + dLat);
  const dLon = dLat / Math.cos((widest * Math.PI) / 180);
  let best = null;
  let bestKm = Infinity;
  for (const s of stations) {
    if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLon) continue;
    const km = distanceKm(lat, lon, s.lat, s.lon);
    if (km < bestKm && km <= maxKm) { bestKm = km; best = s; }
  }
  return best ? { station: best, km: bestKm } : null;
}

/**
 * Estaciones de un catálogo con su copia en disco ({ version, savedAt, stations }).
 * - load(): la primera vez lee la copia (milisegundos). Si es de esta versión y de hace menos de
 *   `refreshMs`, ya está; si no, se rehace detrás y mientras tanto se usa la que haya, aunque sea de otra
 *   versión o de hace días. Con `waitIfEmpty`, si no hay ninguna se espera a la descarga.
 * - Si algo avisa mientras se rehace (log.warn: un GTFS, Wikidata, las fotos), la lista está
 *   incompleta: se usa lo conseguido y se vuelve a intentar a `retryMs`, no al cabo de `refreshMs`.
 * @param {{ cacheFile: URL, cacheDir: URL, version: string, refreshMs: number, retryMs: number,
 *           log: import('../../../application/ports.js').LoggerPort, now?: () => number,
 *           download: (log: import('../../../application/ports.js').LoggerPort) => Promise<Array<{ code: string }>>,
 *           saved: (count: number) => string, failed: (err: Error, count: number) => string,
 *           waitIfEmpty?: boolean }} options
 *   download: las estaciones, recién calculadas; recibe el registro que vigila los avisos.
 *   saved y failed: lo que se apunta en el registro al terminar, bien o mal.
 */
export function createStationStore({ cacheFile, cacheDir, version, refreshMs, retryMs, log, now = Date.now, download, saved, failed, waitIfEmpty = false }) {
  /** @type {Map<string, any>} */
  const stations = new Map();
  let savedVersion = null;
  let savedAt = 0;
  let refreshing = null;

  async function refresh() {
    try {
      let incomplete = false;
      const watched = { ...log, warn: (msg) => { incomplete = true; log.warn(msg); } };
      const list = await download(watched);
      if (!list.length) throw new Error('lista vacía');
      stations.clear();
      for (const s of list) stations.set(s.code, s);
      savedVersion = version;
      savedAt = incomplete ? now() - refreshMs + retryMs : now();
      await mkdir(cacheDir, { recursive: true });
      await writeFileAtomic(cacheFile, JSON.stringify({ version: savedVersion, savedAt, stations: list }));
      log.info(saved(stations.size));
    } catch (err) {
      log.warn(failed(err, stations.size));
    }
  }

  return {
    stations,
    async load() {
      if (!stations.size) {
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
          for (const s of cached.stations) stations.set(s.code, s);
          ({ version: savedVersion = null, savedAt = 0 } = cached);
        } catch { /* todavía no hay caché */ }
      }
      if (savedVersion === version && now() - savedAt < refreshMs) return stations.size;
      refreshing ??= refresh().finally(() => { refreshing = null; });
      if (waitIfEmpty && !stations.size) await refreshing;
      return stations.size;
    },
    nearest: (lat, lon, maxKm) => nearestStation(stations.values(), lat, lon, maxKm),
  };
}
