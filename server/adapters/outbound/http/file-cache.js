// Descargas cacheadas en disco (GTFS, catálogos…): se reutiliza la copia mientras sea
// reciente y, si la fuente falla, mejor una copia vieja que nada.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/**
 * @param {{ http: import('./http-client.js').HttpClient, dir: URL, log: import('../../../application/ports.js').LoggerPort }} deps
 */
export function createFileCache({ http, dir, log }) {
  return {
    /** @returns {Promise<Uint8Array>} */
    async bytes(url, name, maxAgeMs, opts = {}) {
      const file = new URL(name, dir);
      try {
        if (Date.now() - (await stat(file)).mtimeMs < maxAgeMs) return new Uint8Array(await readFile(file));
      } catch { /* sin caché */ }
      try {
        const bytes = await http.bytes(url, { timeout: 180_000, ...opts });
        await mkdir(dir, { recursive: true });
        await writeFile(file, bytes);
        return bytes;
      } catch (err) {
        try {
          const old = new Uint8Array(await readFile(file));
          log.warn(`[caché] ${name}: ${err.message}; uso la copia guardada`);
          return old;
        } catch {
          throw err;
        }
      }
    },
  };
}
