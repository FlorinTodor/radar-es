// Las incidencias que ya no salen en el directo, para que su enlace compartido siga diciendo qué eran (caso de uso
// share): un JSON comprimido en data/compartir/. Pesa poco (como mucho unas 10.000, con sólo lo que enseña su
// tarjeta). Se escribe de golpe (writeFileAtomic): en un relevo, con dos servidores en la misma carpeta, ninguno lee
// una copia a medio escribir.
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { writeFileAtomic } from '../http/file-cache.js';

const NAME = 'terminadas.v1.json.gz';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// 10.000 incidencias de como mucho 2 kB: una copia mayor no es nuestra y no se descomprime entera en memoria.
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, name?: string }} deps
 * @returns {import('../../../application/ports.js').EndedStorePort}
 */
export function createEndedStore({ dir, log, name = NAME }) {
  const file = new URL(name, dir);
  return {
    async load() {
      try {
        return JSON.parse((await gunzipAsync(await readFile(file), { maxOutputLength: MAX_BYTES })).toString('utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[compartir] no se pudo leer la copia de las incidencias terminadas (${err.message}): se empieza de cero`);
        return null;
      }
    },
    async save(record) {
      try {
        const bytes = await gzipAsync(Buffer.from(JSON.stringify(record)), { level: 6 });
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(file, bytes);
      } catch (err) {
        log.warn(`[compartir] no se pudo guardar la copia de las incidencias terminadas (${err.message})`);
      }
    },
  };
}
