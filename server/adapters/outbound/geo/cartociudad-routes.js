// Carretera entre dos paradas de autobús, con el servicio de cálculo de rutas de CartoCiudad (IGN-CNIG): para los
// autobuses con posición estimada cuyo horario no trae el trazado de sus viajes (ALSA, AISA Ciudad Real y otros), que
// así van por la carretera entre parada y parada en vez de quedarse en la última por la que han pasado.
//
// Su política de uso (Servicios web de CartoCiudad, 04-08-2026): «se pueden usar de modo libre y gratuito para cualquier
// uso, sea comercial o no comercial. La única obligación indispensable es la de mencionar procedencia y autoría […]
// CC BY 4.0 SCNE». Aun así se le pide poco: un tramo cada vez, como mucho uno por segundo, sólo los de los viajes que
// circulan, y cada tramo una sola vez: se guardan en disco (sobreviven a reinicios y despliegues). Unos 27.000 tramos
// en toda España (medido el 16-11-2026), que tardan menos de un día en estar todos.
//
// Su cálculo no tiene en cuenta el sentido de las calles: en una ciudad, la ruta puede ir por una calle de sentido
// contrario. Es una aproximación, y la ficha del vehículo lo dice.
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { writeFileAtomic } from '../http/file-cache.js';
import { M_PER_DEG_LAT, mPerDegLon } from '../../../domain/geo.js';

const BASE = 'https://www.cartociudad.es/services/api/route';
const FILE = 'carreteras-cartociudad.v1.json.gz';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// Con el tope, por muchos viajes nuevos que lleguen no se juntan más tramos pendientes que estos.
const MAX_PENDING = 50_000;
// Un tramo que no tiene ruta (una parada en un puerto, o mal situada) se vuelve a pedir pasados unos días.
const RETRY_FAILED_MS = 7 * 24 * 3600_000;
// La ruta empieza y acaba en la carretera más cercana a cada parada: más lejos que esto no es la suya.
const MAX_END_OFF_M = 1000;
// Una ruta mucho más larga que la recta (una vuelta enorme por un puente o un error) no se usa.
const MAX_DETOUR = 4;
// Se simplifica: en una autovía bastan unos pocos puntos por kilómetro (así toda España ocupa pocos MB).
const SIMPLIFY_M = 15;
// Lo que alguien está mirando (la ficha de un autobús) pasa delante y va algo más rápido: como mucho unos 3 por segundo,
// y sólo los tramos de ese viaje (unas decenas). Así su carretera llega en menos de un minuto, no tras la cola del día.
const PRIORITY_GAP_DIVISOR = 3;
const MAX_PRIORITY = 500;
/**
 * Cada cuánto hay que llamar a pump (el planificador): lo justo para que la cola prioritaria vaya de verdad a 3 por
 * segundo. Llamándolo cada segundo, iba a 1 por segundo como la normal (sus tramos tardaban un minuto, no veinte segundos).
 */
export const PUMP_EVERY_MS = Math.ceil(1000 / PRIORITY_GAP_DIVISOR);
// Los temporizadores no son exactos: una vuelta que llega unos milisegundos antes de la separación mínima también vale
// (si no, la prioritaria saltaba una de cada dos y la normal esperaba una vuelta de más).
const TICK_SLACK_MS = 50;
// Tras un fallo del servicio (no responde, error), se espera antes de volver a pedir, cada vez más (hasta 30 min).
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const keyOf = ([lon1, lat1], [lon2, lat2]) => `${lon1.toFixed(5)},${lat1.toFixed(5)}>${lon2.toFixed(5)},${lat2.toFixed(5)}`;
const meters = ([lon1, lat1], [lon2, lat2]) => Math.hypot((lon2 - lon1) * mPerDegLon((lat1 + lat2) / 2), (lat2 - lat1) * M_PER_DEG_LAT);

/** Polilínea codificada (la de Google, con 5 decimales, la que devuelve CartoCiudad) → [lon, lat, lon, lat…]. */
export function decodePolyline(text) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      if (i >= text.length) throw new Error('polilínea cortada');
      b = text.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20 && shift < 35);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    out.push(lon / 1e5, lat / 1e5);
  }
  return out;
}

