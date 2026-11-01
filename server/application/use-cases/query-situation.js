// Casos de uso de consulta: lo que los adaptadores de entrada (API, SSE...) pueden preguntar.
import { sortAlerts } from '../../domain/alerts/lifecycle.js';
import { headingOf } from '../../domain/tracking.js';

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           network: import('../ports.js').NetworkCatalogPort, clock: import('../ports.js').ClockPort,
 *           sources?: import('../ports.js').DataSourcePort[] }} deps
 */
export function makeQuerySituation({ situation, stations, network, clock, sources = [] }) {
  const withPaths = sources.filter((s) => typeof s.path === 'function');
  const alerts = () => sortAlerts(situation.activeAlerts().values());
  // Los autobuses (miles en hora punta) sólo se envían a quien tiene activada su capa.
  const busFilter = (buses) => (buses ? (list) => list : (list) => list.filter((v) => v.mode !== 'bus'));
  // Pero cuántos hay de cada tipo se envía siempre: el panel de capas lo muestra con la capa apagada.
  const countByMode = (list, into = {}) => {
    for (const v of list) into[v.mode] = (into[v.mode] ?? 0) + 1;
    return into;
  };

  // Cada vehículo del directo lleva hacia dónde va, sacado de su historial: el mapa lo dibuja con una flecha.
  const withHeading = (list) => {
    const tracks = situation.tracks();
    return list.map((v) => {
      if (Number.isFinite(v.heading)) return v; // la fuente sabe por dónde va (su recorrido): mejor que el rastro
      const heading = headingOf(tracks.get(v.id));
      return heading === null ? v : { ...v, heading };
    });
  };

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
    // La lista la descarga cada visita al abrir el mapa: sólo lo que hace falta para pintarlas y
    // buscarlas. La ficha completa de una estación, con sus fotos y enlaces, va aparte (station).
    stations: () => stations.all().map(({ code, name, place, province, lat, lon, cercanias, metricGauge, accessible }) => (
      { code, name, place, province, lat, lon, cercanias, metricGauge, accessible })),
    station: (code) => stations.get(code) ?? null,
    lines: () => network.lines(),
    /**
     * Recorrido reciente de un vehículo. Los de posición estimada usan su trazado (las posiciones de
     * cada lectura, unidas con rectas, cruzarían manzanas); los que no tienen trazado, ninguno.
     */
    track(id) {
      for (const s of withPaths) {
        const path = s.path(id);
        if (path !== undefined) return path ? path.map(([lon, lat]) => ({ lon, lat })) : [];
      }
      return situation.tracks().get(id) ?? null;
    },
    /**
     * Lo que le queda a un vehículo de posición estimada hasta el final de su viaje, por su trazado.
     * Los de GPS (Cercanías) lo calcula el mapa con el trazado de su viaje; null si no se sabe.
     */
    ahead(id) {
      for (const s of withPaths) {
        const path = s.ahead?.(id);
        if (path !== undefined) return path && path.length > 1 ? path : null;
      }
      return null;
    },

    /** Estelas de todos los trenes (sin autobuses) en los últimos `minutes` minutos, como GeoJSON. */
    trails(minutes = 15) {
      const since = clock.now() - minutes * 60_000;
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
     * Datos de una sola fuente, para empujar cambios incrementales. Sin `buses`, una fuente que
     * sólo tiene autobuses llega sin vehículos, pero con su recuento (`counts`).
     */
    sourcePayload(id, { buses = true } = {}) {
      const s = situation.source(id);
      if (!s?.data) return null;
      const all = s.data.vehicles ?? s.data.events ?? null;
      const items = s.data.vehicles ? busFilter(buses)(all) : all;
      return {
        id,
        kind: s.meta.kind,
        items: items?.map((x) => ({ ...x, source: id })) ?? null,
        counts: s.data.vehicles ? countByMode(all) : null,
        metrics: s.data.metrics ?? null,
      };
    },

    // ---------- Directo por consulta periódica (lo que Cloudflare guarda unos segundos) ----------
    // Separado por ritmo de cambio y tamaño: las posiciones cambian cada pocos segundos; las
    // incidencias (más de mil, de tráfico sobre todo) cada minuto; los autobuses son miles y sólo
    // los pide quien activa su capa.

    /** Posiciones (sin autobuses), recuento por fuente y tipo, alertas e indicadores. */
    live() {
      const vehicles = situation.vehicles();
      const counts = {};
      for (const v of vehicles) countByMode([v], counts[v.source] ??= {});
      return {
        generatedAt: clock.now(),
        vehicles: withHeading(busFilter(false)(vehicles)),
        counts,
        metrics: situation.metrics(),
        alerts: alerts(),
        resolved: situation.resolvedAlerts().slice(0, 30),
        kpis: situation.kpis(),
      };
    },
    liveEvents: () => ({ generatedAt: clock.now(), events: situation.events() }),
    liveBuses: () => ({ generatedAt: clock.now(), vehicles: withHeading(situation.vehicles().filter((v) => v.mode === 'bus')) }),

    snapshot({ buses = true } = {}) {
      const vehicles = situation.vehicles();
      const counts = {}; // fuente → { modo: número }
      for (const v of vehicles) countByMode([v], counts[v.source] ??= {});
      return {
        generatedAt: clock.now(),
        vehicles: busFilter(buses)(vehicles),
        counts,
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
