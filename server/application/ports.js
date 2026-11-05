// Puertos: los contratos que la aplicación necesita del exterior. Los adaptadores
// (adapters/outbound) los implementan y main.js los inyecta en los casos de uso. Los adaptadores
// de entrada (HTTP, planificador) sólo hablan con casos de uso; de los puertos, sólo usan el registro
// y las métricas.
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
 * @property {string} [page]                   Ficha pública del conjunto de datos, para enlazarla en vez de `url`.
 * @property {string} [paused]               Motivo por el que la fuente está en pausa: se registra y se cita en /legal,
 *                                              pero no se lee (sale como desactivada, con este motivo).
 * @property {string[]} [requires]             Variables de entorno necesarias (claves de API).
 * @property {Record<string, string>} [operatorLicenses]  Fuentes que agrupan a varios operadores: la atribución
 *                                              de cada uno, por el `operator` de sus vehículos, para citar sólo la suya.
 * @property {boolean} [cleanPositions]        Su licencia permite modificar los datos: se descartan sus posiciones
 *                                              repetidas o imposibles. Si no, se muestran tal cual.
 * @property {boolean} [onRailNetwork]         Sus trenes (ids `<id de la fuente>:…`) circulan por la red ferroviaria
 *                                              general y sus posiciones caen sobre ella: su recorrido reciente se
 *                                              dibuja por la vía (RailNetworkPort) y no con rectas.
 * @property {() => Promise<import('../domain/model.js').SourceResult>} fetch
 * @property {(vehicleId: string) => number[][]|null|undefined} [path]  Sólo fuentes de posiciones
 *   estimadas: tramo de trazado ([lon, lat]) que el vehículo ha recorrido según su horario, para
 *   dibujarlo por la calle. null = sin trazado; undefined = vehículo desconocido para la fuente.
 * @property {(vehicleId: string) => number[][]|null|undefined} [ahead]  Sólo fuentes de posiciones estimadas:
 *   lo que le queda al vehículo hasta su última parada ([lon, lat]), por su trazado o, sin él, uniendo sus
 *   paradas. null = no se sabe; undefined = vehículo desconocido para la fuente (como en `path`).
 * @property {string} [shapeNetwork]           Red de NetworkCatalogPort.lines() cuyos trazados (`shape` de cada
 *                                              vehículo, el shape_id de su GTFS) usan sus viajes.
 * @property {(vehicleId: string) => number[][]|null} [stopsAhead]  Con shapeNetwork: paradas que le quedan al
 *   vehículo ([lon, lat], en orden, la última su destino), para dibujar lo que le queda por el trazado de su
 *   viaje sin salirse de ellas (domain/route-ahead.js). null si no se saben.
 * @property {(vehicleId: string) => { gauge: 'standard'|'iberian'|null, stops: number[][]|null }|null|undefined} [railTrip]
 *   Sólo fuentes con onRailNetwork: ancho de vía por el que va el tren (null: cualquiera) y paradas que
 *   le quedan ([lon, lat], en orden, desde la próxima; null si no se saben), para dibujar por la vía su
 *   recorrido y lo que le queda hasta su destino. null = viaje desconocido; undefined = tren de otra fuente.
 * @property {(vehicleId: string) => import('../domain/trip-stops.js').TripStops|null|undefined} [tripStops]  Paradas del
 *   viaje del vehículo, del origen al destino, con su hora si se sabe y las que ya ha pasado (los vehículos llevan
 *   `stops`). null = no se saben; undefined = vehículo de otra fuente.
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
 * Trazado de una línea: una Feature GeoJSON de la colección de NetworkCatalogPort.lines().
 * @typedef {object} NetworkLine
 * @property {'Feature'} type
 * @property {{ type: 'LineString', coordinates: number[][] }} geometry  [lon, lat]: el trazado de los viajes con `shapes`.
 * @property {object} properties
 * @property {string} properties.network    Red a la que pertenece (la `shapeNetwork` de las fuentes).
 * @property {string} [properties.line]
 * @property {string} [properties.color]
 * @property {import('../domain/model.js').Mode} [properties.mode]
 * @property {string[]} [properties.shapes]  Trazados (shape_id de su GTFS) que dibuja: los viajes de las fuentes
 *   con `shapeNetwork` se buscan por «red + shape_id» (el `shape` de cada vehículo).
 */

/**
 * Red de líneas de metro, tranvía y Cercanías (trazados estáticos para pintar en el mapa).
 * @typedef {object} NetworkCatalogPort
 * @property {() => Promise<number>} load
 * @property {() => { type: 'FeatureCollection', features: NetworkLine[] }} lines
 *   Devuelve el MISMO objeto mientras no se recargue (load): query-situation usa su identidad para
 *   saber si los trazados han cambiado y tirar lo que calculó con los anteriores. Una recarga da otro.
 * @property {() => Array<{ name: string, credit: string, updated: number | null }>} sources
 *   De dónde sale el trazado de cada red: la atribución y la fecha de actualización que pide su licencia.
 */

/**
 * Red ferroviaria general (tramos de vía en servicio), para dibujar por la vía el recorrido de los
 * trenes de las fuentes con `onRailNetwork`. Se carga detrás, sin bloquear el arranque: mientras no
 * está (o si no se pudo descargar), `network()` da null y los recorridos se unen con rectas.
 * @typedef {object} RailNetworkPort
 * @property {() => Promise<number>} load  Lee la red (de disco o descargándola) y la prepara; devuelve cuántos tramos tiene.
 * @property {() => import('../domain/rail-match.js').RailNetwork | null} network
 *   Devuelve el MISMO objeto mientras no se recargue con otra red: query-situation usa su identidad
 *   para tirar los recorridos que calculó con la anterior.
 * @property {() => boolean} [pending]  true mientras se carga por primera vez (aún no se sabe si habrá red).
 * @property {string} [credit]  Atribución que pide su licencia, si lo que se dibuja con ella la necesita
 *   aparte (las vías del IGN, en las líneas que se rehacen por ellas).
 */

