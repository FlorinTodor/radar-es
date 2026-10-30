// Catálogo de estaciones de Renfe (Cercanías + Larga/Media Distancia) a partir de los
// GeoJSON de sus visores públicos. Cubre el 100 % de los códigos que usan los feeds de
// posiciones. Se cachea en disco para arrancar sin red y se refresca una vez al día.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { distanceKm } from '../../../domain/geo.js';

const REFRESH_MS = 24 * 3600_000;

const SOURCES = [
  { url: 'https://tiempo-real.renfe.com/data/estaciones.geojson', code: 'CODIGO_ESTACION', name: 'NOMBRE_ESTACION', place: 'NOMBRE_NUCLEO', cercanias: true },
  { url: 'https://tiempo-real.largorecorrido.renfe.com/data/estaciones.geojson', code: 'CODIGO', name: 'NOMBRE', place: 'LOCALIDAD', cercanias: false },
];

const padCode = (c) => String(c ?? '').padStart(5, '0');

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cacheDir: URL, log: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').StationCatalogPort}
 */
export function createRenfeStationCatalog({ http, cacheDir, log }) {
  const cacheFile = new URL('renfe-stations.json', cacheDir);
  /** @type {Map<string, import('../../../domain/model.js').Station & { cercanias: boolean, ld: boolean }>} */
  const stations = new Map();

  function ingest(list) {
    for (const s of list) {
      const prev = stations.get(s.code);
      // Si está en ambos catálogos conservamos el nombre del primero y unimos los flags.
      stations.set(s.code, prev ? { ...prev, ld: prev.ld || s.ld, cercanias: prev.cercanias || s.cercanias } : s);
    }
  }

  async function download() {
    const list = [];
    for (const src of SOURCES) {
      const geo = await http.json(src.url, { timeout: 30_000 });
      for (const f of geo.features ?? []) {
        const p = f.properties ?? {};
        const [lon, lat] = f.geometry?.coordinates ?? [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        list.push({ code: padCode(p[src.code]), name: p[src.name], place: p[src.place] ?? null, lat, lon, cercanias: src.cercanias, ld: !src.cercanias });
      }
    }
    return list;
  }

  return {
    async load() {
      let cached = null;
      try {
        cached = JSON.parse(await readFile(cacheFile, 'utf8'));
        ingest(cached.stations);
      } catch { /* todavía no hay caché */ }
      if (cached && Date.now() - cached.savedAt < REFRESH_MS) return stations.size;

      try {
        const list = await download();
        stations.clear();
        ingest(list);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify({ savedAt: Date.now(), stations: list }));
        log.info(`[estaciones] ${stations.size} estaciones de Renfe descargadas`);
      } catch (err) {
        log.warn(`[estaciones] no se pudo descargar el catálogo (${err.message}); ${stations.size} en caché`);
      }
      return stations.size;
    },

    get: (code) => (code ? stations.get(padCode(code)) : undefined),

    name(code) {
      if (!code) return null;
      return stations.get(padCode(code))?.name ?? `Estación ${code}`;
    },

    // Fuerza bruta con prefiltro por caja: ~1.500 estaciones, de sobra para unos cientos de trenes.
    nearest(lat, lon, maxKm = 50) {
      const dLat = maxKm / 111;
      let best = null;
      let bestKm = Infinity;
      for (const s of stations.values()) {
        if (Math.abs(s.lat - lat) > dLat || Math.abs(s.lon - lon) > dLat * 1.4) continue;
        const km = distanceKm(lat, lon, s.lat, s.lon);
        if (km < bestKm) { bestKm = km; best = s; }
      }
      return best ? { station: best, km: bestKm } : null;
    },

    all: () => [...stations.values()],
  };
}
