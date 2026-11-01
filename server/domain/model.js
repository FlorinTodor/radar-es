// Modelo del dominio. No importa nada de infraestructura: sólo tipos y reglas puras.

/**
 * @typedef {'av'|'ld'|'md'|'cercanias'|'metro'|'tranvia'|'bus'|'otros'} Mode
 * @typedef {'baja'|'media'|'alta'|'muy alta'} Severity
 * @typedef {'ferroviario'|'carretera'|'sismo'|'meteo'|'incendio'|'catastrofe'} EventCategory
 */

/**
 * Vehículo en circulación, normalizado desde cualquier operador.
 * @typedef {object} Vehicle
 * @property {string} id              Único entre fuentes (prefijado por operador).
 * @property {string} [source]        Id de la fuente que lo publicó.
 * @property {Mode} mode
 * @property {string} operator
 * @property {string} [service]       Producto comercial (AVE, Alvia, Cercanías...).
 * @property {string|null} line
 * @property {string} label           Número de tren o unidad.
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} delay      Minutos; null si la fuente no lo publica.
 * @property {boolean|null} [late]    Para fuentes que sólo dicen "en hora / con retraso".
 * @property {string|null} [origin]
 * @property {string|null} [destination]
 * @property {string|null} [current]
 * @property {boolean} [stopped]      Parado en `current` (si no, `current` es la última estación por la que pasó).
 * @property {string|null} [next]
 * @property {string|null} [nextEta]
 * @property {string|null} [platform] Vía de la estación en la que está parado o, si no, de la próxima.
 * @property {string|null} [shape]    Trazado (shape_id del GTFS de Cercanías o de Metro Bilbao) que sigue su viaje.
 * @property {[number, number]|null} [end]  Donde acaba su viaje ([lon, lat]): lo que le queda se dibuja hasta ahí.
 * @property {number|null} [fixTime]  Epoch ms del último GPS, si la fuente lo da.
 * @property {number} [farFromStop] Km entre la posición y la estación en la que la fuente dice que está parado, si pasa de 1,5: la posición no está al día.
 * @property {boolean} [estimated]    Posición calculada a partir del horario, no GPS. No cuenta para alertas ni KPIs.
 * @property {boolean} [ahead]        Posición estimada con recorrido hasta su final (/api/ahead/<id>).
 */

/**
 * Incidencia o suceso georreferenciado (aviso, accidente, terremoto...).
 * @typedef {object} IncidentEvent
 * @property {string} id
 * @property {string} [source]
 * @property {EventCategory} category
 * @property {string} type
 * @property {Severity} severity
 * @property {string} title
 * @property {string} [description]
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {number|null} [start]
 * @property {number|null} [end]
 * @property {{ type: 'Polygon'|'MultiPolygon', coordinates: number[][][]|number[][][][] }} [geometry]  Zona afectada (avisos).
 */

/**
 * Lo que devuelve una fuente en cada lectura.
 * @typedef {object} SourceResult
 * @property {Vehicle[]} [vehicles]
 * @property {IncidentEvent[]} [events]
 * @property {Record<string, unknown>} [metrics]
 * @property {number|null} [sourceTime]  Epoch ms de la última actualización según la fuente.
 * @property {number|null} [datasetUpdated]  Epoch ms en que la fuente actualizó el conjunto de datos estático
 *   (horario GTFS) del que se calcula el resultado. Lo exigen las licencias; no es la hora del dato.
 * @property {number|null} [datasetUpdatedFrom]  Si la fuente agrupa varios horarios: la fecha del más antiguo
 *   (datasetUpdated es entonces la del más reciente).
 */

/**
 * Alerta generada por el motor de reglas.
 * @typedef {object} Alert
 * @property {string} id           Estable mientras dure la situación.
 * @property {string} type
 * @property {Severity} severity
 * @property {string} title
 * @property {string} description
 * @property {number} [lat]
 * @property {number} [lon]
 * @property {string} [vehicleId]
 * @property {string[]} [vehicleIds]
 * @property {string[]} [eventIds]   Sucesos (avisos, terremotos, focos…) que motivan la alerta.
 * @property {number} [since]
 * @property {number} [updated]
 * @property {number} [resolvedAt]
 */

/**
 * @typedef {object} Station
 * @property {string} code
 * @property {string} name
 * @property {string|null} place
 * @property {number} lat
 * @property {number} lon
 * @property {string|null} [province]
 * @property {string|null} [address]
 * @property {string|null} [postalCode]
 * @property {boolean} [cercanias]
 * @property {boolean} [metricGauge]   Ancho métrico (antigua FEVE)
 * @property {boolean|null} [accessible] Accesible en silla de ruedas según el GTFS; null si no lo dice
 */

export const SEVERITY_RANK = { 'muy alta': 4, alta: 3, media: 2, baja: 1 };

/**
 * Vehículos que vigila el motor de alertas ferroviarias y que cuentan en los KPIs: trenes,
 * metros y tranvías con posición real. Las posiciones estimadas por horario, los autobuses
 * (que paran en cualquier sitio) se muestran pero no cuentan.
 */
export const RAIL_MODES = new Set(['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'otros']);
export const monitoredVehicles = (vehicles) => vehicles.filter((v) => !v.estimated && RAIL_MODES.has(v.mode));

export const MODES = ['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'bus', 'otros'];

/** @param {Vehicle} v */
export function vehicleLabel(v) {
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  return `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim();
}

// Retrasos imposibles: Renfe publica a veces, en los trenes que cruzan la medianoche, el retraso
// calculado contra el horario del día siguiente (-86.160 s = -1.436 min) u horas sin sentido
// (+1.008 min). No se corrigen (sería alterar el dato): se descartan como si no se publicaran.
export const DELAY_MIN = -60;      // más de una hora de adelanto
export const DELAY_MAX = 12 * 60;  // más de 12 horas de retraso

/** Retraso en minutos si es creíble; null si la fuente no lo da o es imposible. */
export function plausibleDelay(delay) {
  return Number.isFinite(delay) && delay >= DELAY_MIN && delay <= DELAY_MAX ? delay : null;
}

/**
 * Enlace externo que se puede mostrar: sólo http(s). Los feeds son de terceros y un
 * `javascript:` en un enlace se ejecutaría en nuestra web al pulsarlo.
 * @param {unknown} url @returns {string | null}
 */
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  try {
    const { protocol } = new URL(url.trim());
    return protocol === 'https:' || protocol === 'http:' ? url.trim() : null;
  } catch {
    return null;
  }
}
