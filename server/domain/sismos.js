// Terremotos de varias fuentes. Puro: sin red ni reloj.
import { distanceKm } from './geo.js';

/** Gravedad de un terremoto según su magnitud (la misma para todas las fuentes). */
export const quakeSeverity = (magnitude) =>
  magnitude >= 5 ? 'muy alta' : magnitude >= 4 ? 'alta' : magnitude >= 3 ? 'media' : 'baja';

/** Magnitud mínima de los terremotos del mapa, de todas las fuentes. Los más pequeños no se sienten. */
export const MIN_QUAKE_MAGNITUDE = 1.5;

const PENINSULA = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
const CANARIAS = new Intl.DateTimeFormat('es-ES', { timeZone: 'Atlantic/Canary', dateStyle: 'short', timeStyle: 'short' });
const inCanarias = (lat, lon) => lat >= 26.5 && lat <= 30.5 && lon >= -19.5 && lon <= -12.5;

/** La fecha y hora de un terremoto para su descripción: la de Canarias si es allí, y si no la peninsular. */
export const quakeWhen = (start, lat, lon) =>
  (inCanarias(lat, lon) ? `${CANARIAS.format(start)} (hora de Canarias)` : PENINSULA.format(start));

// Cuánto se muestra un terremoto: dos días. Las fuentes traen los de diez y el mapa se llenaba de los de
// la semana pasada. Con `expires` sale también del mapa aunque su fuente deje de responder.
export const QUAKE_SHOWN_HOURS = 48;
export const quakeExpires = (start) => start + QUAKE_SHOWN_HOURS * 3600_000;

// El mismo terremoto en dos fuentes: la hora de origen difiere en segundos y el epicentro, en unos
// kilómetros (cada centro lo calcula con sus estaciones). Dos terremotos distintos tan juntos en el
// tiempo y en el espacio son, a efectos del mapa, el mismo.
const SAME_MS = 90_000;
const SAME_KM = 50;

/**
 * Quita los terremotos de una fuente de respaldo (`backup`, como el EMSC) que ya publica la fuente
 * principal (el IGN): así no sale dos veces el mismo ni da dos alertas. Los demás sucesos, tal cual.
 * @param {import('./model.js').Event[]} events
 */
export function withoutRepeatedQuakes(events) {
  if (!events.some((e) => e.category === 'sismo' && e.backup)) return events;
  const main = events.filter((e) => e.category === 'sismo' && !e.backup && e.start && e.lat !== undefined);
  return events.filter((e) => !(e.category === 'sismo' && e.backup && main.some((m) =>
    Math.abs(m.start - e.start) <= SAME_MS && distanceKm(m.lat, m.lon, e.lat, e.lon) <= SAME_KM)));
}
