// Historial corto de posiciones por vehículo: base para detectar trenes detenidos,
// saltos de retraso y dibujar la estela en el mapa.
import { bearingDeg, distanceKm } from './geo.js';

export const TRACK_WINDOW_MS = 45 * 60_000;

// Más rápido que esto entre dos posiciones no es un tren moviéndose: el operador ha pasado su
// identificador a otro convoy (en Renfe, el mismo número de tren sale en Oviedo y 20 s después en
// Infiesto, a 40 km). Los saltos cortos son ruido del GPS y no cuentan. El tiempo se mide con la
// hora del GPS si la fuente la da: en un túnel largo (Guadarrama, 28 km) la fuente puede repetir la
// última posición durante minutos, y al salir no es un salto.
export const MAX_SPEED_KMH = 400;
export const MIN_JUMP_KM = 10;
// Un salto imposible pero corto (Renfe: 2,5 km en 20 s y vuelta atrás) es un punto suelto erróneo o
// la fuente poniéndose al día: lo dice el punto siguiente. Por debajo de esto, el ruido del GPS.
const MIN_SPIKE_KM = 0.5;
const HOLD_MAX_MS = 2 * 60_000;
// Un Cercanías no pasa de 160 km/h: Renfe da a veces saltos atrás de 1,5 km en 17 s (313 km/h), que
// para un AVE serían posibles. Los demás modos, con el límite general.
const SPIKE_KMH = { cercanias: 200 };
// Renfe vuelve a veces a dar, exacta, una posición de hace un momento tras otra a cientos de metros
// (A, B, B, A, B, B…; medido en 1 de cada 10 Cercanías): es una posición vieja repetida.
const ECHO_MS = 10 * 60_000;
const ECHO_BACK = 4;
// Renfe también da a veces una posición de cientos de metros o kilómetros por detrás, a velocidad
// posible (C2 en Madrid: 1,7 km atrás en 81 s y luego 2,8 km adelante): contra el sentido en que iba
// el tren y más lejos que esto, se retiene como un salto imposible hasta ver el punto siguiente.
const BACK_KM = 0.4;
const BACK_DEG = 150;

const tooFast = (a, b, km, maxKmh = MAX_SPEED_KMH) => km / (Math.max(a.fix && b.fix ? b.fix - a.fix : b.t - (a.seen ?? a.t), 1000) / 3_600_000) > maxKmh;

/** ¿Es imposible pasar de `a` a `b` (puntos del historial) en el tiempo que hay entre ellos? */
export function isTeleport(a, b) {
  const km = distanceKm(a.lat, a.lon, b.lat, b.lon);
  return km >= MIN_JUMP_KM && tooFast(a, b, km);
}

/** ¿Es `b` un salto imposible desde `a` (para un vehículo de ese modo), pero demasiado corto para ser otro viaje? */
export function isSpike(a, b, mode) {
  const km = distanceKm(a.lat, a.lon, b.lat, b.lon);
  return km >= MIN_SPIKE_KM && km < MIN_JUMP_KM && tooFast(a, b, km, SPIKE_KMH[mode]);
}

/** ¿Repite `p` exacta una de las últimas posiciones del historial, después de haber estado en otra? */
export function isEcho(track, p, now) {
  for (let j = track.length - 2; j >= Math.max(0, track.length - 1 - ECHO_BACK); j--) {
    const q = track[j];
    if (now - (q.seen ?? q.t) > ECHO_MS) break;
    if (q.lat === p.lat && q.lon === p.lon) return track.slice(j + 1).some((r) => distanceKm(r.lat, r.lon, q.lat, q.lon) > 0.05);
  }
  return false;
}

const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** ¿Va `b` hacia atrás desde `a`, más de BACK_KM y contra `heading` (hacia dónde se movía el vehículo)? */
export function isBackJump(a, b, heading) {
  if (heading === null || heading === undefined || distanceKm(a.lat, a.lon, b.lat, b.lon) < BACK_KM) return false;
  return angleDiff(heading, bearingDeg(a.lat, a.lon, b.lat, b.lon)) > BACK_DEG;
}

const held = new WeakMap(); // historial → { point, since }: salto corto a la espera del punto siguiente

/**
 * @typedef {{ t: number, lat: number, lon: number, delay: number|null, seen?: number }} TrackPoint
 * @param {Map<string, TrackPoint[]>} tracks
 * @param {import('./model.js').Vehicle[]} vehicles
 * @param {number} now
 * @param {{ windowMs?: number, clean?: boolean }} [options]  clean: descartar las posiciones repetidas o
 *   imposibles. Sólo si la licencia de la fuente permite modificar sus datos (Renfe, CC BY 4.0, indicándolo):
 *   otras piden expresamente que el contenido no se altere (Open Data Euskadi) o se publican «en bruto».
 */
