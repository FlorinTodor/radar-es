// «Siguiendo»: cómo está ahora lo que alguien sigue (un servicio, una línea o una parada; ver domain/seguir.js)
// con lo que el radar ve: sus vehículos y las incidencias que llevan su clave (cancelaciones, trenes sin datos y
// lo que llegue con `follow`). Vale para cualquier tipo de vehículo, de hoy o de mañana (barcos, aviones…):
// sólo mira las claves y el registro de tipos (domain/modos.js), nunca de qué fuente viene cada cosa.
// Puro: sin red, ni reloj, ni disco. El navegador también lo usa (lo sirve el servidor tal cual, como
// seguir.js y modos.js): por eso sólo importa módulos que se pueden servir al navegador.
import { describeFollow, followKind, parseFollowKey } from './seguir.js';
import { modeInfo } from './modos.js';

/** Minutos de retraso a partir de los que un vehículo va «con retraso», como en los indicadores (domain/kpis.js). */
export const FOLLOW_DELAYED_MIN = 5;
/** Como mucho, cuántos vehículos y cuántas incidencias se dan de cada cosa seguida (una línea puede tener cientos). */
export const FOLLOW_LIST_MAX = 20;

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const keysOf = (list) => (Array.isArray(list) ? list : typeof list === 'string' ? [list] : []);

/**
 * Lo que se sabe de un vehículo, del viaje de una incidencia o de una estación para nombrar una de sus
 * claves con describeFollow. Cada clave con lo suyo: el viaje juntado de dos feeds (domain/cancelaciones.js,
 * mergeSameTrain) tiene dos líneas y su `line` es sólo una, así que la línea sale de la clave cuando se puede leer.
 * @param {string} key
 * @param {{ mode?: string, operator?: string, service?: string|null, line?: string|null, label?: string|null,
 *           number?: string|null, origin?: string|null, area?: string|null, name?: string|null }|null} subject
 */
export function knownFor(key, subject) {
  const parsed = parseFollowKey(key);
  if (!parsed || !subject) return {};
  if (parsed.kind === 'parada') return subject.name ? { name: subject.name } : {};
  const info = modeInfo(subject.mode);
  const known = { ...(subject.operator ? { operator: subject.operator } : {}), ...(info ? { modeLabel: capitalize(info.noun) } : {}) };
  if (parsed.kind === 'linea') {
    if (!parsed.parts.length) return { ...known, ...(subject.service ? { service: subject.service } : {}) };
    const line = parsed.parts.at(-1) ?? subject.line ?? null;
    const own = line !== null && line === subject.line;
    return {
      ...known,
      ...(line !== null ? { line } : {}),
      // El producto (Cercanías, Avant…) y el núcleo sólo si son de esta línea.
      ...(own && subject.service ? { service: subject.service } : {}),
      ...(own && parsed.parts.length > 1 && subject.area ? { area: subject.area } : {}),
    };
  }
  return {
    ...known,
    ...(subject.service ? { service: subject.service } : {}),
    ...(subject.line ? { line: subject.line } : {}),
    ...(subject.number ?? subject.label ? { number: subject.number ?? subject.label } : {}),
    ...(subject.origin ? { origin: subject.origin } : {}),
  };
}

/** El nombre de una clave con lo que se sabe de quien la lleva («Avant 08058», «Autobús 27 · EMT Málaga»). */
export const followName = (key, subject) => describeFollow(key, knownFor(key, subject));

/**
 * Los vehículos y las incidencias de cada clave, para responder a cada consulta sin recorrerlo todo.
 * @param {import('./model.js').Vehicle[]} vehicles
 * @param {import('./model.js').IncidentEvent[]} events
 * @returns {Map<string, { vehicles: import('./model.js').Vehicle[], events: import('./model.js').IncidentEvent[] }>}
 */
export function indexByFollow(vehicles, events) {
  const index = new Map();
  const slot = (key) => {
    let s = index.get(key);
    if (!s) index.set(key, (s = { vehicles: [], events: [] }));
    return s;
  };
  for (const v of vehicles) for (const key of new Set(keysOf(v.follow))) slot(key).vehicles.push(v);
  for (const e of events) for (const key of new Set([...keysOf(e.follow), ...keysOf(e.trip?.follow)])) slot(key).events.push(e);
  return index;
}