/**
 * Estado vivo del sistema (último dato de cada fuente, estelas, alertas, KPIs).
 * Lo que devuelven las lecturas es sólo para leer. Los recorridos y las alertas activas los cambian
 * las reglas del dominio, a través de `updateTracks` y `updateActiveAlerts`: el repositorio les da su
 * estado, las reglas lo actualizan y el repositorio lo guarda. En memoria es el mismo objeto; otro
 * almacén (Redis, Postgres) lo leería, lo pasaría a la función y guardaría lo que quede.
 * @typedef {object} SituationRepositoryPort
 * @property {(source: DataSourcePort, status: { enabled: boolean, reason?: string }) => void} registerSource
 * @property {(id: string, result: import('../domain/model.js').SourceResult, at: number, ms: number) => void} saveResult
 * @property {(id: string, error: Error, at: number) => void} saveFailure
 * @property {() => import('../domain/model.js').Vehicle[]} vehicles
 * @property {() => import('../domain/model.js').IncidentEvent[]} events
 * @property {() => Record<string, any>} metrics
 * @property {() => import('../domain/model.js').SourceHealth[]} health
 * @property {() => ReadonlyMap<string, readonly import('../domain/tracking.js').TrackPoint[]>} tracks
 * @property {<T>(update: (tracks: Map<string, import('../domain/tracking.js').TrackPoint[]>) => T) => T} updateTracks
 *   Un salto de posición retenido a la espera de la lectura siguiente (domain/tracking.js) va ligado a
 *   cada recorrido: un almacén que los reconstruya en cada llamada sólo perdería esa espera.
 * @property {() => ReadonlyMap<string, import('../domain/model.js').Alert>} activeAlerts
 * @property {<T>(update: (active: Map<string, import('../domain/model.js').Alert>) => T) => T} updateActiveAlerts
 * @property {(alerts: import('../domain/model.js').Alert[]) => void} addResolved
 * @property {() => import('../domain/model.js').Alert[]} resolvedAlerts
 * @property {(kpis: object) => void} setKpis
 * @property {() => object|null} kpis
 * @property {(sample: object, max: number) => void} pushKpiSample  max: muestras que se guardan como mucho; lo
 *   decide quien las toma (detect-alerts), sin otro tope por defecto en el almacén.
 * @property {() => object[]} kpiHistory  Una copia: cambiarla no cambia el histórico guardado.
 */

/**
 * Registro histórico append-only (alertas, KPIs) para análisis posterior.
 * @typedef {object} HistoryPort
 * @property {(stream: string, row: object) => Promise<void>} append  Nunca rechaza: si no puede escribir,
 *   lo registra y sigue (detect-alerts no espera a que termine).
 */

/**
 * Copia del historial de posiciones que sobrevive a un reinicio o a un despliegue (el caso de uso
 * keep-tracks). Durante un relevo hay dos servidores con la misma copia: cada uno la escribe de golpe,
 * y el que arranca lee la que dejó el otro.
 * @typedef {object} TrackStorePort
 * @property {() => Promise<object|null>} load  La última copia guardada, o null si no hay o no se lee.
 * @property {(snapshot: object) => Promise<void>} save  Nunca rechaza: si no puede escribir, lo registra.
 */

/**
 * Teselas y consultas de capas externas (IGN, EFFIS) servidas desde nuestro dominio para que
 * Cloudflare las guarde. Lo usa el caso de uso serve-tiles, que antes decide qué teselas se
 * pueden pedir (domain/tiles.js): el proveedor descarga y guarda en disco todo lo que se le pide.
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

/**
 * Métricas de funcionamiento, para la monitorización: sólo cuentas y tiempos agregados, nunca quién
 * pregunta (ni IPs ni rutas con lo que se ha pedido: `/api/stations/:code`, no el código).
 * @typedef {object} MetricsPort
 * @property {(r: { route: string, method: string, status: number, seconds: number }) => void} request
 *   Una petición HTTP atendida (o cortada por el cliente: status 499).
 * @property {(m: { method: string, tool?: string, era: 'moderna'|'antigua', result: string, seconds?: number }) => void} mcp
 *   Un mensaje al servidor MCP y cómo acabó (`ok`, `error_herramienta`, `ocupado`, `origen`…).
 * @property {(s: { source: string, ok: boolean, seconds: number }) => void} sourceRead  Una lectura de una fuente.
 * @property {(level: 'warn'|'error') => void} logged  Un aviso o un error en el registro.
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
  NetworkCatalog: ['load', 'lines', 'sources'],
  RailNetwork: ['load', 'network'],
  SituationRepository: ['registerSource', 'saveResult', 'saveFailure', 'vehicles', 'events', 'metrics', 'health',
    'tracks', 'updateTracks', 'activeAlerts', 'updateActiveAlerts', 'addResolved', 'resolvedAlerts', 'setKpis', 'kpis',
    'pushKpiSample', 'kpiHistory'],
  History: ['append'],
  TrackStore: ['load', 'save'],
  TileProvider: ['layers', 'cacheControl', 'tile', 'burntAreas'],
  Clock: ['now'],
  Logger: ['info', 'warn', 'error'],
  Metrics: ['request', 'mcp', 'sourceRead', 'logged'],
};
