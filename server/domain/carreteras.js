// Incidencias de tráfico. Puro: sin red ni reloj.

// Cada lectura de una fuente de tráfico sustituye a la anterior: la incidencia que su fuente deja de
// publicar sale del mapa en la lectura siguiente. Si la fuente deja de responder, lo último que publicó
// se muestra como mucho una hora más: sin noticias suyas, no se sabe si sigue.
export const ROAD_UNCONFIRMED_HOURS = 1;

/**
 * Hasta cuándo se muestra una incidencia de tráfico leída a la hora `seen` (su `expires`): hasta su
 * fin previsto, si la fuente lo da (`end`, las obras de la DGT), y una hora sin volver a leerla.
 * @param {number|null|undefined} end @param {number} seen @returns {number}
 */
export const roadExpires = (end, seen) =>
  Math.min(Number.isFinite(end) ? end : Infinity, seen + ROAD_UNCONFIRMED_HOURS * 3600_000);
