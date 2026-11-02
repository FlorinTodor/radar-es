// Trazados de las redes de metro, tranvía y Cercanías a partir de los GTFS del NAP.
// Si el GTFS trae shapes.txt se usan; si no, la línea une sus estaciones en orden.
// El resultado se cachea en disco un día: la licencia del NAP exige mostrar datos actualizados.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createPacer, csvColumns, csvRows, openGtfs, own } from '../gtfs/gtfs-reader.js';
import { modeOf } from '../gtfs/gtfs-modes.js';

const MAX_AGE_MS = 24 * 3600_000;
const TOLERANCE_DEG = 0.00008; // ~8 m: suficiente para el mapa y reduce mucho el tamaño

// ficheroId del NAP → nombre de la red. Para encontrar más: API /Fichero/GetListByType/2.
// Sin Metro de Madrid: su GTFS en el NAP caducó en mayo de 2026 y no hay versión nueva.
export const NETWORKS = [
  [1130, 'Cercanías Renfe'], [1427, 'Metro Ligero y Tranvía de Madrid'],
  [1328, 'Metro de Barcelona (TMB)'], [1329, 'TRAM Baix'], [1330, 'TRAM Besòs'], [1571, 'FGC'],
  [1168, 'Metrovalencia'], [1167, "TRAM d'Alacant"], [1583, 'Metro de Sevilla'], [1567, 'Tranvía de Sevilla'],
  [1497, 'Metro de Málaga'], [1568, 'Metro de Granada'], [1687, 'Tranvía de Zaragoza'], [1569, 'Tranvía de Murcia'],
  [1267, 'Metro Bilbao'], [1263, 'Euskotren'],
];

// El tranvía de Tenerife no sale del NAP (su GTFS allí caducó en julio de 2025), sino del trazado
// que Metropolitano de Tenerife publica en el portal de datos abiertos del Cabildo (CC BY).
const TENERIFE_LINES = 'https://datos.tenerife.es/ckan/dataset/64182a24-3418-42dd-94e7-d66cf92bc020/resource/2085c33e-b6c9-4565-bfdd-658f293b2dca/download/lineas-de-tranvia.geojson';

export const DEFAULT_COLOR = { metro: '#8a7fd1', tranvia: '#4fb3a9', cercanias: '#c45a5a', otros: '#8b8b85' };

/**
 * El color de cada línea es el que publica el operador, pero el mapa es oscuro: el gris del TG2 de
 * Vitoria (#737277) apenas se ve y el negro de la línea 41 no se ve nada. Los muy oscuros pasan al
 * color de su modo; los oscuros se aclaran mezclándolos con blanco hasta que se distinguen.
 */
export function readableColor(hex, mode) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (c) => c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  if (lum(rgb) < 0.02) return DEFAULT_COLOR[mode] ?? DEFAULT_COLOR.otros;
  let c = rgb;
  for (let k = 0; k < 10 && lum(c) < 0.2; k++) c = c.map((v) => v + (1 - v) * 0.15);
  return `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** Douglas-Peucker sobre [lon, lat] en grados. */
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = points[a];
    const [x2, y2] = points[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let maxD = 0;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * points[i][0] - dx * points[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

const round = ([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];

/** Trazados de una red a partir de su GTFS. Trabajo de CPU puro: se puede hacer en un hilo de cálculo. */
export async function buildNetwork(zip, network) {
  const pace = createPacer();
  // stop_times.txt sólo hace falta si no hay trazados, y es enorme (290 MB en Cercanías): primero lo demás.
  const files = await openGtfs(zip, ['routes.txt', 'trips.txt', 'shapes.txt']);

  const routes = new Map();
  for (const r of csvRows(files['routes.txt'])) {
    const mode = modeOf(r.route_type);
    if (!mode) continue;
    const color = /^[0-9a-f]{6}$/i.test(r.route_color) ? readableColor(`#${r.route_color}`, mode) : DEFAULT_COLOR[mode];
    routes.set(r.route_id, { mode, color, name: r.route_short_name || r.route_long_name || r.route_id });
  }

  const trips = new Map(); // trip_id → { route, shape, key }
  for (const t of csvRows(files['trips.txt'])) {
    if (pace.due()) await pace.pause(); // 140.000 viajes en Cercanías: ~1 s sin ceder el hilo
    if (routes.has(t.route_id)) trips.set(t.trip_id, { route: t.route_id, shape: t.shape_id || null, key: `${t.route_id}|${t.direction_id || 0}` });
  }

  const paths = []; // { route, coords }
  const wantedShapes = new Set([...trips.values()].map((t) => t.shape).filter(Boolean));

  const fromShapes = Boolean(files['shapes.txt'] && wantedShapes.size);
  if (!fromShapes) Object.assign(files, await openGtfs(zip, ['stops.txt', 'stop_times.txt']));

  if (fromShapes) {
    const shapes = new Map();
    for (const [shapeId, seq, lon, lat] of csvColumns(files['shapes.txt'], ['shape_id', 'shape_pt_sequence', 'shape_pt_lon', 'shape_pt_lat'])) {
      if (pace.due()) await pace.pause();
      if (!wantedShapes.has(shapeId)) continue;
      if (!shapes.has(shapeId)) shapes.set(own(shapeId), []);
      shapes.get(shapeId).push([+seq, +lon, +lat]);
    }
    const shapeRoute = new Map([...trips.values()].filter((t) => t.shape).map((t) => [t.shape, t.route]));
    for (const [id, pts] of shapes) {
      pts.sort((a, b) => a[0] - b[0]);
      paths.push({ route: shapeRoute.get(id), coords: pts.map(([, lon, lat]) => [lon, lat]), shape: id });
    }
  } else if (files['stop_times.txt']) {
    // Sin trazados: por cada ruta y sentido, el viaje con más paradas, uniendo estaciones.
    const counts = new Map();
    for (const [tripId] of csvColumns(files['stop_times.txt'], ['trip_id'])) {
      if (pace.due()) await pace.pause();
      if (!trips.has(tripId)) continue;
      const n = counts.get(tripId);
      counts.set(n === undefined ? own(tripId) : tripId, (n ?? 0) + 1); // la clave guardada, copia propia
    }
    const best = new Map();
    for (const [tripId, n] of counts) {
      const { key } = trips.get(tripId);
      if (!best.has(key) || n > best.get(key).n) best.set(key, { tripId, n });
    }
    const chosen = new Set([...best.values()].map((b) => b.tripId));
    const stops = new Map();
    for (const s of csvRows(files['stops.txt'])) stops.set(s.stop_id, [+s.stop_lon, +s.stop_lat]);
    const seqs = new Map();
    for (const [tripId, seq, stopId] of csvColumns(files['stop_times.txt'], ['trip_id', 'stop_sequence', 'stop_id'])) {
      if (pace.due()) await pace.pause();
      if (!chosen.has(tripId)) continue;
      if (!seqs.has(tripId)) seqs.set(own(tripId), []);
      seqs.get(tripId).push([+seq, own(stopId)]);
    }
    for (const [tripId, seq] of seqs) {
      seq.sort((a, b) => a[0] - b[0]);
      const coords = seq.map(([, id]) => stops.get(id)).filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
      paths.push({ route: trips.get(tripId).route, coords });
    }
  }

  // Trazados iguales se pintan una sola vez; el elemento guarda los shape_id de todos ellos, para
  // que el mapa encuentre el del viaje de cada tren (su recorrido hasta el destino).
  const seen = new Map();
  const features = [];
  for (const { route, coords, shape } of paths) {
    const r = routes.get(route);
    const clean = coords.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat));
    if (!r || clean.length < 2) continue;
    const line = simplify(clean, TOLERANCE_DEG).map(round);
    const sig = `${route}:${line.length}:${line[0]}:${line.at(-1)}`;
    if (seen.has(sig)) {
      if (shape) (seen.get(sig).properties.shapes ??= []).push(shape);
      continue;
    }
    const feature = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { network, line: r.name, color: r.color, mode: r.mode, ...(shape ? { shapes: [shape] } : {}) },
    };
    seen.set(sig, feature);
    features.push(feature);
  }
  return features;
}