export function recordPositions(tracks, vehicles, now, { windowMs = TRACK_WINDOW_MS, clean = false } = {}) {
  for (const v of vehicles) {
    let track = tracks.get(v.id);
    if (!track) tracks.set(v.id, (track = []));
    const last = track.at(-1);
    const point = { t: now, lat: v.lat, lon: v.lon, delay: v.delay, ...(v.fixTime ? { fix: v.fixTime } : {}) };
    const pending = held.get(track);
    held.delete(track);
    // Una posición repetida o un salto corto imposible: el vehículo se queda donde estaba (ni el
    // mapa, ni la estela, ni la flecha van y vienen). El salto se retiene: si el siguiente punto
    // sigue desde él, la fuente se estaba poniendo al día y valen los dos; si vuelve, se descarta.
    // Cambia la posición del vehículo: quien guarda el resultado lo hace después.
    const stay = () => {
      v.lat = last.lat;
      v.lon = last.lon;
      last.seen = now;
    };
    // Las posiciones estimadas las calcula el radar con el horario: si retroceden (sube el retraso) es a propósito.
    const gps = clean && !v.estimated;
    // La fuente dice que está parado en una estación que queda lejos de esta posición: la posición no
    // está al día (Renfe deja a veces de renovarla durante minutos mientras el tren sigue) o es de
    // relleno (a veces, la del origen del viaje). Se queda donde estaba.
    if (gps && last && v.farFromStop) {
      stay();
      continue;
    }
    if (gps && last && isEcho(track, point, now)) {
      stay();
      continue;
    }
    const heading = gps && last ? headingOf(track) : null;
    const odd = gps && last && (isSpike(last, point, v.mode) || isBackJump(last, point, heading));
    if (odd && !(pending && now - pending.since > HOLD_MAX_MS)) {
      const from = pending?.point;
      // El punto sigue desde el retenido si se puede llegar a él desde allí y le queda más cerca que
      // donde estaba el tren; si vuelve hacia allí, el retenido era un punto suelto.
      const follows = from && !isSpike(from, point, v.mode)
        && distanceKm(from.lat, from.lon, point.lat, point.lon) < Math.min(MIN_JUMP_KM, distanceKm(last.lat, last.lon, point.lat, point.lon));
      if (!follows) {
        held.set(track, { point, since: pending?.since ?? now });
        stay();
        continue;
      }
      // El salto era de verdad. Hacia delante, la fuente se estaba poniendo al día: se unen. Hacia
      // atrás, o desde la primera posición del viaje con horas de GPS que lo hacen imposible, lo que
      // estaba mal era lo de antes (Renfe da a veces, al empezar un viaje, la posición de otra
      // estación: un C3 «en Atocha» y 20 s después en El Casar, a 10 km): el recorrido empieza ahí.
      const firstWrong = track.length === 1 && last.fix && from.fix && isSpike(last, from, v.mode);
      if (firstWrong || isBackJump(last, from, heading)) track.length = 0;
      track.push(from);
    }
    // Lo anterior a un salto imposible era otro viaje: no se une con una recta en el mapa ni se
    // compara su retraso con el de ahora (daría un «el retraso sube N min de golpe» falso).
    if (last && isTeleport(last, point)) track.length = 0;
    // Sólo se añade un punto si algo cambia; así "detenido" se mide como tiempo sin puntos nuevos.
    const tail = track.at(-1);
    if (!tail || tail.lat !== v.lat || tail.lon !== v.lon || tail.delay !== v.delay) {
      track.push(point);
    } else {
      tail.seen = now;
      // Misma posición con GPS nuevo: el tren sigue ahí de verdad. Si la hora no cambia, la fuente
      // está repitiendo la última posición conocida (un túnel) y se queda la de entonces.
      if (v.fixTime && v.fixTime > (tail.fix ?? 0)) tail.fix = v.fixTime;
    }
  }
  for (const [id, track] of tracks) {
    while (track.length > 1 && now - track[0].t > windowMs) track.shift();
    const last = track.at(-1);
    if (now - (last.seen ?? last.t) > windowMs) tracks.delete(id);
  }
}

/**
 * Hacia dónde va un vehículo (grados desde el norte, de 5 en 5): de la primera posición de los últimos
 * `windowMs` que está a más de `minKm` de la actual, hasta la actual. Con varios minutos, un punto suelto
 * que la fuente da atrasado (Renfe, a veces cientos de metros) no la gira. Si en ese rato no se ha movido
 * (parado en una estación), de la última posición alejada: sigue mirando hacia donde iba.
 * null si no se ha movido lo bastante.
 */
export function headingOf(track, minKm = 0.15, windowMs = 3 * 60_000) {
  const last = track?.at(-1);
  if (!last) return null;
  const far = (p) => distanceKm(p.lat, p.lon, last.lat, last.lon) >= minKm;
  let from = null;
  for (let i = track.length - 2; i >= 0 && last.t - track[i].t <= windowMs; i--) if (far(track[i])) from = track[i];
  for (let i = track.length - 2; i >= 0 && !from; i--) if (far(track[i])) from = track[i];
  return from ? bearingDeg(from.lat, from.lon, last.lat, last.lon) : null;
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
