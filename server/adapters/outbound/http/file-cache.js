// Descargas cacheadas en disco (GTFS, catálogos…): se reutiliza la copia mientras sea
// reciente y, si la fuente falla, mejor una copia vieja que nada.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

/**
 * @param {{ http: import('./http-client.js').HttpClient, dir: URL, log: import('../../../application/ports.js').LoggerPort }} deps
 */
export function createFileCache({ http, dir, log }) {
  return {
    /**
     * `validate(bytes)`, si se da, lanza cuando la respuesta no vale aunque llegue con un 200 (las
     * API de Wikimedia devuelven así «demasiado ocupado»): no se guarda y se usa la copia anterior.
     * @returns {Promise<Uint8Array>}
     */
    async bytes(url, name, maxAgeMs, { validate, ...opts } = {}) {
      const file = new URL(name, dir);
      try {
        if (Date.now() - (await stat(file)).mtimeMs < maxAgeMs) return new Uint8Array(await readFile(file));
      } catch { /* sin caché */ }
      try {
        // Los GTFS más grandes rondan los 20 MB: 256 MB es un tope muy holgado, pero un tope.
        const bytes = await http.bytes(url, { timeout: 180_000, maxBytes: 256 * 1024 * 1024, ...opts });
        validate?.(bytes);
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

    /** Un resultado calculado guardado junto a las descargas (JSON), o null si no está o no se lee. */
    async readJson(name) {
      try {
        return JSON.parse(await readFile(new URL(name, dir), 'utf8'));
      } catch {
        return null;
      }
    },

    async writeJson(name, value) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(new URL(name, dir), JSON.stringify(value));
      } catch (err) {
        log.warn(`[caché] ${name}: no se pudo guardar (${err.message})`);
      }
    },
  };
}
