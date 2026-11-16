// Un vehículo con GPS sobre el trazado de su viaje: dónde está a lo largo de él, por dónde ha ido y lo que le queda.
// Para los que publican en su tiempo real qué viaje hacen y ese viaje trae trazado en su horario (autobuses de
// AUVASA, EMT Málaga, EMT Fuenlabrada y de Euskadi): su recorrido y lo que les queda van por la calle o la carretera
// del trazado del operador, en vez de unir sus posiciones con rectas que cruzan manzanas. Puro: sin red, ni reloj, ni
// disco; los trazados son los de schedule.js (buildShape: coords y distancias en Float32Array).
import { pointAlong } from './schedule.js';
import { bearingDeg, M_PER_DEG_LAT, mPerDegLon, round5 } from './geo.js';

/**
 * Más lejos que esto del trazado no está sobre él (un desvío, un GPS que salta o un viaje que aún no ha empezado): no
 * se pega a él. El mismo margen que el de las paradas (stopsAlongShape): hay trazados muy toscos (los de EMT
 * Fuenlabrada, unos 27 puntos para 13 km), y en una curva el autobús queda a 200 m de la recta aunque vaya por su calle.
 */
export const MAX_OFF_SHAPE_M = 300;
/** Entre una lectura y la siguiente (un minuto, o unos pocos si falla alguna), hasta aquí hacia delante. */
const FORWARD_WINDOW_M = 8000;
/** Unos metros hacia atrás se aceptan: el GPS no es exacto y un autobús parado baila. */
const BACKWARD_SLACK_M = 60;

/**
 * La proyección más cercana de un punto sobre el trazado entre las distancias `from` y `to` (metros desde el inicio).
 * @returns {{ along: number, off: number } | null}  off: metros del punto al trazado
 */
export function nearestAlong(shape, lon, lat, from = 0, to = Infinity) {
  const { coords, dist } = shape;
  const kx = mPerDegLon(lat);
  let best = null;
  for (let i = 0; i + 1 < dist.length; i++) {
    if (dist[i + 1] < from || dist[i] > to) continue;
    const ax = (coords[i * 2] - lon) * kx;
    const ay = (coords[i * 2 + 1] - lat) * M_PER_DEG_LAT;
    const bx = (coords[i * 2 + 2] - lon) * kx;
    const by = (coords[i * 2 + 3] - lat) * M_PER_DEG_LAT;
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const u = len2 ? Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / len2)) : 0;
    const off = Math.hypot(ax + (bx - ax) * u, ay + (by - ay) * u);
    const along = Math.min(to, Math.max(from, dist[i] + (dist[i + 1] - dist[i]) * u));
    if (!best || off < best.off) best = { along, off };
  }
  return best;
}

/**
 * Dónde está ahora sobre el trazado, sabiendo dónde estaba (`prev`, o null): primero hacia delante desde allí (así una
 * línea circular o de ida y vuelta por la misma calle no salta a la otra pasada) y, si ahí no está, en todo el trazado
 * (un viaje que se ha empezado a seguir a medias, o un GPS que se había ido lejos). null si está lejos del trazado.
 * @returns {{ along: number, off: number, restart: boolean } | null}  restart: no sigue a `prev` (empieza otro tramo)
 */
export function progressOnShape(shape, lon, lat, prev = null) {
  if (Number.isFinite(prev)) {
    const ahead = nearestAlong(shape, lon, lat, Math.max(0, prev - BACKWARD_SLACK_M), prev + FORWARD_WINDOW_M);
    if (ahead && ahead.off <= MAX_OFF_SHAPE_M) return { ...ahead, along: Math.max(ahead.along, prev), restart: false };
  }
  const any = nearestAlong(shape, lon, lat);
  return any && any.off <= MAX_OFF_SHAPE_M ? { ...any, restart: Number.isFinite(prev) } : null;
}

/**
 * Hacia dónde va por el trazado en `along` (grados desde el norte, como headingOf): hacia el punto que está `ahead`
 * metros más allá. null al final del viaje (ya no va a ningún sitio).
 */
export function headingOnShape(shape, along, ahead = 60) {
  const end = shape.dist[shape.dist.length - 1];
  if (!(end - along > 10)) return null;
  const a = pointAlong(shape, along);
  const b = pointAlong(shape, Math.min(along + ahead, end));
  return bearingDeg(a.lat, a.lon, b.lat, b.lon);
}

/** El tramo del trazado entre dos distancias, como [lon, lat] (redondeados a 5 decimales, ~1 m); null si no hay tramo. */
export function shapeStretch(shape, from, to) {
  const { coords, dist } = shape;
  const end = dist[dist.length - 1];
  const a = Math.max(0, Math.min(from, end));
  const b = Math.max(0, Math.min(to, end));
  if (!(b > a)) return null;
  const at = (d) => {
    const p = pointAlong(shape, d);
    return [round5(p.lon), round5(p.lat)];
  };
  const out = [at(a)];
  for (let i = 0; i < dist.length; i++) if (dist[i] > a && dist[i] < b) out.push([round5(coords[i * 2]), round5(coords[i * 2 + 1])]);
  out.push(at(b));
  return out;
}

/**
 * Las posiciones de su recorrido reciente sobre el trazado de su viaje: de dónde a dónde ha ido por él (metros desde el
 * inicio). Cada posición se busca hacia delante desde la anterior; una que se sale del trazado (un desvío) corta, y lo
 * que sigue empieza de nuevo. null si la última no está sobre el trazado: entonces no se pega a él (se dibujan sus
 * posiciones tal cual y no se sabe lo que le queda).
 * @param {{ coords: Float32Array, dist: Float32Array }} shape
 * @param {Array<{ lon: number, lat: number }>} track  de la más vieja a la más nueva
 * @returns {{ from: number, to: number } | null}
 */
export function trackOnShape(shape, track) {
  let prev = null;
  let start = null;
  for (const p of track ?? []) {
    const at = progressOnShape(shape, p.lon, p.lat, prev);
    if (!at) {
      prev = null;
      start = null;
      continue;
    }
    if (at.restart || start === null) start = at.along;
    prev = at.along;
  }
  return prev === null ? null : { from: start, to: prev };
}
