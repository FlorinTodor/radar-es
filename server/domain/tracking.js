// Historial corto de posiciones por vehículo: base para detectar trenes detenidos,
// saltos de retraso y dibujar la estela en el mapa.
import { distanceKm } from './geo.js';

export const TRACK_WINDOW_MS = 45 * 60_000;

// Más rápido que esto entre dos posiciones no es un tren moviéndose: el operador ha pasado su
// identificador a otro convoy (en Renfe, el mismo número de tren sale en Oviedo y 20 s después en
// Infiesto, a 40 km). Los saltos cortos son ruido del GPS y no cuentan.
export const MAX_SPEED_KMH = 400;
export const MIN_JUMP_KM = 10;

/** ¿Es imposible pasar de `a` a `b` (puntos del historial) en el tiempo que hay entre ellos? */
export function isTeleport(a, b) {
  const km = distanceKm(a.lat, a.lon, b.lat, b.lon);
  if (km < MIN_JUMP_KM) return false;
  const hours = Math.max(b.t - (a.seen ?? a.t), 1000) / 3_600_000;
  return km / hours > MAX_SPEED_KMH;
}

/**
 * @typedef {{ t: number, lat: number, lon: number, delay: number|null, seen?: number }} TrackPoint
 * @param {Map<string, TrackPoint[]>} tracks
 * @param {import('./model.js').Vehicle[]} vehicles
 * @param {number} now
 */
export function recordPositions(tracks, vehicles, now, windowMs = TRACK_WINDOW_MS) {
  for (const v of vehicles) {
    let track = tracks.get(v.id);
    if (!track) tracks.set(v.id, (track = []));
    const last = track.at(-1);
    const point = { t: now, lat: v.lat, lon: v.lon, delay: v.delay };
    // Lo anterior a un salto imposible era otro viaje: no se une con una recta en el mapa ni se
    // compara su retraso con el de ahora (daría un «el retraso sube N min de golpe» falso).
    if (last && isTeleport(last, point)) track.length = 0;
    // Sólo se añade un punto si algo cambia; así "detenido" se mide como tiempo sin puntos nuevos.
    if (!track.length || last.lat !== v.lat || last.lon !== v.lon || last.delay !== v.delay) {
      track.push(point);
    } else {
      last.seen = now;
    }
  }
  for (const [id, track] of tracks) {
    while (track.length > 1 && now - track[0].t > windowMs) track.shift();
    const last = track.at(-1);
    if (now - (last.seen ?? last.t) > windowMs) tracks.delete(id);
  }
}

/** Momento desde el que el vehículo no se ha alejado más de `radiusKm` de su última posición. */
export function stationarySince(track, radiusKm) {
  const last = track.at(-1);
  let since = last.t;
  for (let i = track.length - 1; i >= 0; i--) {
    if (distanceKm(track[i].lat, track[i].lon, last.lat, last.lon) > radiusKm) break;
    since = track[i].t;
  }
  return since;
}
