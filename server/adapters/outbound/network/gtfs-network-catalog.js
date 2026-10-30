// Trazados de las redes de metro, tranvía y Cercanías a partir de los GTFS del NAP.
// Si el GTFS trae shapes.txt se usan; si no, la línea une sus estaciones en orden.
// El resultado se cachea en disco una semana: construirlo exige descargar ~40 MB.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { modeOf } from '../gtfs/gtfs-modes.js';

const MAX_AGE_MS = 7 * 24 * 3600_000;
const TOLERANCE_DEG = 0.00008; // ~8 m: suficiente para el mapa y reduce mucho el tamaño

// ficheroId del NAP → nombre de la red. Para encontrar más: API /Fichero/GetListByType/2.
export const NETWORKS = [
  [1130, 'Cercanías Renfe'], [1134, 'Metro de Madrid'], [1427, 'Metro Ligero y Tranvía de Madrid'],
  [1328, 'Metro de Barcelona (TMB)'], [1329, 'TRAM Baix'], [1330, 'TRAM Besòs'], [1571, 'FGC'],
  [1168, 'Metrovalencia'], [1167, "TRAM d'Alacant"], [1583, 'Metro de Sevilla'], [1567, 'Tranvía de Sevilla'],
  [1497, 'Metro de Málaga'], [1568, 'Metro de Granada'], [1687, 'Tranvía de Zaragoza'], [1569, 'Tranvía de Murcia'],
  [1690, 'Tranvía de Tenerife'], [1267, 'Metro Bilbao'], [1263, 'Euskotren'],
];

const DEFAULT_COLOR = { metro: '#8a7fd1', tranvia: '#4fb3a9', cercanias: '#c45a5a', otros: '#8b8b85' };

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

function buildNetwork(zip, network) {
  const files = openGtfs(zip, ['routes.txt', 'trips.txt', 'shapes.txt', 'stops.txt', 'stop_times.txt']);

  const routes = new Map();
  for (const r of csvRows(files['routes.txt'])) {
    const mode = modeOf(r.route_type);
    if (!mode) continue;
    const color = /^[0-9a-f]{6}$/i.test(r.route_color) ? `#${r.route_color}` : DEFAULT_COLOR[mode];
    routes.set(r.route_id, { mode, color, name: r.route_short_name || r.route_long_name || r.route_id });
  }

  const trips = new Map(); // trip_id → { route, shape, key }
  for (const t of csvRows(files['trips.txt'])) {
    if (routes.has(t.route_id)) trips.set(t.trip_id, { route: t.route_id, shape: t.shape_id || null, key: `${t.route_id}|${t.direction_id || 0}` });
  }

  const paths = []; // { route, coords }
  const wantedShapes = new Set([...trips.values()].map((t) => t.shape).filter(Boolean));

  if (files['shapes.txt'] && wantedShapes.size) {
    const shapes = new Map();
    for (const s of csvRows(files['shapes.txt'])) {
      if (!wantedShapes.has(s.shape_id)) continue;
      if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
      shapes.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lon, +s.shape_pt_lat]);
    }
    const shapeRoute = new Map([...trips.values()].filter((t) => t.shape).map((t) => [t.shape, t.route]));
    for (const [id, pts] of shapes) {
      pts.sort((a, b) => a[0] - b[0]);
      paths.push({ route: shapeRoute.get(id), coords: pts.map(([, lon, lat]) => [lon, lat]) });
    }
  } else if (files['stop_times.txt']) {
    // Sin trazados: por cada ruta y sentido, el viaje con más paradas, uniendo estaciones.
    const counts = new Map();
    for (const st of csvRows(files['stop_times.txt'])) if (trips.has(st.trip_id)) counts.set(st.trip_id, (counts.get(st.trip_id) ?? 0) + 1);
    const best = new Map();
    for (const [tripId, n] of counts) {
      const { key } = trips.get(tripId);
      if (!best.has(key) || n > best.get(key).n) best.set(key, { tripId, n });
    }
    const chosen = new Set([...best.values()].map((b) => b.tripId));
    const stops = new Map();
    for (const s of csvRows(files['stops.txt'])) stops.set(s.stop_id, [+s.stop_lon, +s.stop_lat]);
    const seqs = new Map();
    for (const st of csvRows(files['stop_times.txt'])) {
      if (!chosen.has(st.trip_id)) continue;
      if (!seqs.has(st.trip_id)) seqs.set(st.trip_id, []);
      seqs.get(st.trip_id).push([+st.stop_sequence, st.stop_id]);
    }
    for (const [tripId, seq] of seqs) {
      seq.sort((a, b) => a[0] - b[0]);
      const coords = seq.map(([, id]) => stops.get(id)).filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
      paths.push({ route: trips.get(tripId).route, coords });
    }
  }

  const seen = new Set();
  const features = [];
  for (const { route, coords } of paths) {
    const r = routes.get(route);
    const clean = coords.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat));
    if (!r || clean.length < 2) continue;
    const line = simplify(clean, TOLERANCE_DEG).map(round);
    const sig = `${route}:${line.length}:${line[0]}:${line.at(-1)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: line },
      properties: { network, line: r.name, color: r.color, mode: r.mode },
    });
  }
  return features;
}

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>, cacheDir: URL,
 *           log: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').NetworkCatalogPort}
 */
export function createGtfsNetworkCatalog({ nap, cacheDir, log }) {
  const cacheFile = new URL('network-lines.json', cacheDir);
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
          const built = buildNetwork(await nap.gtfs(ficheroId, MAX_AGE_MS), name);
          features.push(...built);
        } catch (err) {
          log.warn(`[líneas] ${name}: ${err.message}`);
        }
      }
      if (features.length) {
        collection = { type: 'FeatureCollection', features };
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cacheFile, JSON.stringify(collection));
        log.info(`[líneas] ${features.length} trazados de ${NETWORKS.length} redes`);
      }
      return features.length;
    },
    lines: () => collection,
  };
}
