// Cliente HTTP compartido por los adaptadores de fuentes. Usa un User-Agent que nos
// identifica como lo que somos: un cliente de datos abiertos.
const DEFAULT_UA = 'RadarES/0.1 (visor de datos abiertos de movilidad y emergencias)';

/**
 * Tope por defecto de una respuesta. Los feeds más grandes (DGT, autobuses) son de pocos MB: una
 * fuente que de repente devolviera cientos de MB (un error suyo, una redirección a otra cosa) se
 * leería entera en memoria y tumbaría el contenedor, que tiene 1 GB.
 */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Redirecciones: se siguen a mano (fetch las sigue solo, hasta 20, a cualquier sitio y reenviando las
 * cabeceras propias, también de https a http), con estas reglas:
 * - como mucho MAX_REDIRECTS saltos;
 * - nunca de https a http, ni a otro esquema que no sea http(s);
 * - si la llamada pasa cabeceras propias (`headers`), sólo al mismo origen (esquema, host y puerto). Hoy
 *   todas las que las pasan llevan claves: la ApiKey del NAP, la x-api-key de e·sios y el X-ClientId, la
 *   passKey y el accessToken de EMT Madrid. Va solo, sin tener que pedirlo, para que una fuente nueva con
 *   clave no la mande a otro sitio por olvido;
 * - con `sameOrigin: true`, lo mismo sin cabeceras: para las peticiones cuyo cuerpo se reenvía al
 *   visitante (el WFS de áreas quemadas de EFFIS), que una redirección no lleve a un servicio interno.
 * Las demás siguen redirecciones a otro origen, como antes (las de los catálogos y ficheros públicos).
 */
const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * @typedef {{ timeout?: number, headers?: Record<string, string>, maxBytes?: number, info?: { lastModified?: number | null },
 *             sameOrigin?: boolean }} RequestOptions
 *   info: si se pasa, se rellena con la fecha de Last-Modified de la respuesta (las fuentes que no la
 *   llevan dentro del propio fichero, para citar su fecha de actualización).
 *   sameOrigin: sólo se siguen redirecciones al mismo origen (va solo si hay `headers`; ver arriba).
 * @typedef {object} HttpClient
 * @property {(url: string, opts?: RequestOptions) => Promise<string>} text
 * @property {(url: string, opts?: RequestOptions) => Promise<any>} json
 * @property {(url: string, opts?: RequestOptions) => Promise<Uint8Array>} bytes  Para feeds binarios (GTFS-RT protobuf).
 * @property {(url: string, body: any, opts?: RequestOptions) => Promise<any>} postJson  Manda `body` como JSON y
 *   devuelve la respuesta en JSON (las APIs a las que se escribe: el bot de Telegram). No sigue redirecciones.
 *   Si la respuesta no es 2xx, el error lleva `status` y, si la respuesta es JSON, `body` (Telegram dice ahí
 *   cuánto esperar, `retry_after`). Como los demás, el mensaje sólo dice el host: la ruta puede llevar una clave.
 */

/** @returns {HttpClient} */
export function createHttpClient({ userAgent = DEFAULT_UA, defaultTimeout = 20_000 } = {}) {
  async function get(url, { timeout = defaultTimeout, headers = {}, maxBytes = DEFAULT_MAX_BYTES, info, sameOrigin = false } = {}) {
    const first = new URL(url);
    const onlySameOrigin = sameOrigin || Object.keys(headers).length > 0;
    const signal = AbortSignal.timeout(timeout); // para toda la cadena de redirecciones, como hacía fetch
    let at = first;
    for (let hops = 0; ; hops++) {
      const res = await fetch(at, { headers: { 'User-Agent': userAgent, ...headers }, signal, redirect: 'manual' });
      const location = REDIRECT_STATUS.has(res.status) ? res.headers.get('location') : null;
      if (location === null) {
        if (!res.ok) throw new Error(`HTTP ${res.status} en ${first.host}`);
        if (info) info.lastModified = Date.parse(res.headers.get('last-modified') ?? '') || null;
        return readLimited(res, maxBytes, first.host);
      }
      await res.body?.cancel();
      at = nextHop(first, at, location, { onlySameOrigin, hops });
    }
  }
  const text = async (url, opts) => new TextDecoder().decode(await get(url, opts));

  async function postJson(url, body, { timeout = defaultTimeout, headers = {}, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const at = new URL(url);
    if (at.protocol !== 'https:' && at.protocol !== 'http:') throw new Error(`Esquema no admitido en ${at.host}`);
    const res = await fetch(at, {
      method: 'POST',
      headers: { 'User-Agent': userAgent, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'manual', // a una API se le escribe en su sitio: una redirección es un error
    });
    const raw = new TextDecoder().decode(await readLimited(res, maxBytes, at.host));
    let parsed;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} en ${at.host}`);
      err.status = res.status;
      if (parsed !== undefined) err.body = parsed;
      throw err;
    }
    if (parsed === undefined) throw new Error(`Respuesta que no es JSON en ${at.host}`);
    return parsed;
  }

  return {
    text,
    json: async (url, opts) => JSON.parse(await text(url, opts)),
    bytes: get,
    postJson,
  };
}

/**
 * Adónde lleva una redirección desde `at`, o error si no se sigue (ver las reglas de arriba). Los errores
 * dicen sólo el host: ni la ruta ni la consulta, que pueden llevar claves.
 */
function nextHop(first, at, location, { onlySameOrigin, hops }) {
  if (hops >= MAX_REDIRECTS) throw new Error(`Más de ${MAX_REDIRECTS} redirecciones desde ${first.host}`);
  let next;
  try {
    next = new URL(location, at);
  } catch {
    throw new Error(`Redirección no válida en ${at.host}`);
  }
  if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new Error(`Redirección a ${next.protocol} en ${at.host}: no se sigue`);
  if (at.protocol === 'https:' && next.protocol === 'http:') throw new Error(`Redirección de https a http en ${at.host}: no se sigue`);
  if (onlySameOrigin && next.origin !== first.origin) throw new Error(`Redirección de ${first.host} a otro origen (${next.host}): no se sigue`);
  return next;
}

/** Cuerpo de la respuesta, cortando la descarga en cuanto pasa de `maxBytes`. */
async function readLimited(res, maxBytes, host) {
  const tooBig = () => new Error(`Respuesta de más de ${Math.round(maxBytes / 1048576)} MB en ${host}`);
  if (Number(res.headers.get('content-length')) > maxBytes) {
    await res.body?.cancel();
    throw tooBig();
  }
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) throw tooBig(); // salir del bucle cancela la descarga
      chunks.push(chunk);
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