/** Líneas de tranvía de Tenerife (GeoJSON de LineString, una por sentido). */
function buildTenerife(bytes) {
  const seen = new Set();
  const features = [];
  for (const f of JSON.parse(new TextDecoder().decode(bytes)).features ?? []) {
    const line = f.properties?.linea_id;
    if (f.geometry?.type !== 'LineString' || !line || seen.has(line)) continue; // ida y vuelta coinciden
    seen.add(line);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: simplify(f.geometry.coordinates, TOLERANCE_DEG).map(round) },
      properties: { network: 'Tranvía de Tenerife', line, color: DEFAULT_COLOR.tranvia, mode: 'tranvia' },
    });
  }
  return features;
}

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>,
 *           cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>, cacheDir: URL,
 *           log: import('../../../application/ports.js').LoggerPort, pool?: import('../workers/cpu-pool.js').CpuPool }} deps
 *   pool: hilos de cálculo para leer los GTFS; sin él, en el hilo principal.
 * @returns {import('../../../application/ports.js').NetworkCatalogPort}
 */
export function createGtfsNetworkCatalog({ nap, cache, cacheDir, log, pool }) {
  // Nombre nuevo para no reutilizar una caché sin los shape_id de cada trazado ni los colores aclarados.
  const cacheFile = new URL('trazados-red-v3.json', cacheDir);
  let collection = { type: 'FeatureCollection', features: [] };

  return {
    async load() {
      try {
        if (Date.now() - (await stat(cacheFile)).mtimeMs < MAX_AGE_MS) {
          collection = JSON.parse(await readFile(cacheFile, 'utf8'));
          return collection.features.length;
        }
      } catch { /* sin caché */ }
      if (!nap.enabled) {
        log.warn('[líneas] sin NAP_API_KEY no se pueden descargar los trazados');
        return 0;
      }

      const features = [];
      for (const [ficheroId, name] of NETWORKS) {
        try {
          const zip = await nap.gtfs(ficheroId, MAX_AGE_MS);
          const built = pool ? await pool.run('network', [zip, name]) : await buildNetwork(zip, name);
          features.push(...built);
        } catch (err) {
          log.warn(`[líneas] ${name}: ${err.message}`);
        }
      }
      try {
        features.push(...buildTenerife(await cache.bytes(TENERIFE_LINES, 'tenerife-lineas-tranvia.geojson', MAX_AGE_MS)));
      } catch (err) {
        log.warn(`[líneas] Tranvía de Tenerife: ${err.message}`);
      }
      if (features.length) {
        collection = { type: 'FeatureCollection', features };
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(collection));
        log.info(`[líneas] ${features.length} trazados de ${NETWORKS.length + 1} redes`);
      }
      return features.length;
    },
    lines: () => collection,
  };
}
