// Registro de los tipos de vehículo (modos): el único sitio donde se dan de alta. Lo usa el servidor y le
// llega al cliente por /api/modes, para que lo nuevo (Mis trenes, puntualidad, el día en cifras, el bot)
// pinte nombres y filtros sin una lista propia. Para añadir un tipo (barco, avión…): una entrada aquí y un
// adaptador de fuente que dé ese `mode` y sus claves `follow` (ver domain/seguir.js y docs/vehiculos.md).
// Puro: sin red, ni reloj, ni disco.

/**
 * @typedef {'ferrocarril'|'carretera'|'agua'|'aire'|'otros'} ModeFamily
 * @typedef {object} ModeInfo
 * @property {import('./model.js').Mode} id
 * @property {string} label        Nombre en las capas y filtros («Alta velocidad», «Cercanías / Rodalies»).
 * @property {string} noun         Un vehículo de este tipo, en minúsculas («tren», «autobús»).
 * @property {string} nounPlural   Varios («trenes», «autobuses»).
 * @property {ModeFamily} family   Por dónde va: las reglas que dependen de eso miran la familia, no el id.
 * @property {boolean} [offByDefault]  Capa apagada hasta que se encienda (los autobuses taparían los trenes).
 */

/** @type {readonly ModeInfo[]} en el orden en que se enseñan */
export const MODES = Object.freeze([
  { id: 'av', label: 'Alta velocidad', noun: 'tren', nounPlural: 'trenes', family: 'ferrocarril' },
  { id: 'ld', label: 'Larga distancia', noun: 'tren', nounPlural: 'trenes', family: 'ferrocarril' },
  { id: 'md', label: 'Media distancia', noun: 'tren', nounPlural: 'trenes', family: 'ferrocarril' },
  { id: 'cercanias', label: 'Cercanías / Rodalies', noun: 'tren', nounPlural: 'trenes', family: 'ferrocarril' },
  { id: 'metro', label: 'Metro / urbano', noun: 'metro', nounPlural: 'metros', family: 'ferrocarril' },
  { id: 'tranvia', label: 'Tranvía', noun: 'tranvía', nounPlural: 'tranvías', family: 'ferrocarril' },
  { id: 'bus', label: 'Autobús', noun: 'autobús', nounPlural: 'autobuses', family: 'carretera', offByDefault: true },
  // Funiculares, teleféricos y monorraíles (route_type 5, 6, 7 y 12 del GTFS).
  { id: 'otros', label: 'Otros', noun: 'vehículo', nounPlural: 'vehículos', family: 'otros' },
].map((m) => Object.freeze(m)));

const BY_ID = new Map(MODES.map((m) => [m.id, m]));

/** Los datos de un modo; undefined si no está dado de alta. */
export const modeInfo = (id) => BY_ID.get(id);

/** ¿Está dado de alta este modo? */
export const isMode = (id) => BY_ID.has(id);

/** Los ids de los modos, en orden. */
export const modeIds = () => MODES.map((m) => m.id);

/** «tren», «autobús»… de un vehículo de este modo («vehículo» si no se conoce). */
export const modeNoun = (id, plural = false) => (plural ? BY_ID.get(id)?.nounPlural ?? 'vehículos' : BY_ID.get(id)?.noun ?? 'vehículo');
