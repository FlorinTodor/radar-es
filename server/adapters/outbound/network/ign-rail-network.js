// Vías de toda España, con metro, tranvía y funicular: la red ferroviaria de la Información Geográfica de
// Referencia de Redes de Transporte del IGN (IGR-RT), en su servicio WFS INSPIRE (tn-ra:RailwayLink).
// Sirve para rehacer por la vía los trazados que los operadores publican casi sólo con sus estaciones
// (o no publican): entre estación y estación, la recta se sale de la vía cientos de metros.
// Licencia: CC BY 4.0, «Obra derivada de IGR-RT <año> CC-BY 4.0 scne.es» (va en el mapa y en /legal).
// La red cambia pocas veces al año: se descarga una vez al mes por cuadrículas (unos 60.000 tramos y
// ~150 MB de GML, de uno en uno) y se guarda en disco ya reducida a coordenadas. Si la descarga falla
// se sigue con la copia guardada y, sin ella, sin red: los trazados se quedan como los publica cada operador.
import { M_PER_DEG_LAT, mPerDegLon } from '../../../domain/geo.js';
import { buildRailNetwork } from '../../../domain/rail-match.js';

export const IGN_WFS = 'https://servicios.idee.es/wfs-inspire/transportes';
// Fórmula de la licencia del IGN para una obra derivada, con el producto y el año de la tabla de productos
// del SCNE (scne.es/tablaProductos.php); la misma que cita la capa «Red ferroviaria» del mapa.
export const IGN_RAIL_CREDIT = 'Obra derivada de IGR-RT 2026 CC-BY 4.0 scne.es';
const CACHE_NAME = 'ign-red-ferroviaria.v1';
const MAX_AGE_MS = 30 * 24 * 3600_000;
// Península y Baleares, y Canarias (Ceuta y Melilla no tienen tren). Cuadrículas de medio grado: una
// con más tramos de los que caben en una respuesta se parte en cuatro.
const AREAS = [[-9.6, 35.8, 4.5, 44.0], [-18.3, 27.5, -13.3, 29.5]];
const TILE_DEG = 0.5;
const PAGE = 5000;
// El servicio corta a veces una respuesta a medias: cada cuadrícula se pide hasta TRIES veces.
const TRIES = 4;
// Menos tramos que esto es una descarga rota y no se guarda (hoy hay unos 60.000).
const MIN_LINKS = 30_000;
// Puntos de vía más juntos que esto sobran para pegar trazados (la red queda en la mitad de memoria).
const SIMPLIFY_M = 3;

/**
 * Tramos de una respuesta GML del WFS: su id y su línea [lon, lat] (el GML da «lat lon» en ETRS89, que
 * para esto es lo mismo que WGS84), redondeada a 5 decimales (~1 m).
 * @param {string} xml
 * @returns {{ links: Array<{ id: string, line: Array<[number, number]> }>, returned: number }}
 */
export function parseRailwayLinks(xml) {
  const links = [];
  for (const m of xml.matchAll(/<tn-ra:RailwayLink\b[^>]*gml:id="([^"]+)"[\s\S]*?<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)) {
    const v = m[2].trim().split(/\s+/).map(Number);
    const line = [];
    for (let i = 0; i + 1 < v.length; i += 2) {
      if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) line.push([Math.round(v[i + 1] * 1e5) / 1e5, Math.round(v[i] * 1e5) / 1e5]);
    }
    if (line.length > 1) links.push({ id: m[1], line });
  }
  const returned = Number(/numberReturned="(\d+)"/.exec(xml)?.[1] ?? links.length);
  return { links, returned };
}

