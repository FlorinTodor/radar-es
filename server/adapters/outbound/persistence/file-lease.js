// Turno en un fichero del disco de datos (data/bot): lo coge el servidor que atiende el bot y lo renueva
// mientras lo atiende. En un relevo, el que arranca espera a que el otro lo suelte (al apagarse) o a que
// caduque si se cayó sin soltarlo. Dos que lo intenten a la vez: cada uno escribe el suyo y lo vuelve a leer,
// y sólo se lo queda aquel cuyo nombre sigue escrito.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { writeFileAtomic } from '../http/file-cache.js';

const NAME = 'turno.json';

/**
 * @param {{ dir: URL, ttlMs?: number, id?: string, now?: () => number, name?: string }} deps
 *   ttlMs: cuánto vale un turno sin renovar (quien lo tiene lo renueva bastante antes).
 * @returns {import('../../../application/ports.js').LeasePort & { id: string }}
 */
export function createFileLease({ dir, ttlMs = 90_000, id = randomUUID(), now = Date.now, name = NAME }) {
  const file = new URL(name, dir);
  const current = async () => {
    try {
      const v = JSON.parse(await readFile(file, 'utf8'));
      return typeof v?.id === 'string' && Number.isFinite(v.until) ? v : null;
    } catch {
      return null;
    }
  };
  return {
    id,
    async claim() {
      const holder = await current();
      if (holder && holder.id !== id && holder.until > now()) return false;
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(file, JSON.stringify({ id, until: now() + ttlMs }));
      return (await current())?.id === id;
    },
    async release() {
      if ((await current())?.id === id) await rm(file, { force: true });
    },
  };
}
