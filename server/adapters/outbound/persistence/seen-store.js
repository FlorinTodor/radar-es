// Cuándo vio el radar por primera vez cada incidencia de una fuente (las cancelaciones: sus fuentes no
// dicen cuándo las publicaron). Se guarda junto a la caché de descargas: un reinicio o un despliegue no
// las da por nuevas. Las que la fuente deja de publicar se olvidan (ver domain/cancelaciones.js, stampSeen).
import { stampSeen } from '../../../domain/cancelaciones.js';

/**
 * @param {{ cache?: { readValue?: (name: string) => Promise<any>, writeValue?: (name: string, value: any) => Promise<void> },
 *           name: string, now?: () => number }} deps
 *   cache: sin ella (tests), sólo en memoria. name: fichero de la caché.
 */
export function createSeenStore({ cache, name, now = Date.now }) {
  let seen = null; // id → epoch ms
  let atStart = new Set(); // las que ya estaban en la primera lectura tras arrancar y no se habían visto antes
  let first = true;

  return {
    /**
     * Apunta las de esta lectura y dice desde cuándo se ve cada una.
     * @param {Iterable<string>} ids
     * @returns {Promise<(id: string) => { seen: number, seenAtStart: boolean }>}
     */
    async stamp(ids) {
      if (!seen) {
        const saved = await cache?.readValue?.(name);
        seen = new Map(Array.isArray(saved?.seen) ? saved.seen.filter(([id, t]) => typeof id === 'string' && Number.isFinite(t)) : []);
        atStart = new Set(Array.isArray(saved?.atStart) ? saved.atStart.filter((id) => seen.has(id)) : []);
      }
      const result = stampSeen(seen, ids, now());
      if (first) for (const id of result.added) atStart.add(id);
      first = false;
      for (const id of atStart) if (!result.seen.has(id)) atStart.delete(id);
      seen = result.seen;
      if (result.added.length || result.removed) await cache?.writeValue?.(name, { seen: [...seen], atStart: [...atStart] });
      const current = seen;
      return (id) => ({ seen: current.get(id), seenAtStart: atStart.has(id) });
    },
  };
}
