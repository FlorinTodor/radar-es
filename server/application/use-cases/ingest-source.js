// Caso de uso: leer una fuente, guardar su resultado y avisar de que hay datos nuevos.
import { recordPositions } from '../../domain/tracking.js';

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, publisher: import('../ports.js').EventPublisherPort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort }} deps
 */
export function makeIngestSource({ situation, publisher, clock, log }) {
  /** @param {import('../ports.js').DataSourcePort} source @returns {Promise<boolean>} */
  return async function ingestSource(source) {
    const started = clock.now();
    try {
      const result = await source.fetch();
      const now = clock.now();
      situation.saveResult(source.id, result, now, now - started);
      if (result.vehicles) recordPositions(situation.tracks(), result.vehicles, now);
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
