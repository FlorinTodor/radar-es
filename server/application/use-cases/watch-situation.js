// Caso de uso: seguir en directo los cambios de la situación (lo usa el stream SSE de /api/stream).
// Traduce los eventos de la aplicación (una fuente se ha leído o ha fallado, las alertas han
// cambiado) en lo que necesita quien escucha, sin que el adaptador conozca el bus ni sus temas.

/**
 * @param {{ events: import('../ports.js').EventPublisherPort,
 *           query: ReturnType<typeof import('./query-situation.js').makeQuerySituation> }} deps
 */
export function makeWatchSituation({ events, query }) {
  /**
   * @param {{ buses?: boolean }} options  `buses`: quien escucha tiene activada la capa de autobuses.
   * @param {{ onSource: (payload: object) => void, onHealthChange: () => void, onAlerts: (payload: object) => void }} handlers
   *   onSource: datos nuevos de una fuente (los de `query.sourcePayload`).
   *   onHealthChange: el estado de alguna fuente ha cambiado (ha respondido o ha fallado).
   *   onAlerts: alertas activas, indicadores y las 30 últimas resueltas.
   * @returns {() => void} Deja de escuchar.
   */
  return function watchSituation({ buses = true } = {}, { onSource, onHealthChange, onAlerts }) {
    const unsubscribe = [
      events.subscribe('source.updated', ({ id }) => {
        const payload = query.sourcePayload(id, { buses });
        if (payload) onSource(payload);
        onHealthChange();
      }),
      events.subscribe('source.failed', () => onHealthChange()),
      events.subscribe('alerts.updated', ({ alerts, kpis }) => onAlerts({ alerts, kpis, resolved: query.resolvedAlerts().slice(0, 30) })),
    ];
    return () => unsubscribe.forEach((off) => off());
  };
}
