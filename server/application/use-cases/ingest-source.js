// Caso de uso: leer una fuente, guardar su resultado y avisar de que hay datos nuevos.
import { plausibleDelay, safeLink } from '../../domain/model.js';
import { recordPositions } from '../../domain/tracking.js';

/**
 * @param {{ sources: import('../ports.js').DataSourcePort[], situation: import('../ports.js').SituationRepositoryPort,
 *           publisher: import('../ports.js').EventPublisherPort, clock: import('../ports.js').ClockPort,
 *           log: import('../ports.js').LoggerPort }} deps
 *   sources: las fuentes activas; quien dispara el caso de uso sólo da su id.
 */
export function makeIngestSource({ sources, situation, publisher, clock, log }) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  /** @param {string} id @returns {Promise<boolean>} true si la lectura ha ido bien. */
  return async function ingestSource(id) {
    const source = byId.get(id);
    if (!source) throw new Error(`Fuente desconocida o desactivada: ${id}`);
    const started = clock.now();
    try {
      const result = await source.fetch();
      for (const e of result.events ?? []) if ('url' in e) e.url = safeLink(e.url);
      for (const v of result.vehicles ?? []) if (v.delay !== null && v.delay !== undefined) v.delay = plausibleDelay(v.delay);
      const now = clock.now();
      // Antes de guardar: el historial deja en su sitio los vehículos con una posición repetida o imposible.
      if (result.vehicles) recordPositions(situation.tracks(), result.vehicles, now);
      situation.saveResult(source.id, result, now, now - started);
      publisher.publish('source.updated', { id: source.id });
      return true;
    } catch (err) {
      situation.saveFailure(source.id, err, clock.now());
      log.warn(`[${source.id}] ${err.message}`);
      publisher.publish('source.failed', { id: source.id });
      return false;
    }
  };
}
