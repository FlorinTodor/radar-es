// Cliente HTTP compartido por los adaptadores de fuentes. Usa un User-Agent que nos
// identifica como lo que somos: un cliente de datos abiertos.
const DEFAULT_UA = 'RadarES/0.1 (visor de datos abiertos de movilidad y emergencias)';

/**
 * @typedef {{ timeout?: number, headers?: Record<string, string> }} RequestOptions
 * @typedef {object} HttpClient
 * @property {(url: string, opts?: RequestOptions) => Promise<string>} text
 * @property {(url: string, opts?: RequestOptions) => Promise<any>} json
 * @property {(url: string, opts?: RequestOptions) => Promise<Uint8Array>} bytes  Para feeds binarios (GTFS-RT protobuf).
 */

/** @returns {HttpClient} */
export function createHttpClient({ userAgent = DEFAULT_UA, defaultTimeout = 20_000 } = {}) {
  async function get(url, { timeout = defaultTimeout, headers = {} } = {}) {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url).host}`);
    return res;
  }
  const text = async (url, opts) => (await get(url, opts)).text();
  return {
    text,
    json: async (url, opts) => JSON.parse(await text(url, opts)),
    bytes: async (url, opts) => new Uint8Array(await (await get(url, opts)).arrayBuffer()),
  };
}
