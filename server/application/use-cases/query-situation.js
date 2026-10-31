// Casos de uso de consulta: lo que los adaptadores de entrada (API, SSE...) pueden preguntar.
import { sortAlerts } from '../../domain/alerts/lifecycle.js';

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           network: import('../ports.js').NetworkCatalogPort }} deps
 */
export function makeQuerySituation({ situation, stations, network }) {
  const alerts = () => sortAlerts(situation.activeAlerts().values());
  // Los autobuses (miles en hora punta) sólo se envían a quien tiene activada su capa.
  const busFilter = (buses) => (buses ? (list) => list : (list) => list.filter((v) => v.mode !== 'bus'));

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

    /** Estelas de todos los trenes (sin autobuses) en los últimos `minutes` minutos, como GeoJSON. */
    trails(minutes = 15) {
      const since = Date.now() - minutes * 60_000;
      const modes = new Map(situation.vehicles().map((v) => [v.id, v.mode]));
      const round = (x) => Math.round(x * 1e5) / 1e5;
      const features = [];
      for (const [id, track] of situation.tracks()) {
        const mode = modes.get(id);
        if (!mode || mode === 'bus') continue;
        const points = track.filter((p, i) => p.t >= since || i === track.length - 1);
        if (points.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: points.map((p) => [round(p.lon), round(p.lat)]) },
          properties: { id, mode },
        });
      }
      return { type: 'FeatureCollection', features };
    },

    /**
     * Datos de una sola fuente, para empujar cambios incrementales. Sin `buses`, null para las
     * fuentes que sólo tienen autobuses (no hay nada que enviar).
     */
    sourcePayload(id, { buses = true } = {}) {
      const s = situation.source(id);
      if (!s?.data) return null;
      const all = s.data.vehicles ?? s.data.events ?? null;
      const items = s.data.vehicles ? busFilter(buses)(all) : all;
      if (s.data.vehicles && all.length && !items.length) return null;
      return {
        id,
        kind: s.meta.kind,
        items: items?.map((x) => ({ ...x, source: id })) ?? null,
        metrics: s.data.metrics ?? null,
      };
    },

    snapshot({ buses = true } = {}) {
      return {
        generatedAt: Date.now(),
        vehicles: busFilter(buses)(situation.vehicles()),
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
