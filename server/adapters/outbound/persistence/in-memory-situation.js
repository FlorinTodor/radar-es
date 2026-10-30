// Estado vivo en memoria. Si en el futuro hace falta compartirlo entre procesos
// (varias réplicas, workers), se sustituye por otro adaptador (Redis, Postgres...)
// que implemente el mismo puerto SituationRepository.

/** @returns {import('../../../application/ports.js').SituationRepositoryPort} */
export function createInMemorySituation() {
  const sources = new Map(); // id -> { meta, status, data }
  const tracks = new Map();
  const active = new Map();
  let resolved = [];
  let kpis = null;
  const kpiHistory = [];

  const collect = (kind, key) => {
    const out = [];
    for (const { meta, data, status } of sources.values()) {
      if (meta.kind === kind && data && status.enabled) for (const item of data[key]) out.push({ ...item, source: meta.id });
    }
    return out;
  };

  return {
    registerSource(src, { enabled, reason }) {
      sources.set(src.id, {
        meta: { id: src.id, name: src.name, kind: src.kind, interval: src.interval, license: src.license ?? null, url: publicUrl(src.url) },
        status: { enabled, reason: reason ?? null, ok: null, lastOk: null, lastError: null, error: null, count: null, sourceTime: null, datasetUpdated: null, ms: null },
        data: null,
      });
    },

    saveResult(id, result, at, ms) {
      const s = sources.get(id);
      s.data = result;
      Object.assign(s.status, {
        ok: true, lastOk: at, error: null, ms,
        sourceTime: result.sourceTime ?? null,
        datasetUpdated: result.datasetUpdated ?? null,
        count: (result.vehicles ?? result.events)?.length ?? null,
      });
    },

    saveFailure(id, error, at) {
      Object.assign(sources.get(id).status, { ok: false, lastError: at, error: error.message });
    },

    source: (id) => sources.get(id),
    vehicles: () => collect('vehicles', 'vehicles'),
    events: () => collect('events', 'events'),
    metrics() {
      const out = {};
      for (const { meta, data } of sources.values()) if (meta.kind === 'metrics' && data) out[meta.id] = data.metrics;
      return out;
    },
    health: () => [...sources.values()].map(({ meta, status }) => ({ ...meta, ...status })),

    tracks: () => tracks,
    activeAlerts: () => active,
    addResolved(list) {
      if (list.length) resolved = [...list, ...resolved].slice(0, 100);
    },
    resolvedAlerts: () => resolved,

    setKpis(k) { kpis = k; },
    kpis: () => kpis,
    pushKpiSample(sample, max = 1440) {
      kpiHistory.push(sample);
      while (kpiHistory.length > max) kpiHistory.shift();
    },
    kpiHistory: () => kpiHistory,
  };
}

// Nunca exponemos claves de API que vayan en la URL.
function publicUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|app_id|app_key/i.test(k)) u.searchParams.set(k, '***');
    return u.toString();
  } catch {
    return null;
  }
}
