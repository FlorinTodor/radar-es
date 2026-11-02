// Estado vivo en memoria. Si en el futuro hace falta compartirlo entre procesos
// (varias réplicas, workers), se sustituye por otro adaptador (Redis, Postgres...)
// que implemente el mismo puerto SituationRepository: los casos de uso sólo leen lo que
// devuelve y cambian los recorridos y las alertas activas con updateTracks y updateActiveAlerts.

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
        meta: { id: src.id, name: src.name, kind: src.kind, interval: src.interval, license: src.license ?? null, operatorLicenses: src.operatorLicenses ?? null, url: publicUrl(src.page ?? src.url) },
        status: { enabled, reason: reason ?? null, ok: null, lastOk: null, lastError: null, error: null, count: null, sourceTime: null, datasetUpdated: null, datasetUpdatedFrom: null, datasetUpdatedBy: null, ms: null },
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
        datasetUpdatedFrom: result.datasetUpdatedFrom ?? null,
        datasetUpdatedBy: result.datasetUpdatedBy ?? null,
        count: (result.vehicles ?? result.events)?.length ?? null,
      });
    },

    saveFailure(id, error, at) {
      Object.assign(sources.get(id).status, { ok: false, lastError: at, error: publicError(error) });
    },

    vehicles: () => collect('vehicles', 'vehicles'),
    events: () => collect('events', 'events'),
    metrics() {
      const out = {};
      for (const { meta, data } of sources.values()) if (meta.kind === 'metrics' && data) out[meta.id] = data.metrics;
      return out;
    },
    health: () => [...sources.values()].map(({ meta, status }) => ({ ...meta, ...status })),

    // Los recorridos y las alertas activas salen sin copiar: se leen en cada consulta del directo y
    // copiarlos (miles de recorridos) costaría más que el cálculo. El puerto los da como ReadonlyMap:
    // sólo las reglas del dominio los cambian, a través de updateTracks y updateActiveAlerts.
    tracks: () => tracks,
    updateTracks: (update) => update(tracks),
    activeAlerts: () => active,
    updateActiveAlerts: (update) => update(active),
    addResolved(list) {
      if (list.length) resolved = [...list, ...resolved].slice(0, 100);
    },
    resolvedAlerts: () => resolved,

    setKpis(k) { kpis = k; },
    kpis: () => kpis,
    // El tope lo pone quien toma las muestras (detect-alerts, que sabe cada cuánto las toma): aquí no
    // hay otro por defecto que pueda quedarse distinto.
    pushKpiSample(sample, max) {
      kpiHistory.push(sample);
      while (kpiHistory.length > max) kpiHistory.shift();
    },
    // Una copia: quien la lea (las reglas, /api/kpis) no puede cambiar el histórico guardado.
    kpiHistory: () => kpiHistory.slice(),
  };
}

// El estado de las fuentes es público (/api/health): los errores salen sin rutas del servidor
// (un fallo de disco diría «/app/data/cache/…»). El detalle completo ya queda en el log.
function publicError(error) {
  return String(error?.message ?? error).replace(/(?<=^|[\s'"(])(?:file:\/\/)?\/(?:app|home|opt|root|srv|tmp|usr|var)\/[^\s'")]*/g, '[ruta interna]');
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
