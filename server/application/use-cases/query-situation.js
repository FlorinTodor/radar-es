// Casos de uso de consulta: lo que los adaptadores de entrada (API, SSE...) pueden preguntar.
import { sortAlerts } from '../../domain/alerts/lifecycle.js';

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           network: import('../ports.js').NetworkCatalogPort }} deps
 */
export function makeQuerySituation({ situation, stations, network }) {
  const alerts = () => sortAlerts(situation.activeAlerts().values());

  return {
    vehicles({ mode, source, minDelay } = {}) {
      return situation.vehicles().filter((v) =>
        (!mode || v.mode === mode) && (!source || v.source === source) && (minDelay === undefined || (v.delay ?? -1) >= minDelay));
    },
    events({ category } = {}) {
      return situation.events().filter((e) => !category || e.category === category);
    },
    alerts,
    resolvedAlerts: () => situation.resolvedAlerts(),
    health: () => situation.health(),
    metrics: () => situation.metrics(),
    kpis: () => ({ current: situation.kpis(), history: situation.kpiHistory() }),
    stations: () => stations.all(),
    lines: () => network.lines(),
    track: (id) => situation.tracks().get(id) ?? null,

    /** Datos de una sola fuente, para empujar cambios incrementales. */
    sourcePayload(id) {
      const s = situation.source(id);
      if (!s?.data) return null;
      const items = s.data.vehicles ?? s.data.events ?? null;
      return {
        id,
        kind: s.meta.kind,
        items: items?.map((x) => ({ ...x, source: id })) ?? null,
        metrics: s.data.metrics ?? null,
      };
    },

    snapshot() {
      return {
        generatedAt: Date.now(),
        vehicles: situation.vehicles(),
        events: situation.events(),
        metrics: situation.metrics(),
        alerts: alerts(),
        resolved: situation.resolvedAlerts().slice(0, 30),
        health: situation.health(),
        kpis: { current: situation.kpis(), history: situation.kpiHistory() },
      };
    },
  };
}
