// Cliente del Punto de Acceso Nacional de transporte (nap.transportes.gob.es).
// Requiere una ApiKey gratuita (NAP_API_KEY). Cachea en disco los GTFS descargados.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

const BASE = 'https://nap.transportes.gob.es/api';

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, apiKey?: string, cacheDir: URL,
 *           log: import('../../../application/ports.js').LoggerPort }} deps
 */
export function createNapClient({ http, apiKey, cacheDir, log }) {
  return {
    enabled: !!apiKey,

    /** ZIP de un GTFS estático por su ficheroId, desde caché si es reciente. */
    async gtfs(ficheroId, maxAgeMs = 7 * 24 * 3600_000) {
      const file = new URL(`gtfs-${ficheroId}.zip`, cacheDir);
      try {
        if (Date.now() - (await stat(file)).mtimeMs < maxAgeMs) return new Uint8Array(await readFile(file));
      } catch { /* sin caché */ }

      if (!apiKey) throw new Error('Falta NAP_API_KEY');
      try {
        const bytes = await http.bytes(`${BASE}/Fichero/download/${ficheroId}`, { headers: { ApiKey: apiKey }, timeout: 180_000 });
        await mkdir(cacheDir, { recursive: true });
        await writeFile(file, bytes);
        return bytes;
      } catch (err) {
        // Si el NAP falla, mejor una copia vieja que nada.
        try {
          const old = new Uint8Array(await readFile(file));
          log.warn(`[nap] GTFS ${ficheroId}: ${err.message}; uso la copia en caché`);
          return old;
        } catch {
          throw err;
        }
      }
    },
  };
}
