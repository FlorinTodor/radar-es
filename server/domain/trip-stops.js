// Paradas del viaje de un vehículo, para su ficha y el mapa: de dónde viene, por dónde pasa y adónde
// va, con la hora de cada una y si ya ha pasado por ella. Lógica pura: cada fuente da las paradas de
// sus viajes (de su horario o de su tiempo real) y aquí se arma la lista.
import { round5 } from './geo.js';

/**
 * @typedef {{ name: string, lon: number|null, lat: number|null, time: string|null, eta: string|null, passed: boolean, here?: true }} TripStop
 *   time: hora del horario («HH:MM», hora de Madrid); eta: la prevista con el retraso, sólo en las que
 *   le quedan y si es otra; lon/lat null si la fuente no sabe dónde está (sale en la lista, no en el mapa);
 *   here: está parado en ella ahora (ni pasada ni la próxima: la próxima es la siguiente).
 * @typedef {{ stops: TripStop[], partial: boolean }} TripStops
 *   partial: entre el origen y la parada siguiente de la lista puede haber otras que no se saben (FGC
 *   sólo da las que le quedan y la última en la que ha estado).
 */

/** Segundos del día de servicio → «HH:MM» (las que pasan de medianoche, «25:10:00», como «01:10»). */
export function clockOf(sec) {
  if (!Number.isFinite(sec)) return null;
  const min = Math.floor((((sec % 86_400) + 86_400) % 86_400) / 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/**
 * Índice de la primera parada por la que no ha pasado un vehículo con horario a la hora `t` (segundos
 * del día de servicio, en la hora de su horario): la parada en la que está o a la que va. Las mismas
 * reglas que su posición (schedule.js, scheduledPosition): en una parada hasta su hora de salida.
 * @param {Array<{ arr: number, dep: number }>} stops
 */
export function nextStopIndex(stops, t) {
  for (let i = 0; i < stops.length; i++) if (t <= stops[i].dep) return i;
  return stops.length;
}

/**
 * La lista de paradas de un viaje.
 * @param {Array<{ name?: string|null, at?: number[]|null, time?: number|null, eta?: string|null }>} stops
 *   en orden, del origen al destino; at: [lon, lat]; time: hora del horario en segundos del día de
 *   servicio; eta: la prevista que da el operador («HH:MM»), si la da
 * @param {number} next  índice de la primera parada por la que no ha pasado; -1 si no se sabe
 * @param {{ delaySec?: number|null, partial?: boolean, here?: boolean }} [opts]  delaySec: su retraso, para
 *   la hora prevista de las que le quedan cuando el operador no la da; here: está parado en la de `next`
 * @returns {TripStops|null}  null con menos de dos paradas
 */
export function tripStopList(stops, next, { delaySec = null, partial = false, here = false } = {}) {
  if (!stops || stops.length < 2) return null;
  const list = stops.map((s, i) => {
    const passed = next >= 0 && i < next;
    const time = clockOf(s.time ?? null);
    const fromDelay = Number.isFinite(s.time) && Number.isFinite(delaySec) && delaySec !== 0 ? clockOf(s.time + delaySec) : null;
    const eta = passed ? null : s.eta ?? fromDelay;
    const at = Array.isArray(s.at) && s.at.every(Number.isFinite) ? s.at : null;
    return {
      name: s.name || '?',
      lon: at ? round5(at[0]) : null,
      lat: at ? round5(at[1]) : null,
      time,
      eta: eta && eta !== time ? eta : null,
      passed,
      ...(here && i === next ? { here: true } : {}),
    };
  });
  return { stops: list, partial };
}
