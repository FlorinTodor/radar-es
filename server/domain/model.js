// Modelo del dominio. No importa nada de infraestructura: sólo tipos y reglas puras.

/**
 * @typedef {'av'|'ld'|'md'|'cercanias'|'metro'|'tranvia'|'bus'|'avion'|'otros'} Mode
 * @typedef {'baja'|'media'|'alta'|'muy alta'} Severity
 * @typedef {'ferroviario'|'carretera'|'sismo'|'meteo'|'incendio'|'internet'|'catastrofe'} EventCategory
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
 * @property {string|null} [next]
 * @property {string|null} [nextEta]
 * @property {number|null} [fixTime]  Epoch ms del último GPS, si la fuente lo da.
 * @property {boolean} [estimated]    Posición calculada a partir del horario, no GPS. No cuenta para alertas ni KPIs.
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
 */

export const SEVERITY_RANK = { 'muy alta': 4, alta: 3, media: 2, baja: 1 };

/**
 * Vehículos que vigila el motor de alertas ferroviarias y que cuentan en los KPIs: trenes,
 * metros y tranvías con posición real. Las posiciones estimadas por horario, los autobuses
 * (que paran en cualquier sitio) y los aviones se muestran pero no cuentan.
 */
export const RAIL_MODES = new Set(['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'otros']);
export const monitoredVehicles = (vehicles) => vehicles.filter((v) => !v.estimated && RAIL_MODES.has(v.mode));

export const MODES = ['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'bus', 'avion', 'otros'];

/** @param {Vehicle} v */
export function vehicleLabel(v) {
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  return `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim();
}
