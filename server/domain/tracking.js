// Historial corto de posiciones por vehículo: base para detectar trenes detenidos,
// saltos de retraso y dibujar la estela en el mapa.
import { distanceKm } from './geo.js';

export const TRACK_WINDOW_MS = 45 * 60_000;

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
    // Sólo se añade un punto si algo cambia; así "detenido" se mide como tiempo sin puntos nuevos.
    if (!last || last.lat !== v.lat || last.lon !== v.lon || last.delay !== v.delay) {
      track.push({ t: now, lat: v.lat, lon: v.lon, delay: v.delay });
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
