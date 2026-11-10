// Copia de la puntualidad histórica en el disco de datos (data/cache), junto a las estelas. Comprimida: son
// arrays con un hueco por clave y día, casi todos vacíos, y la copia baja de unos 15 MB a muy poco. La
// compresión va en el pool de hilos de Node (zlib asíncrono): guardar no para las respuestas del servidor.
// Se escribe de golpe (writeFileAtomic): en un relevo, con dos servidores en la misma carpeta, ninguno lee
// una copia a medio escribir.
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { deserialize, serialize } from 'node:v8';
import { gunzip, gzip } from 'node:zlib';
import { writeFileAtomic } from '../http/file-cache.js';

const NAME = 'puntualidad.v1.gz';
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
// Una copia más grande que esto no es nuestra (el libro tiene topes): no se descomprime entera en memoria.
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, name?: string }} deps
 * @returns {import('../../../application/ports.js').PunctualityStorePort}
 */
export function createPunctualityStore({ dir, log, name = NAME }) {
  const file = new URL(name, dir);
  return {
    async load() {
      try {
        return deserialize(await gunzipAsync(await readFile(file), { maxOutputLength: MAX_BYTES }));
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[puntualidad] no se pudo leer la copia guardada (${err.message}): se empieza de cero`);
        return null;
      }
    },
    async save(snapshot) {
      try {
        const bytes = await gzipAsync(serialize(snapshot), { level: 6 });
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(file, bytes);
      } catch (err) {
        log.warn(`[puntualidad] no se pudo guardar la copia (${err.message})`);
      }
    },
  };
}