/** [lon, lat, lon, lat…] → polilínea codificada con 5 decimales (para guardarla en poco sitio). */
export function encodePolyline(lonLat) {
  let out = '';
  let pLat = 0;
  let pLon = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (let i = 0; i < lonLat.length; i += 2) {
    const lat = Math.round(lonLat[i + 1] * 1e5);
    const lon = Math.round(lonLat[i] * 1e5);
    put(lat - pLat);
    put(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

/** Douglas-Peucker en metros sobre [lon, lat…]: los puntos que se apartan menos de `tol` de la recta, fuera. */
export function simplify(lonLat, tol = SIMPLIFY_M) {
  const n = lonLat.length / 2;
  if (n <= 2) return lonLat;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const kx = mPerDegLon(lonLat[a * 2 + 1]);
    const ax = lonLat[a * 2] * kx;
    const ay = lonLat[a * 2 + 1] * M_PER_DEG_LAT;
    const dx = lonLat[b * 2] * kx - ax;
    const dy = lonLat[b * 2 + 1] * M_PER_DEG_LAT - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = lonLat[i * 2] * kx - ax;
      const py = lonLat[i * 2 + 1] * M_PER_DEG_LAT - ay;
      const u = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
      const d = Math.hypot(px - u * dx, py - u * dy);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tol) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(lonLat[i * 2], lonLat[i * 2 + 1]);
  return out;
}

/**
 * La ruta que devuelve CartoCiudad entre `from` y `to` ([lon, lat]), ya comprobada y simplificada; null si no hay una
 * que valga (no la encuentra, empieza o acaba lejos de las paradas, o da una vuelta enorme).
 */
export function routeFromResponse(body, from, to) {
  if (String(body?.found) !== 'true' || typeof body.geom !== 'string' || !body.geom) return null;
  let line;
  try {
    line = decodePolyline(body.geom);
  } catch {
    return null;
  }
  if (line.length < 4) return null;
  const first = [line[0], line[1]];
  const last = [line[line.length - 2], line[line.length - 1]];
  if (meters(first, from) > MAX_END_OFF_M || meters(last, to) > MAX_END_OFF_M) return null;
  let length = 0;
  for (let i = 2; i < line.length; i += 2) length += meters([line[i - 2], line[i - 1]], [line[i], line[i + 1]]);
  if (length > MAX_DETOUR * meters(from, to) + 3000) return null;
  // Desde la parada y hasta la parada: la ruta empieza y acaba en la carretera más cercana.
  return Float32Array.from([from[0], from[1], ...simplify(line), to[0], to[1]]);
}

/**
 * @typedef {object} RoadNetwork
 * @property {(from: number[], to: number[]) => Float32Array|null|undefined} segment  La carretera de una parada a otra
 *   ([lon, lat]): [lon, lat…]; null si no tiene (se sabe); undefined si aún no se sabe (se pide, y llega en unos minutos).
 * @property {() => number} version  Cambia cada vez que llega un tramo nuevo: lo que se calculó sin él se puede rehacer.
 * @property {(points: number[][]) => number} hurry  Los tramos que faltan entre estas paradas ([lon, lat], en orden) pasan
 *   delante (alguien está mirando ese autobús); devuelve cuántos faltan.
 * @property {(points: number[][]) => number} missing  Cuántos faltan, sin pedir nada.
 * @property {() => Promise<boolean>} pump  Pide el siguiente tramo pendiente, si toca (lo llama el planificador cada PUMP_EVERY_MS).
 * @property {() => Promise<void>} load
 * @property {() => Promise<void>} save  Si ha cambiado algo. Nunca rechaza.
 * @property {() => { known: number, failed: number, pending: number }} stats
 */

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, dir: URL, log: import('../../../application/ports.js').LoggerPort,
 *           now?: () => number, minGapMs?: number, base?: string }} deps
 *   dir: dónde se guardan (data/cache); minGapMs: lo mínimo entre una petición y la siguiente.
 * @returns {RoadNetwork}
 */
