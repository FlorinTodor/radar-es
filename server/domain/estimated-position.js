// Posición estimada de un vehículo a partir de su horario: dónde está, el tramo de su trazado que ha
// recorrido, lo que le queda, hacia dónde va y su próxima parada. Lógica pura: el adaptador de
// horarios (gtfs-horario.js) le da las paradas del viaje, su trazado y la hora, y aquí no se lee nada.
// Va aparte de schedule.js a propósito: la huella de schedule.js invalida los horarios guardados en
// disco, y cambiar cómo se estima la posición no cambia cómo se leen.
import { bearingDeg } from './geo.js';
import { pointAlong, scheduledPosition } from './schedule.js';

/** El mismo tramo que el recorrido de los vehículos con GPS. */
export const PATH_WINDOW_S = 45 * 60;
// Sin trazado, lo que le queda se dibuja uniendo paradas sólo en estos modos (paradas cercanas).
const STRAIGHT_AHEAD = new Set(['metro', 'tranvia', 'cercanias']);

/**
 * @typedef {{ shape: { coords: Float32Array, dist: Float32Array }, from: number, to: number, end: number }
 *   | { at: number[], stops: number[][] }} EstimatedPath
 *   Con trazado: tramo recorrido (`from`–`to`, en metros sobre él) y hasta dónde llega el viaje (`end`).
 *   Sin trazado: dónde está y las paradas que le quedan ([lon, lat]), unidas en línea recta.
 *
 * @param {{ stops: import('./schedule.js').ScheduledStop[], mode: import('./model.js').Mode,
 *           shape?: { coords: Float32Array, dist: Float32Array } | null, along?: number[] | null, t: number }} trip
 *   stops: paradas del viaje en orden; along: distancia sobre `shape` de cada parada (null si no tiene
 *   trazado o no encaja); t: segundos desde el inicio de su día de servicio.
 * @returns {null | { lat: number, lon: number, atLastStop: boolean, path: EstimatedPath | null | undefined,
 *   ahead: boolean, heading: number | null, current: string | null, next: string | null, nextArr: number | null }}
 *   null si a esa hora no circula. path: null para un autobús sin trazado (se queda en la última parada),
 *   undefined si no se dibuja (un tren de larga distancia sin trazado). nextArr: llegada programada a
 *   la próxima parada, en segundos del día de servicio.
 */
export function estimatePosition({ stops, mode, shape = null, along = null, t }) {
  const pos = scheduledPosition(stops, t);
  if (!pos) return null;
  let { lat, lon } = pos;
  let atLastStop = false;
  let path;
  // Distancia sobre el trazado: a la misma fracción del tramo entre paradas, pero medida sobre él.
  const alongAt = (p) => along[p.i] + ((along[p.i + 1] ?? along[p.i]) - along[p.i]) * p.k;
  if (along) {
    if (!pos.atStop) ({ lat, lon } = pointAlong(shape, alongAt(pos)));
    const before = scheduledPosition(stops, Math.max(t - PATH_WINDOW_S, stops[0].dep));
    path = { shape, from: before ? alongAt(before) : 0, to: alongAt(pos), end: along.at(-1) };
  } else if (mode === 'bus') {
    // Sin trazado, en línea recta un autobús interurbano cruzaría el campo: se deja en la última
    // parada por la que ha pasado. Los trenes sí siguen la recta (las vías suelen ser bastante rectas).
    if (!pos.atStop) {
      ({ lat, lon } = pos.prev);
      atLastStop = true;
    }
    path = null;
  } else if (STRAIGHT_AHEAD.has(mode)) {
    // Metro o tranvía sin trazado: va en línea recta entre paradas, como el mapa dibuja su red, y
    // lo que le queda también. Un tren de larga distancia no: entre ciudades la recta se sale de la vía.
    path = { at: [lon, lat], stops: stops.slice(pos.i + 1).map((s) => [s.lon, s.lat]) };
  }
  const ahead = path ? (path.stops ? path.stops.length > 0 : path.to < path.end) : false;
  // Hacia dónde va: por su recorrido, 100 m más allá. Con el rastro, cada cambio de retraso
  // (la posición retrocede o salta) giraría la flecha.
  let heading = null;
  if (path?.stops?.length) heading = bearingDeg(lat, lon, path.stops[0][1], path.stops[0][0]);
  else if (path?.shape && path.end - path.to > 20) {
    const q = pointAlong(path.shape, Math.min(path.to + 100, path.end));
    heading = bearingDeg(lat, lon, q.lat, q.lon);
  }
  return {
    lat,
    lon,
    atLastStop,
    path,
    ahead,
    heading,
    current: pos.atStop || atLastStop ? pos.prev.name : null,
    next: pos.atStop ? pos.next?.name ?? null : pos.next.name,
    nextArr: pos.next?.arr ?? null,
  };
}
