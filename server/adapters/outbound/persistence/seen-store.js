// Cuándo vio el radar por primera vez cada incidencia de una fuente (las cancelaciones: sus fuentes no
// dicen cuándo las publicaron) y las cancelaciones que la fuente ha dejado de publicar hoy. Se guarda
// junto a la caché de descargas: un reinicio o un despliegue no las da por nuevas ni olvida las retiradas.
// Las que la fuente deja de publicar se olvidan como vistas (ver domain/cancelaciones.js, stampSeen): si
// vuelven, son nuevas.
import { followWithdrawn, stampSeen } from '../../../domain/cancelaciones.js';

/**
 * @param {{ cache?: { readValue?: (name: string) => Promise<any>, writeValue?: (name: string, value: any) => Promise<void> },
 *           name: string, now?: () => number }} deps
 *   cache: sin ella (tests), sólo en memoria. name: fichero de la caché.
 */
export function createSeenStore({ cache, name, now = Date.now }) {
  let seen = null; // id → epoch ms
  let atStart = new Set(); // las que ya estaban en la primera lectura tras arrancar y no se habían visto antes
  let first = true;
  // Las cancelaciones de la última lectura y las retiradas hoy (id → incidencia).
  let shown = new Map();
  let withdrawn = new Map();

  const events = (list) => new Map(Array.isArray(list) ? list.filter((e) => typeof e?.id === 'string').map((e) => [e.id, e]) : []);
  async function load() {
    if (seen) return;
    const saved = await cache?.readValue?.(name);
    seen = new Map(Array.isArray(saved?.seen) ? saved.seen.filter(([id, t]) => typeof id === 'string' && Number.isFinite(t)) : []);
    atStart = new Set(Array.isArray(saved?.atStart) ? saved.atStart.filter((id) => seen.has(id)) : []);
    shown = events(saved?.shown);
    withdrawn = events(saved?.withdrawn);
  }
  const save = () => cache?.writeValue?.(name, { seen: [...seen], atStart: [...atStart], shown: [...shown.values()], withdrawn: [...withdrawn.values()] });

  return {
    /**
     * Apunta las de esta lectura y dice desde cuándo se ve cada una.
     * @param {Iterable<string>} ids
     * @returns {Promise<(id: string) => { seen: number, seenAtStart: boolean }>}
     */
    async stamp(ids) {
      await load();
      const result = stampSeen(seen, ids, now());
      if (first) for (const id of result.added) atStart.add(id);
      first = false;
      for (const id of atStart) if (!result.seen.has(id)) atStart.delete(id);
      seen = result.seen;
      if (result.added.length || result.removed) await save();
      const current = seen;
      return (id) => ({ seen: current.get(id), seenAtStart: atStart.has(id) });
    },

    /**
     * Las cancelaciones de esta lectura (`current`, de una lectura buena de su fuente): devuelve las que la
     * fuente ha dejado de publicar hoy (ver domain/cancelaciones.js, followWithdrawn).
     * @param {import('../../../domain/model.js').IncidentEvent[]} current
     * @param {{ clock: string, endOfDay: number }} day  clock: «HH:MM» de ahora en Madrid; endOfDay: su medianoche
     * @returns {Promise<import('../../../domain/model.js').IncidentEvent[]>}
     */
    async withdrawn(current, { clock, endOfDay }) {
      await load();
      const before = { shown: [...shown.keys()].join('\n'), withdrawn: [...withdrawn.keys()].join('\n') };
      ({ shown, withdrawn } = followWithdrawn({ shown, withdrawn }, current, { now: now(), clock, endOfDay }));
      if ([...shown.keys()].join('\n') !== before.shown || [...withdrawn.keys()].join('\n') !== before.withdrawn) await save();
      return [...withdrawn.values()];
    },
  };
}