export function createCartoCiudadRoads({ http, dir, log, now = Date.now, minGapMs = 1000, base = BASE }) {
  const file = new URL(FILE, dir);
  const known = new Map(); // clave → Float32Array
  const failed = new Map(); // clave → cuándo se vio que no tiene ruta
  const pending = new Map(); // clave → [from, to], en el orden en que se piden
  const urgent = new Map(); // los mismos, de lo que alguien está mirando: van antes
  let version = 0;
  let dirty = false;
  let busy = false;
  let lastAt = -Infinity;
  let pausedUntil = -Infinity;
  let errors = 0;
  /** Ni se sabe su carretera ni se sabe (hace menos de una semana) que no la tiene. */
  const unknown = (key) => {
    if (known.has(key)) return false;
    const bad = failed.get(key);
    return bad === undefined || now() - bad >= RETRY_FAILED_MS;
  };

  return {
    segment(from, to) {
      const key = keyOf(from, to);
      const road = known.get(key);
      if (road) return road;
      const bad = failed.get(key);
      if (bad !== undefined && now() - bad < RETRY_FAILED_MS) return null;
      if (!pending.has(key) && pending.size < MAX_PENDING) pending.set(key, [from, to]);
      return undefined;
    },
    version: () => version,

    hurry(points) {
      let missing = 0;
      for (let i = 0; i + 1 < points.length; i++) {
        const key = keyOf(points[i], points[i + 1]);
        if (!unknown(key)) continue;
        missing++;
        if (!urgent.has(key) && urgent.size < MAX_PRIORITY) urgent.set(key, [points[i], points[i + 1]]);
      }
      return missing;
    },

    missing(points) {
      let missing = 0;
      for (let i = 0; i + 1 < points.length; i++) if (unknown(keyOf(points[i], points[i + 1]))) missing++;
      return missing;
    },

    async pump() {
      const queue = urgent.size ? urgent : pending;
      const gap = urgent.size ? minGapMs / PRIORITY_GAP_DIVISOR : minGapMs;
      if (busy || !queue.size || now() < pausedUntil || now() - lastAt < gap - TICK_SLACK_MS) return false;
      busy = true;
      const [key, [from, to]] = queue.entries().next().value;
      lastAt = now();
      try {
        const url = `${base}?orig=${from[1]},${from[0]}&dest=${to[1]},${to[0]}&locale=es&vehicle=CAR`;
        const road = routeFromResponse(await http.json(url, { timeout: 20_000, maxBytes: 4 * 1024 * 1024 }), from, to);
        pending.delete(key);
        urgent.delete(key);
        if (road) {
          known.set(key, road);
          failed.delete(key);
          version++;
        } else failed.set(key, now());
        dirty = true;
        errors = 0;
        return true;
      } catch (err) {
        // El servicio no responde: el tramo se queda (al final de su cola) y se espera antes del siguiente.
        queue.delete(key);
        queue.set(key, [from, to]);
        errors++;
        pausedUntil = now() + Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** (errors - 1));
        if (errors === 1 || errors % 10 === 0) log.warn(`[carreteras] CartoCiudad no responde (${err.message}): ${pending.size} tramos pendientes`);
        return false;
      } finally {
        busy = false;
      }
    },

    async load() {
      try {
        const raw = JSON.parse((await gunzipAsync(await readFile(file), { maxOutputLength: 256 * 1024 * 1024 })).toString('utf8'));
        for (const [key, text] of Object.entries(raw?.roads ?? {})) {
          try {
            const road = Float32Array.from(decodePolyline(text));
            if (road.length >= 4) known.set(key, road);
          } catch { /* un tramo dañado: se volverá a pedir */ }
        }
        for (const [key, at] of Object.entries(raw?.failed ?? {})) if (Number.isFinite(at) && now() - at < RETRY_FAILED_MS) failed.set(key, at);
        if (known.size) version++;
        log.info(`[carreteras] ${known.size} tramos por carretera recuperados`);
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[carreteras] no se pudo leer la copia (${err.message}): se empieza de cero`);
      }
    },

    async save() {
      if (!dirty) return;
      dirty = false;
      try {
        const roads = {};
        for (const [key, road] of known) roads[key] = encodePolyline(road);
        const body = JSON.stringify({ version: 1, roads, failed: Object.fromEntries(failed) });
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(file, await gzipAsync(Buffer.from(body), { level: 6 }));
      } catch (err) {
        dirty = true;
        log.warn(`[carreteras] no se pudo guardar la copia (${err.message})`);
      }
    },

    stats: () => ({ known: known.size, failed: failed.size, pending: pending.size, urgent: urgent.size }),
  };
}