const isDelayed = (v) => (Number.isFinite(v.delay) ? v.delay >= FOLLOW_DELAYED_MIN : v.late === true);
const hasDelayInfo = (v) => Number.isFinite(v.delay) || typeof v.late === 'boolean';

const vehicleOut = (v) => ({
  id: v.id, source: v.source ?? null, mode: v.mode, operator: v.operator ?? null, service: v.service ?? null, line: v.line ?? null,
  label: v.label ?? null, delay: Number.isFinite(v.delay) ? v.delay : null, ...(typeof v.late === 'boolean' ? { late: v.late } : {}),
  origin: v.origin ?? null, destination: v.destination ?? null, current: v.current ?? null, next: v.next ?? null,
  ...(v.stopped ? { stopped: true } : {}), ...(v.estimated ? { estimated: true } : {}),
});
const eventOut = (e) => ({
  id: e.id, source: e.source ?? null, category: e.category, type: e.type, severity: e.severity, title: e.title,
  ...(e.withdrawn ? { withdrawn: e.withdrawn } : {}), ...(e.credit ? { credit: e.credit } : {}),
});

/**
 * Cómo está ahora lo que se sigue con esta clave.
 * - Un servicio: 'circula' (se ve algún vehículo suyo), 'cancelado' o 'parcial' (su operador lo da como
 *   cancelado o con paradas suprimidas), 'sin-datos' (según su horario debería circular y su operador no
 *   publica nada), 'cancelado-retirado' (se canceló hoy y su operador ya no lo publica) o 'no-se-ve' (no
 *   circula ahora o su operador no lo publica: no se puede saber cuál de las dos).
 * - Una línea: 'circulan' o 'ninguno', con cuántos vehículos, cuántos dan su retraso y cuántos van con retraso.
 * - Una parada: 'parada' (lo suyo está en su ficha).
 * Las incidencias van siempre, las que su fuente ya no publica al final.
 * @param {string} key
 * @param {{ vehicles?: import('./model.js').Vehicle[], events?: import('./model.js').IncidentEvent[] }} [entry]  lo de esa clave (indexByFollow)
 * @returns {object|null}  null si la clave no es válida
 */
export function followStatus(key, { vehicles = [], events = [] } = {}) {
  const kind = followKind(key);
  if (!kind) return null;
  const active = events.filter((e) => !e.withdrawn);
  const cancellation = (type) => active.find((e) => e.category === 'cancelacion' && (type === 'cancelado' ? e.type === 'cancelado' : e.type !== 'cancelado'));
  let state;
  if (kind === 'parada') state = 'parada';
  else if (kind === 'linea') state = vehicles.length ? 'circulan' : 'ninguno';
  else if (vehicles.length) state = 'circula';
  else if (cancellation('cancelado')) state = 'cancelado';
  else if (cancellation('parcial')) state = 'parcial';
  else if (active.some((e) => e.category === 'sin-datos')) state = 'sin-datos';
  else if (events.some((e) => e.withdrawn && e.category === 'cancelacion')) state = 'cancelado-retirado';
  else state = 'no-se-ve';
  // Primero los que van con más retraso; las incidencias en vigor antes que las retiradas.
  const sorted = [...vehicles].sort((a, b) => (b.delay ?? -1) - (a.delay ?? -1));
  const sortedEvents = [...active, ...events.filter((e) => e.withdrawn)];
  const sample = vehicles[0] ?? events.find((e) => e.trip)?.trip ?? null;
  return {
    key,
    kind,
    state,
    name: sample ? followName(key, sample) : describeFollow(key),
    mode: sample?.mode ?? null,
    vehicles: {
      total: vehicles.length,
      withDelayInfo: vehicles.filter(hasDelayInfo).length,
      delayed: vehicles.filter(isDelayed).length,
      list: sorted.slice(0, FOLLOW_LIST_MAX).map(vehicleOut),
    },
    events: { total: events.length, active: active.length, list: sortedEvents.slice(0, FOLLOW_LIST_MAX).map(eventOut) },
  };
}
