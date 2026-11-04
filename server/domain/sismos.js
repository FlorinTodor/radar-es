// Terremotos de varias fuentes. Puro: sin red ni reloj.
import { distanceKm } from './geo.js';

/** Gravedad de un terremoto según su magnitud (la misma para todas las fuentes). */
export const quakeSeverity = (magnitude) =>
  magnitude >= 5 ? 'muy alta' : magnitude >= 4 ? 'alta' : magnitude >= 3 ? 'media' : 'baja';

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
