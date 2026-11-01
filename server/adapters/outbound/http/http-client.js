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
 * @typedef {{ timeout?: number, headers?: Record<string, string>, maxBytes?: number }} RequestOptions
 * @typedef {object} HttpClient
 * @property {(url: string, opts?: RequestOptions) => Promise<string>} text
 * @property {(url: string, opts?: RequestOptions) => Promise<any>} json
 * @property {(url: string, opts?: RequestOptions) => Promise<Uint8Array>} bytes  Para feeds binarios (GTFS-RT protobuf).
 */

/** @returns {HttpClient} */
export function createHttpClient({ userAgent = DEFAULT_UA, defaultTimeout = 20_000 } = {}) {
  async function get(url, { timeout = defaultTimeout, headers = {}, maxBytes = DEFAULT_MAX_BYTES } = {}) {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
    return readLimited(res, maxBytes, new URL(url).host);
  }
  const text = async (url, opts) => new TextDecoder().decode(await get(url, opts));
  return {
    text,
    json: async (url, opts) => JSON.parse(await text(url, opts)),
    bytes: get,
  };
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
