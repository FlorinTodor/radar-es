// Estaciones de las redes que no son de Renfe (metros, tranvías, FGC, Euskotren…), a partir de los
// mismos GTFS del Punto de Acceso Nacional de los que salen sus trazados. Licencia del NAP («Powered
// by MITRAMS», dato actualizado, fecha de actualización) y la de cada operador, que se cita en la
// ficha de cada estación. Va aparte del catálogo de Renfe: las alertas y Rodalies buscan «la
// estación más cercana» y tiene que ser una de Renfe. Se refresca una vez al día.
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../http/file-cache.js';
import { distanceKm } from '../../../domain/geo.js';
import { createPacer, csvColumns, csvColumnsStreamed, csvRows, openGtfs, own } from '../gtfs/gtfs-reader.js';
import { modeOf } from '../gtfs/gtfs-modes.js';
import { DEFAULT_COLOR, NETWORKS, readableColor } from '../network/gtfs-network-catalog.js';
import { RETIRED_PHOTOS_VERSION, loadNetworkStationExtras } from './station-extras.js';

const REFRESH_MS = 24 * 3600_000;
// Si algo ha fallado al calcularlo (un GTFS, Wikidata, Commons), se vuelve a intentar a la hora y no
// al día siguiente: mientras, se usa lo que sí se ha conseguido.
const RETRY_MS = 3600_000;
const SAME_STATION_KM = 0.5; // andenes, sentidos y líneas con el mismo nombre a menos de esto: una estación

// id: prefijo de sus códigos («fgc:PC»). dataset: conjunto del NAP (su fecha de actualización).
// credit: lo que pide citar el operador, además del NAP. Metro de Madrid no está: su GTFS en el NAP
// caducó en mayo de 2026 y no hay versión nueva.
export const STATION_NETWORKS = [
  { id: 'mlm', ficheroId: 1427, dataset: 1226, credit: 'Powered by CRTM' },
  { id: 'tmb', ficheroId: 1328, dataset: 1127, credit: 'Fuente: TMB' },
  { id: 'trambaix', ficheroId: 1329, dataset: 1128, credit: 'Powered by TRAM Barcelona' },
  { id: 'trambesos', ficheroId: 1330, dataset: 1129, credit: 'Powered by TRAM Barcelona' },
  { id: 'fgc', ficheroId: 1571, dataset: 1373, credit: 'Ferrocarrils de la Generalitat de Catalunya (FGC)' },
  { id: 'metrovalencia', ficheroId: 1168, dataset: 967, credit: 'Ferrocarrils de la Generalitat Valenciana (FGV)' },
  { id: 'tramalacant', ficheroId: 1167, dataset: 966, credit: 'Ferrocarrils de la Generalitat Valenciana (FGV)' },
  { id: 'metrosevilla', ficheroId: 1583, dataset: 1385, credit: 'Metro de Sevilla' },
  { id: 'tranviasevilla', ficheroId: 1567, dataset: 1369, credit: 'TUSSAM' },
  { id: 'metromalaga', ficheroId: 1497, dataset: 1296, credit: 'Metro de Málaga' },
  { id: 'metrogranada', ficheroId: 1568, dataset: 1370, credit: 'Agencia de Obra Pública de la Junta de Andalucía' },
  { id: 'tranviazaragoza', ficheroId: 1687, dataset: 1394, credit: 'Tranvía de Zaragoza' },
  { id: 'tranviamurcia', ficheroId: 1569, dataset: 1371, credit: 'Tranvía de Murcia' },
  { id: 'metrobilbao', ficheroId: 1267, dataset: 1066, credit: 'Metro Bilbao' },
  { id: 'euskotren', ficheroId: 1263, dataset: 1062, credit: 'Euskotren' },
].map((n) => ({ ...n, name: NETWORKS.find(([id]) => id === n.ficheroId)?.[1] ?? n.credit }));

