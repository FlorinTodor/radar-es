// Demanda de los sistemas eléctricos aislados (cada isla o grupo de islas de Canarias, Ceuta y Melilla)
// que da e·sios: cómo se leen sus dos últimos datos para decir si un sistema está sin luz o si la ha
// recuperado. Lo usan la regla de los apagones de cada isla y los avisos oficiales de corte de luz.
// Puro: la métrica llega ya leída por su adaptador (esios.js).
import { SISTEMAS_AISLADOS } from './lugares.js';

// e·sios da un dato cada 5 minutos: dos con un hueco mayor entre ellos no son seguidos.
export const CONSECUTIVE_MS = 15 * 60_000;

/**
 * @typedef {object} GridSystem  Un sistema tal y como lo da la métrica (ver parseEsiosDemand).
 * @property {string} id
 * @property {number} real
 * @property {number|null} programmed
 * @property {number} [recentMax]  La mayor real de las dos últimas horas.
 * @property {number} [readMax]    La mayor real de todo lo leído (seis horas).
 * @property {{ real: number, at: number } | null} [previous]
 * @property {number} at
 *
 * @typedef {object} GridReading
 * @property {number} at          Hora del último dato.
 * @property {number} prevAt      Hora del anterior.
 * @property {number} worst       El mayor de los dos (para decir que está sin luz, los dos tienen que estarlo).
 * @property {number} best        El menor (para decir que la ha recuperado, también los dos).
 * @property {number} programmed  La programada para el último (0 si no hay).
 * @property {number} recent      Lo esperado: la programada o, si es mayor, lo que consumía en las dos últimas horas.
 * @property {number} before      Lo que consumía antes: lo mayor de todo lo leído y de lo esperado.
 */

/**
 * Los dos últimos datos de un sistema frente a lo esperado; null si no son fiables: el último pasa
 * de `staleMinutes` o no hay dos seguidos (uno suelto puede estar mal medido).
 * @param {GridSystem} s
 * @returns {GridReading|null}
 */
export function gridReading(s, now, staleMinutes) {
  if (!Number.isFinite(s?.real) || !s.at || now - s.at > staleMinutes * 60_000) return null;
  const prev = s.previous;
  if (!prev || !Number.isFinite(prev.real) || !(s.at - prev.at <= CONSECUTIVE_MS)) return null;
  const programmed = Number.isFinite(s.programmed) ? s.programmed : 0;
  const recent = Math.max(programmed, Number.isFinite(s.recentMax) ? s.recentMax : 0);
  return {
    at: s.at, prevAt: prev.at, worst: Math.max(s.real, prev.real), best: Math.min(s.real, prev.real),
    programmed, recent, before: Math.max(recent, Number.isFinite(s.readMax) ? s.readMax : 0),
  };
}

/**
 * El sistema ha recuperado la luz: sus dos últimos datos, fiables, pasan de `drop` (la mitad) de lo
 * que consumía en las seis horas leídas (`before`), no de lo esperado ahora: justo después de un
 * apagón la programada y las dos últimas horas están hundidas (el 2-11-2026 REE programó La Palma a
 * 0, 6,6 y 9 MW), y 6,8 MW frente a 9 parecería normal cuando la isla consume unos 30. Así puede
 * tardar en reconocer una luz que vuelve de noche (el valle frente al pico de horas antes): para eso
 * está el tope de un día de los cortes. Para abrir la alerta se sigue usando lo esperado (`recent`):
 * con `before` avisaría cada noche.
 * @param {GridReading|null} r
 */
export const gridHasPower = (r, drop) => Boolean(r) && r.before >= 1 && r.best / r.before > drop;

/** El sistema eléctrico que da luz a un lugar (una isla, Ceuta, Melilla); undefined si no es ninguno. */
export const gridOfPlace = (name) => SISTEMAS_AISLADOS.find((p) => p.places.includes(name));