/** Douglas-Peucker en metros (proyección local). */
function simplify(line, tolM) {
  if (line.length < 3) return line;
  const kx = mPerDegLon(line[0][1]);
  const xy = line.map(([lon, lat]) => [lon * kx, lat * M_PER_DEG_LAT]);
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const dx = xy[b][0] - ax;
    const dy = xy[b][1] - ay;
    const len = Math.hypot(dx, dy);
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = xy[i][0] - ax;
      const py = xy[i][1] - ay;
      const d = len ? Math.abs(dx * py - dy * px) / len : Math.hypot(px, py);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Cuadrículas de `deg` grados que cubren las zonas. */
function tiles(areas, deg) {
  const out = [];
  for (const [w, s, e, n] of areas) {
    for (let x = w; x < e; x += deg) for (let y = s; y < n; y += deg) out.push([x, y, Math.min(x + deg, e), Math.min(y + deg, n)]);
  }
  return out;
}

/** Tramos ([lon, lat, …] en arrays tipados) en dos arrays para guardarlos en disco, y de vuelta como líneas. */
const pack = (flat) => {
  const offsets = new Int32Array(flat.length + 1);
  let n = 0;
  flat.forEach((l, i) => { offsets[i] = n; n += l.length / 2; });
  offsets[flat.length] = n;
  const coords = new Float32Array(n * 2);
  flat.forEach((l, i) => coords.set(l, offsets[i] * 2));
  return { offsets, coords };
};
const unpack = ({ offsets, coords }) => {
  const lines = [];
  for (let i = 0; i + 1 < offsets.length; i++) {
    const l = [];
    for (let j = offsets[i]; j < offsets[i + 1]; j++) l.push([coords[j * 2], coords[j * 2 + 1]]);
    lines.push(l);
  }
  return lines;
};

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           log: import('../../../application/ports.js').LoggerPort, url?: string, areas?: number[][], tileDeg?: number,
 *           minLinks?: number, now?: () => number, retryMs?: number }} deps
 *   areas, tileDeg, minLinks, retryMs: sólo cambian en los tests.
 * @returns {import('../../../application/ports.js').RailNetworkPort}
 */
export function createIgnRailNetwork({ http, cache, log, url = IGN_WFS, areas = AREAS, tileDeg = TILE_DEG, minLinks = MIN_LINKS, now = Date.now, retryMs = 5000 }) {
  let network = null;
  let savedAt = null; // fecha de la copia con la que se preparó: la recarga periódica no la repite
  let pending = true; // hasta que acaba la primera carga, haya ido bien o no

  /** Todos los tramos, cuadrícula a cuadrícula y de uno en uno (sin prisa: es una vez al mes). */
  async function download() {
    const byId = new Map(); // un tramo que cruza dos cuadrículas llega en las dos
    const queue = tiles(areas, tileDeg);
    while (queue.length) {
      const [w, s, e, n] = queue.shift();
      const q = `${url}?service=WFS&version=2.0.0&request=GetFeature&typeNames=tn-ra:RailwayLink&count=${PAGE}`
        + `&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
      let xml = null;
      for (let i = 1; xml === null; i++) {
        try {
          xml = new TextDecoder().decode(await http.bytes(q, { timeout: 180_000, maxBytes: 64 * 1024 * 1024 }));
          if (!xml.includes('FeatureCollection')) throw new Error('el WFS del IGN no devuelve tramos');
        } catch (err) {
          xml = null;
          if (i >= TRIES) throw err;
          await new Promise((resolve) => setTimeout(resolve, retryMs * i));
        }
      }
      const { links, returned } = parseRailwayLinks(xml);
      if (returned >= PAGE) {
        // No caben: la cuadrícula se parte en cuatro y se pide otra vez.
        const mx = (w + e) / 2;
        const my = (s + n) / 2;
        queue.unshift([w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]);
        continue;
      }
      // Ya reducido y en un array tipado: decenas de miles de tramos como listas de pares ocuparían varias veces más.
      for (const l of links) if (!byId.has(l.id)) byId.set(l.id, Float32Array.from(simplify(l.line, SIMPLIFY_M).flat()));
    }
    if (byId.size < minLinks) throw new Error(`la red del IGN llega con ${byId.size} tramos`);
    return [...byId.values()];
  }

  return {
    async load() {
      try {
        return await loadOnce();
      } finally {
        pending = false;
      }
    },
    network: () => network,
    pending: () => pending,
    credit: IGN_RAIL_CREDIT,
  };

  /** La copia de disco si sigue vigente; si no, la descarga (o, si falla, la copia vieja). */
  async function loadOnce() {
    let saved = await cache.readValue(CACHE_NAME);
    if (!saved || now() - saved.at > MAX_AGE_MS) {
      try {
        const lines = await download();
        saved = { at: now(), ...pack(lines) };
        await cache.writeValue(CACHE_NAME, saved);
      } catch (err) {
        if (!saved) throw err;
        log.warn(`[vías del IGN] ${err.message}; uso la copia guardada`);
      }
    }
    if (network && saved.at === savedAt) return network.edges;
    const lines = unpack(saved);
    network = buildRailNetwork(lines);
    savedAt = saved.at;
    log.info(`[vías del IGN] ${lines.length} tramos: ${network.edges} piezas y ${network.nodes} nudos`
      + ` (${(network.bytes / 1048576).toFixed(1)} MB)`);
    return lines.length;
  }
}