/** Código de una estación de estas redes: el prefijo de la red y el stop_id de su GTFS. */
export const NETWORK_CODE = /^[a-z]+:[\w.:-]{1,64}$/;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SMALL_WORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'a']);
/**
 * «PINAR DE CHAMARTIN» (Metro Ligero) → «Pinar de Chamartin»: sólo los que vienen enteros en
 * mayúsculas. Y sin espacios dobles («Terrassa  Estació del nord» de FGC).
 */
export const readable = (raw) => {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name === name.toUpperCase() && /\p{Lu}{3}/u.test(name)
    ? name.toLowerCase().replace(/(^|[\s(/'-])(\p{L}+)/gu, (m, p, w) => (p && SMALL_WORDS.has(w) ? m : p + w[0].toUpperCase() + w.slice(1)))
    : name;
};
/** wheelchair_boarding del GTFS: 1 accesible, 2 no accesible; vacío o 0, sin datos. */
const wheelchair = (v) => (v === '1' ? true : v === '2' ? false : null);

/**
 * Estaciones de una red a partir de su GTFS. Trabajo de CPU, con pausas para no bloquear el hilo.
 * - Sólo las que tienen algún tren, metro o tranvía en el horario: el GTFS de Sevilla trae también
 *   las paradas de TUSSAM y el de TMB las de sus autobuses.
 * - Una estación es una fila con location_type=1 o una parada suelta (sin estación padre). Las que
 *   se llaman igual y están a menos de 500 m (andenes, sentidos, líneas) son la misma: se queda la
 *   fila de estación o la de más líneas, con sus coordenadas tal cual las publica el operador.
 * @param {Uint8Array} zip
 * @param {{ id: string, name: string }} net
 */
export async function buildStations(zip, net) {
  const pace = createPacer();
  const files = await openGtfs(zip, ['stops.txt', 'routes.txt', 'trips.txt']);
  const routes = new Map();
  for (const r of csvRows(files['routes.txt'])) {
    const mode = modeOf(r.route_type);
    if (!mode) continue;
    const color = /^[0-9a-f]{6}$/i.test(r.route_color) ? readableColor(`#${r.route_color}`, mode) : DEFAULT_COLOR[mode]; // como en /api/lines
    routes.set(r.route_id, { line: r.route_short_name || r.route_long_name || r.route_id, color, mode });
  }
  const tripRoute = new Map();
  for (const t of csvRows(files['trips.txt'])) {
    if (pace.due()) await pace.pause();
    if (routes.has(t.route_id)) tripRoute.set(t.trip_id, t.route_id);
  }

  // Parada → rutas ferroviarias que paran en ella. stop_times es grande (TMB lleva sus autobuses):
  // se lee por trozos; si el ZIP no lo permite, entero.
  const stopRoutes = new Map();
  const note = (tripId, stopId) => {
    const route = tripRoute.get(tripId);
    if (!route) return;
    let set = stopRoutes.get(stopId);
    if (!set) stopRoutes.set(own(stopId), (set = new Set()));
    set.add(route);
  };
  try {
    for await (const [tripId, stopId] of csvColumnsStreamed(zip, 'stop_times.txt', ['trip_id', 'stop_id'])) note(tripId, stopId);
  } catch {
    const { 'stop_times.txt': bytes } = await openGtfs(zip, ['stop_times.txt']);
    for (const [tripId, stopId] of csvColumns(bytes, ['trip_id', 'stop_id'])) {
      if (pace.due()) await pace.pause();
      note(tripId, stopId);
    }
  }

  const stops = [...csvRows(files['stops.txt'])];
  const byId = new Map(stops.map((s) => [s.stop_id, s]));
  const parentOf = (s) => (s.parent_station && byId.has(s.parent_station) ? s.parent_station : s.stop_id);
  const served = new Map(); // estación (o parada suelta) → sus rutas y las de sus andenes
  for (const [stopId, set] of stopRoutes) {
    const s = byId.get(stopId);
    if (!s) continue;
    const top = parentOf(s);
    served.set(top, new Set([...(served.get(top) ?? []), ...set]));
  }
  const children = new Map();
  for (const s of stops) if (s.parent_station) children.set(s.parent_station, [...(children.get(s.parent_station) ?? []), s]);

  const candidates = stops.filter((s) => (s.location_type === '1' || (!s.location_type || s.location_type === '0') && parentOf(s) === s.stop_id)
    && served.has(s.stop_id) && Number.isFinite(+s.stop_lat) && Number.isFinite(+s.stop_lon) && (+s.stop_lat || +s.stop_lon));

  // Mismo nombre y cerca: la misma estación.
  const groups = [];
  for (const s of candidates) {
    const key = fold(s.stop_name);
    const g = groups.find((x) => x.key === key && distanceKm(+x.rows[0].stop_lat, +x.rows[0].stop_lon, +s.stop_lat, +s.stop_lon) < SAME_STATION_KM);
    if (g) g.rows.push(s);
    else groups.push({ key, rows: [s] });
  }

  // El código lleva el stop_id corto: «ES:Euskotren:StopPlace:1468:» → «1468» (si no se repite).
  const short = (id) => id.split(':').filter(Boolean).pop() ?? id;
  const mains = groups.map(({ rows }) => [...rows].sort((a, b) => Number(b.location_type === '1') - Number(a.location_type === '1')
    || served.get(b.stop_id).size - served.get(a.stop_id).size)[0]);
  const shortCount = new Map();
  for (const m of mains) shortCount.set(short(m.stop_id), (shortCount.get(short(m.stop_id)) ?? 0) + 1);

  return groups.map(({ rows }, i) => {
    const lines = new Map();
    for (const r of rows) for (const id of served.get(r.stop_id)) {
      const route = routes.get(id);
      if (!lines.has(route.line)) lines.set(route.line, route);
    }
    const main = mains[i];
    // Accesible: lo que diga la estación; si no dice nada, lo que digan todos sus andenes a la vez.
    const stated = rows.map((r) => wheelchair(r.wheelchair_boarding)).find((v) => v !== null) ?? null;
    const kids = rows.flatMap((r) => children.get(r.stop_id) ?? []).filter((c) => !c.location_type || c.location_type === '0') // andenes, no accesos
      .map((c) => wheelchair(c.wheelchair_boarding));
    const accessible = stated ?? (kids.length && kids.every((v) => v === kids[0]) ? kids[0] : null);
    const modes = [...lines.values()].map((l) => l.mode);
    return {
      code: `${net.id}:${shortCount.get(short(main.stop_id)) > 1 ? main.stop_id : short(main.stop_id)}`,
      name: readable(main.stop_name),
      network: net.name,
      networkId: net.id,
      mode: ['metro', 'tranvia', 'cercanias', 'otros'].find((m) => modes.includes(m)) ?? 'otros',
      place: null,
      province: null,
      lat: +main.stop_lat,
      lon: +main.stop_lon,
      accessible,
      lines: [...lines.values()].map(({ line, color, mode }) => ({ line, color, mode }))
        .sort((a, b) => a.line.localeCompare(b.line, 'es', { numeric: true })),
    };
  });
}

/**
 * Añade los datos de otras fuentes (station-extras.js). La accesibilidad del operador manda; la de
 * Wikidata sólo cubre las estaciones de las que el GTFS no dice nada. Cada dato lleva su fuente.
 */
export function withNetworkExtras(stations, extras) {
  return stations.map((s) => {
    const { accessible, ...more } = extras.get(s.code) ?? {};
    const fromWikidata = s.accessible === null && accessible !== undefined;
    return {
      ...s,
      accessible: fromWikidata ? accessible : s.accessible,
      accessibleSource: fromWikidata ? 'Wikidata' : s.accessible === null ? null : s.network,
      ...more,
    };
  });
}

/** Nombre del fichero de Commons de una foto ya elegida (su página «…/wiki/File:Nombre.jpg»). */
const commonsFile = (page) => decodeURIComponent(String(page ?? '').split('/wiki/File:')[1] ?? '').replace(/_/g, ' ');

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>,
 *           cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>, cacheDir: URL,
 *           log: import('../../../application/ports.js').LoggerPort,
 *           renfe?: import('../../../application/ports.js').StationCatalogPort }} deps
 *   renfe: el catálogo de Renfe, para no repetir sus fotos ni tomar sus estaciones de Wikidata.
 * @returns {import('../../../application/ports.js').StationCatalogPort}
 */
export function createNetworkStationCatalog({ nap, cache, cacheDir, log, renfe }) {
  const cacheFile = new URL('estaciones-redes-v1.json', cacheDir);
  // Versión de lo que se calcula: si cambia, se recalcula aunque la caché sea de hoy (como en Renfe,
  // la huella de las fotos retiradas va detrás).
  const CATALOG_VERSION = `1-${RETIRED_PHOTOS_VERSION}`;
  /** @type {Map<string, object>} */
  const stations = new Map();

  async function download(log) {
    const list = [];
    for (const net of STATION_NETWORKS) {
      try {
        const zip = await nap.gtfs(net.ficheroId, REFRESH_MS);
        const updated = await nap.updatedAt(net.dataset, net.ficheroId).catch(() => null);
        const source = { credit: `Powered by MITRAMS (Punto de Acceso Nacional) · ${net.credit}`, updated, dataset: net.dataset };
        for (const s of await buildStations(zip, net)) list.push({ ...s, source });
      } catch (err) {
        log.warn(`[estaciones de otras redes] ${net.name}: ${err.message}`);
      }
    }
    const renfeStations = renfe?.all() ?? [];
    const extras = await loadNetworkStationExtras({
      cache, log, maxAgeMs: REFRESH_MS, stations: list,
      renfeCodes: new Set(renfeStations.map((s) => s.code)),
      usedFiles: new Set(renfeStations.map((s) => commonsFile(s.photo?.page)).filter(Boolean)),
    });
    return withNetworkExtras(list, extras);
  }

  let version = null;
  let savedAt = 0;
  let refreshing = null;

  async function refresh() {
    try {
      // Cualquier aviso mientras se calcula quiere decir que falta algo (una red, fotos).
      let incomplete = false;
      const watched = { ...log, warn: (msg) => { incomplete = true; log.warn(msg); } };
      const list = await download(watched);
      if (!list.length) throw new Error('lista vacía');
      stations.clear();
      for (const s of list) stations.set(s.code, s);
      version = CATALOG_VERSION;
      savedAt = incomplete ? Date.now() - REFRESH_MS + RETRY_MS : Date.now();
      await mkdir(cacheDir, { recursive: true });
      await writeFileAtomic(cacheFile, JSON.stringify({ version, savedAt, stations: list }));
      log.info(`[estaciones de otras redes] ${stations.size} estaciones de ${STATION_NETWORKS.length} redes`);
    } catch (err) {
      log.warn(`[estaciones de otras redes] no se pudo calcular el catálogo (${err.message}); ${stations.size} en caché`);
    }
  }

  return {
    // Sólo espera a leer la copia guardada (milisegundos): recalcular son minutos (Wikidata, fotos de
    // Commons) y va siempre detrás. Así la primera lista de estaciones que se sirve ya las lleva; sin
    // copia (el primer despliegue), la pestaña sólo tiene las de Renfe hasta que termina.
    async load() {
      if (!stations.size) {
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'));
          for (const s of cached.stations) stations.set(s.code, s);
          ({ version = null, savedAt = 0 } = cached);
        } catch { /* todavía no hay caché */ }
      }
      if (version === CATALOG_VERSION && Date.now() - savedAt < REFRESH_MS) return stations.size;
      refreshing ??= refresh().finally(() => { refreshing = null; });
      return stations.size;
    },
    get: (code) => (code ? stations.get(code) : undefined),
    name: (code) => (code ? stations.get(code)?.name ?? null : null),
    nearest(lat, lon, maxKm = 50) {
      let best = null;
      let bestKm = Infinity;
      for (const s of stations.values()) {
        const km = distanceKm(lat, lon, s.lat, s.lon);
        if (km < bestKm && km <= maxKm) { bestKm = km; best = s; }
      }
      return best ? { station: best, km: bestKm } : null;
    },
    all: () => [...stations.values()],
  };
}
