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
// El servicio corta a veces una respuesta a medias y, cuando va cargado, no da abasto con las zonas con
// muchas vías (Madrid, Barcelona…): tras un minuto responde 502. Una cuadrícula que falla se pide en
// cuatro más pequeñas, que responde antes; las más pequeñas (1/8 de la normal) se piden hasta TRIES
// veces. Si fallan GIVE_UP peticiones seguidas, el servicio no está y se deja para la próxima vez.
const TRIES = 4;
const GIVE_UP = 8;
// Menos tramos que esto es una descarga rota y no se guarda (hoy hay unos 60.000).
const MIN_LINKS = 30_000;
// Puntos de vía más juntos que esto sobran para pegar trazados (la red queda en la mitad de memoria).
const SIMPLIFY_M = 3;

// Una respuesta con muchas vías trae cientos de miles de coordenadas: se leen de una en una, sin crear un
// texto y un par [lon, lat] por coordenada, y cada tramo se reduce nada más leerlo.
let numbers = new Float64Array(4096); // las coordenadas del tramo que se está leyendo, reutilizado

/**
 * Lee los números separados por espacios de `s` (sin crear un texto por número) y los deja en `numbers`.
 * @returns {number} cuántos
 */
function readNumbers(s) {
  let n = 0;
  for (let i = 0; i < s.length;) {
    let c = s.charCodeAt(i);
    if (c <= 32) { i++; continue; }
    const start = i;
    const neg = c === 45; // «-»
    if (neg) i++;
    let v = 0;
    let scale = 1;
    let dot = false;
    let digits = 0;
    for (; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); digits++; if (dot) scale *= 10; } else if (c === 46 && !dot) dot = true; else break;
    }
    if (n === numbers.length) { const bigger = new Float64Array(n * 2); bigger.set(numbers); numbers = bigger; }
    if ((i < s.length && s.charCodeAt(i) > 32) || digits === 0 || digits > 15) {
      // Algo que no es «-123.456» (un exponente, demasiadas cifras…): como lo lea Number.
      while (i < s.length && s.charCodeAt(i) > 32) i++;
      numbers[n++] = Number(s.slice(start, i));
    } else numbers[n++] = (neg ? -v : v) / scale; // entero exacto entre potencia de 10 exacta: lo mismo que Number
  }
  return n;
}

/**
 * Recorre los tramos de una respuesta GML del WFS: su id y su línea como [lon, lat, lon, lat…] (el GML da
 * «lat lon» en ETRS89, que para esto es lo mismo que WGS84), redondeada a 5 decimales (~1 m). La línea se
 * reutiliza en el siguiente tramo: hay que copiarla si se quiere guardar.
 * @param {string} xml
 * @param {(id: string, line: Float64Array, points: number) => void} onLink
 * @returns {number} cuántos tramos dice la respuesta que trae (numberReturned)
 */
export function readRailwayLinks(xml, onLink) {
  let line = new Float64Array(4096);
  let found = 0;
  for (const m of xml.matchAll(/<tn-ra:RailwayLink\b[^>]*gml:id="([^"]+)"[\s\S]*?<gml:posList[^>]*>([^<]+)<\/gml:posList>/g)) {
    found++;
    const n = readNumbers(m[2]);
    if (line.length < n) line = new Float64Array(numbers.length);
    let points = 0;
    for (let i = 0; i + 1 < n; i += 2) {
      const lat = numbers[i];
      const lon = numbers[i + 1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      line[points * 2] = Math.round(lon * 1e5) / 1e5;
      line[points * 2 + 1] = Math.round(lat * 1e5) / 1e5;
      points++;
    }
    if (points > 1) onLink(m[1], line, points);
  }
  return Number(/numberReturned="(\d+)"/.exec(xml)?.[1] ?? found);
}

/** Douglas-Peucker en metros (proyección local) sobre [lon, lat, …]: los puntos que se quedan, en Float32Array. */
function simplify(line, points, tolM) {
  if (points < 3) return Float32Array.from(line.subarray(0, points * 2));
  const kx = mPerDegLon(line[1]);
  const keep = new Uint8Array(points);
  keep[0] = 1;
  keep[points - 1] = 1;
  let kept = 2;
  const stack = [0, points - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = line[a * 2] * kx;
    const ay = line[a * 2 + 1] * M_PER_DEG_LAT;
    const dx = line[b * 2] * kx - ax;
    const dy = line[b * 2 + 1] * M_PER_DEG_LAT - ay;
    const len = Math.hypot(dx, dy);
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = line[i * 2] * kx - ax;
      const py = line[i * 2 + 1] * M_PER_DEG_LAT - ay;
      const d = len ? Math.abs(dx * py - dy * px) / len : Math.hypot(px, py);
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tolM) {
      keep[at] = 1;
      kept++;
      stack.push(a, at, at, b);
    }
  }
  const out = new Float32Array(kept * 2);
  for (let i = 0, j = 0; i < points; i++) if (keep[i]) { out[j++] = line[i * 2]; out[j++] = line[i * 2 + 1]; }
  return out;
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
    const queue = tiles(areas, tileDeg).map((bbox) => ({ bbox, tries: 0 }));
    const minDeg = tileDeg / 8;
    const quarters = ([w, s, e, n]) => {
      const mx = (w + e) / 2;
      const my = (s + n) / 2;
      return [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]].map((bbox) => ({ bbox, tries: 0 }));
    };
    let failedInARow = 0;
    while (queue.length) {
      const tile = queue.shift();
      const [w, s, e, n] = tile.bbox;
      const q = `${url}?service=WFS&version=2.0.0&request=GetFeature&typeNames=tn-ra:RailwayLink&count=${PAGE}`
        + `&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
      let xml;
      try {
        xml = new TextDecoder().decode(await http.bytes(q, { timeout: 180_000, maxBytes: 64 * 1024 * 1024 }));
        if (!xml.includes('FeatureCollection')) throw new Error('el WFS del IGN no devuelve tramos');
      } catch (err) {
        failedInARow++;
        tile.tries++;
        if (failedInARow >= GIVE_UP || (e - w <= minDeg && tile.tries >= TRIES)) throw err;
        await new Promise((resolve) => setTimeout(resolve, retryMs * failedInARow));
        // En cuatro más pequeñas o, si ya es de las más pequeñas, otra vez la misma.
        queue.unshift(...(e - w > minDeg ? quarters(tile.bbox) : [tile]));
        continue;
      }
      failedInARow = 0;
      const tileLinks = [];
      const returned = readRailwayLinks(xml, (id, line, points) => {
        if (!byId.has(id)) tileLinks.push([id, simplify(line, points, SIMPLIFY_M)]);
      });
      if (returned >= PAGE) {
        // No caben: la cuadrícula se parte en cuatro y se pide otra vez.
        queue.unshift(...quarters(tile.bbox));
        continue;
      }
      // Ya reducidos y en arrays tipados: decenas de miles de tramos como listas de pares ocuparían varias veces más.
      // El id, como copia propia: un trozo de un texto largo sigue apuntando al texto entero (así lo guarda V8),
      // y los 60.000 ids tenían en memoria todas las respuestas de la descarga (~160 MB) hasta el final.
      for (const [id, line] of tileLinks) if (!byId.has(id)) byId.set(Buffer.from(id).toString(), line);
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
