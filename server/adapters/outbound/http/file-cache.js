// Descargas cacheadas en disco (GTFS, catálogos…): se reutiliza la copia mientras sea
// reciente y, si la fuente falla, mejor una copia vieja que nada.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { deserialize, serialize } from 'node:v8';

/**
 * Escribe un fichero de golpe: primero aparte y luego se cambia de nombre. Si el servidor se para a
 * mitad (un despliegue, un reinicio) o dos servidores escriben el mismo a la vez (durante un relevo
 * comparten data/), nunca queda un fichero cortado con fecha de hoy que se siga usando todo el día.
 * @param {URL|string} file
 */
export async function writeFileAtomic(file, data) {
  const tmp = file instanceof URL ? new URL(`${file.href}.${randomUUID()}.tmp`) : `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

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
        await writeFileAtomic(file, bytes);
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

    /**
     * Un resultado calculado guardado junto a las descargas, o null si no está o no se lee. Se guarda
     * con el formato de Node (v8): admite Map, Set y arrays tipados, y se lee mucho más rápido que JSON.
     */
    async readValue(name) {
      try {
        return deserialize(await readFile(new URL(name, dir)));
      } catch {
        return null;
      }
    },

    /** De golpe (writeFileAtomic): durante un relevo hay dos servidores con la misma carpeta, y
     * ninguno debe leer un fichero a medio escribir por el otro. */
    async writeValue(name, value) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(new URL(name, dir), serialize(value));
      } catch (err) {
        log.warn(`[caché] ${name}: no se pudo guardar (${err.message})`);
      }
    },
  };
}
