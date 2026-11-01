// Caso de uso: seguir en directo los cambios de la situación (lo usa el stream SSE de /api/stream).
// Traduce los eventos de la aplicación (una fuente se ha leído o ha fallado, las alertas han
// cambiado) en lo que necesita quien escucha, sin que el adaptador conozca el bus ni sus temas.
//
// Una sola suscripción al bus para todos los que escuchan: cada cambio se calcula una vez (con y
// sin autobuses) y todos reciben el mismo objeto, así el adaptador lo serializa una sola vez. Con
// una suscripción por conexión, 300 conexiones y una lectura de Renfe bloqueaban el hilo ~120 ms.

/**
 * @param {{ events: import('../ports.js').EventPublisherPort,
 *           query: ReturnType<typeof import('./query-situation.js').makeQuerySituation> }} deps
 */
export function makeWatchSituation({ events, query }) {
  const listeners = new Set();
  let unsubscribe = null;

  const subscribe = () => [
    events.subscribe('source.updated', ({ id }) => {
      const payloads = new Map(); // buses → datos de la fuente
      for (const l of [...listeners]) {
        if (!payloads.has(l.buses)) payloads.set(l.buses, query.sourcePayload(id, { buses: l.buses }));
        const payload = payloads.get(l.buses);
        if (payload) l.onSource(payload);
        l.onHealthChange();
      }
    }),
    events.subscribe('source.failed', () => {
      for (const l of [...listeners]) l.onHealthChange();
    }),
    events.subscribe('alerts.updated', ({ alerts, kpis }) => {
      const payload = { alerts, kpis, resolved: query.resolvedAlerts().slice(0, 30) };
      for (const l of [...listeners]) l.onAlerts(payload);
    }),
  ];

  /**
   * @param {{ buses?: boolean }} options  `buses`: quien escucha tiene activada la capa de autobuses.
   * @param {{ onSource: (payload: object) => void, onHealthChange: () => void, onAlerts: (payload: object) => void }} handlers
   *   onSource: datos nuevos de una fuente (los de `query.sourcePayload`).
   *   onHealthChange: el estado de alguna fuente ha cambiado (ha respondido o ha fallado).
   *   onAlerts: alertas activas, indicadores y las 30 últimas resueltas.
   *   Todos los que escuchan reciben el mismo objeto: no se puede modificar.
   * @returns {() => void} Deja de escuchar.
   */
  return function watchSituation({ buses = true } = {}, { onSource, onHealthChange, onAlerts }) {
    const listener = { buses: Boolean(buses), onSource, onHealthChange, onAlerts };
    listeners.add(listener);
    unsubscribe ??= subscribe();
    return () => {
      if (!listeners.delete(listener) || listeners.size) return;
      unsubscribe.forEach((off) => off());
      unsubscribe = null;
    };
  };
}
