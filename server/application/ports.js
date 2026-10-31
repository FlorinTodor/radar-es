// Puertos: los contratos que la aplicación necesita del exterior. Los adaptadores
// (adapters/outbound) los implementan y main.js los inyecta en los casos de uso.
// JavaScript no tiene interfaces, así que se documentan con JSDoc y se comprueban
// en el arranque con `assertPort`.

/**
 * Fuente de datos externa (Renfe, DGT, IGN...).
 * @typedef {object} DataSourcePort
 * @property {string} id
 * @property {string} name
 * @property {'vehicles'|'events'|'metrics'} kind
 * @property {number} interval                 ms entre lecturas.
 * @property {string} [license]
 * @property {string} [url]
 * @property {string[]} [requires]             Variables de entorno necesarias (claves de API).
 * @property {() => Promise<import('../domain/model.js').SourceResult>} fetch
 * @property {(vehicleId: string) => number[][]|null|undefined} [path]  Sólo fuentes de posiciones
 *   estimadas: tramo de trazado ([lon, lat]) que el vehículo ha recorrido según su horario, para
 *   dibujarlo por la calle. null = sin trazado; undefined = vehículo desconocido para la fuente.
 */

/**
 * Catálogo de estaciones.
 * @typedef {object} StationCatalogPort
 * @property {() => Promise<number>} load
 * @property {(code: string) => import('../domain/model.js').Station | undefined} get
 * @property {(code: string) => string|null} name
 * @property {(lat: number, lon: number, maxKm?: number) => { station: import('../domain/model.js').Station, km: number } | null} nearest
 * @property {() => import('../domain/model.js').Station[]} all
 */

/**
 * Red de líneas de metro, tranvía y Cercanías (trazados estáticos para pintar en el mapa).
 * @typedef {object} NetworkCatalogPort
 * @property {() => Promise<number>} load
 * @property {() => { type: 'FeatureCollection', features: object[] }} lines
 */

/**
 * Estado vivo del sistema (último dato de cada fuente, estelas, alertas, KPIs).
 * @typedef {object} SituationRepositoryPort
 * @property {(source: DataSourcePort, status: { enabled: boolean, reason?: string }) => void} registerSource
 * @property {(id: string, result: import('../domain/model.js').SourceResult, at: number, ms: number) => void} saveResult
 * @property {(id: string, error: Error, at: number) => void} saveFailure
 * @property {(id: string) => { meta: object, status: object, data: object|null } | undefined} source
 * @property {() => import('../domain/model.js').Vehicle[]} vehicles
 * @property {() => import('../domain/model.js').IncidentEvent[]} events
 * @property {() => Record<string, any>} metrics
 * @property {() => object[]} health
 * @property {() => Map<string, import('../domain/tracking.js').TrackPoint[]>} tracks
 * @property {() => Map<string, import('../domain/model.js').Alert>} activeAlerts
 * @property {(alerts: import('../domain/model.js').Alert[]) => void} addResolved
 * @property {() => import('../domain/model.js').Alert[]} resolvedAlerts
 * @property {(kpis: object) => void} setKpis
 * @property {() => object|null} kpis
 * @property {(sample: object) => void} pushKpiSample
 * @property {() => object[]} kpiHistory
 */

/**
 * Registro histórico append-only (alertas, KPIs) para análisis posterior.
 * @typedef {object} HistoryPort
 * @property {(stream: string, row: object) => Promise<void>} append
 */

/**
 * Bus de eventos de aplicación: lo usan los adaptadores de entrada (SSE) para empujar cambios.
 * @typedef {object} EventPublisherPort
 * @property {(topic: string, payload?: object) => void} publish
 * @property {(topic: string, handler: (payload: any) => void) => () => void} subscribe
 */

/**
 * Teselas y consultas de capas externas (IGN, EFFIS) servidas desde nuestro dominio para que
 * Cloudflare las guarde: lo usa el adaptador HTTP.
 * @typedef {object} TileProviderPort
 * @property {string[]} layers
 * @property {(layer: string) => string} cacheControl
 * @property {(layer: string, z: number, x: number, y: number) => Promise<Uint8Array | null>} tile
 * @property {(bbox: [number, number, number, number]) => Promise<object>} burntAreas
 */

/**
 * @typedef {object} ClockPort
 * @property {() => number} now
 *
 * @typedef {object} LoggerPort
 * @property {(msg: string) => void} info
 * @property {(msg: string) => void} warn
 * @property {(msg: string) => void} error
 */

/** Comprueba en el arranque que un adaptador cumple el puerto. */
export function assertPort(name, impl, members) {
  const missing = members.filter((m) => impl?.[m] === undefined);
  if (missing.length) throw new TypeError(`${name} no implementa: ${missing.join(', ')}`);
  return impl;
}

export const PORT_MEMBERS = {
  DataSource: ['id', 'name', 'kind', 'interval', 'fetch'],
  StationCatalog: ['load', 'get', 'name', 'nearest', 'all'],
  NetworkCatalog: ['load', 'lines'],
  SituationRepository: ['registerSource', 'saveResult', 'saveFailure', 'source', 'vehicles', 'events', 'metrics', 'health',
    'tracks', 'activeAlerts', 'addResolved', 'resolvedAlerts', 'setKpis', 'kpis', 'pushKpiSample', 'kpiHistory'],
  History: ['append'],
  EventPublisher: ['publish', 'subscribe'],
  TileProvider: ['layers', 'cacheControl', 'tile', 'burntAreas'],
};
