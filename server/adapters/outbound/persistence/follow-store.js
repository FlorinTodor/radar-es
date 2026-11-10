// Lo que sigue cada chat del bot, en el disco de datos (data/bot), aparte de la caché de descargas: no es
// algo que se pueda volver a descargar. En JSON, para poder mirarlo (y borrarlo a mano si alguien lo pide), y
// escrito de golpe (writeFileAtomic): en un relevo hay dos servidores con la misma carpeta.
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../http/file-cache.js';

const NAME = 'seguidos.v1.json';

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, name?: string }} deps
 * @returns {import('../../../application/ports.js').FollowStorePort}
 */
export function createFollowStore({ dir, log, name = NAME }) {
  const file = new URL(name, dir);
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[telegram] no se pudo leer lo que sigue cada chat (${err.message}): se empieza de cero`);
        return null;
      }
    },
    async save(snapshot) {
      try {
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(file, JSON.stringify(snapshot));
      } catch (err) {
        log.warn(`[telegram] no se pudo guardar lo que sigue cada chat (${err.message})`);
      }
    },
  };
}
