// Caso de uso: leer una fuente y guardar su resultado (o su error).
import { plausibleDelay, safeLink } from '../../domain/model.js';
import { recordPositions } from '../../domain/tracking.js';

/**
 * @param {{ sources: import('../ports.js').DataSourcePort[], situation: import('../ports.js').SituationRepositoryPort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort,
 *           metrics?: Pick<import('../ports.js').MetricsPort, 'sourceRead'> }} deps
 *   sources: las fuentes activas; quien dispara el caso de uso sólo da su id.
 *   metrics: cuenta cada lectura (buena o fallida) y lo que ha tardado, para la monitorización.
 */
export function makeIngestSource({ sources, situation, clock, log, metrics = NO_METRICS }) {
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
      // Antes de guardar: si la fuente lo permite, el historial deja en su sitio los vehículos con una
      // posición repetida o imposible.
      if (result.vehicles) situation.updateTracks((tracks) => recordPositions(tracks, result.vehicles, now, { clean: source.cleanPositions === true }));
      situation.saveResult(source.id, result, now, now - started);
      metrics.sourceRead({ source: source.id, ok: true, seconds: (now - started) / 1000 });
      return true;
    } catch (err) {
      const now = clock.now();
      situation.saveFailure(source.id, err, now);
      metrics.sourceRead({ source: source.id, ok: false, seconds: (now - started) / 1000 });
      log.warn(`[${source.id}] ${err.message}`);
      return false;
    }
  };
}

const NO_METRICS = { sourceRead() {} };
