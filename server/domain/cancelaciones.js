// Cancelaciones: viajes que su operador da como cancelados y paradas que suprime, según su tiempo real
// (GTFS-RT, trip updates). Puro: sin red ni reloj. Cada fuente da su feed ya leído y lo que sabe de cada
// viaje por su horario; aquí se juntan las entradas de un mismo viaje, se decide qué se ha suprimido y se
// arma la incidencia con todo lo que se sabe: qué tren, de dónde a dónde, a qué hora, qué paradas, quién lo
// publica y desde cuándo lo ve el radar.
import { clockOf } from './trip-stops.js';
import { round5 } from './geo.js';

// Si su fuente deja de responder, lo último que publicó se muestra como mucho una hora más: sin
// noticias suyas no se sabe si el tren sigue cancelado (como el tráfico, ver carreteras.js).
export const CANCELLATION_UNCONFIRMED_MS = 3600_000;

/**
 * @typedef {{ cancelled: boolean, running: boolean, skipped: Array<{ stopId: string|null, stopSequence: number|null }>,
 *             tripIds: string[], startDate: string|null }} TripChange
 *   cancelled: alguna entrada lo da como cancelado (CANCELED o DELETED); running: alguna lo da en servicio
 *   (con su retraso o su posición); skipped: paradas SKIPPED, sin repetir, en el orden en que llegan;
 *   startDate: día del viaje («AAAAMMDD») si la fuente lo dice (Renfe no lo dice).
 */

/**
 * Lo que dice el tiempo real de cada viaje con algo suprimido, juntando todas sus entradas: Renfe repite
 * un viaje en varias (una CANCELED y otra SCHEDULED con su retraso o con paradas SKIPPED), y en AV/LD/MD
 * cada tren va en dos viajes con el mismo número.
 * @param {object|null} feed  FeedMessage ya leído
 * @param {(tripId: string) => string} [keyOf]  a qué tren pertenece cada viaje (por defecto, el viaje)
 * @returns {Map<string, TripChange>}  sólo los que tienen algo cancelado o suprimido
 */
export function tripChanges(feed, keyOf = (tripId) => tripId) {
  const all = new Map();
  for (const e of feed?.entity ?? []) {
    const tu = e?.tripUpdate;
    const tripId = tu?.trip?.tripId;
    if (!tripId) continue;
    const key = keyOf(tripId);
    let c = all.get(key);
    if (!c) all.set(key, (c = { cancelled: false, running: false, skipped: [], tripIds: [], startDate: null }));
    if (!c.tripIds.includes(tripId)) c.tripIds.push(tripId);
    c.startDate ??= /^\d{8}$/.test(tu.trip.startDate ?? '') ? tu.trip.startDate : null;
    const relation = tu.trip.scheduleRelationship ?? 'SCHEDULED';
    if (relation === 'CANCELED' || relation === 'DELETED') {
      c.cancelled = true;
      continue;
    }
    c.running = true;
    for (const u of tu.stopTimeUpdate ?? []) {
      if (u?.scheduleRelationship !== 'SKIPPED') continue;
      const stopId = u.stopId ?? null;
      const stopSequence = Number.isFinite(u.stopSequence) ? u.stopSequence : null;
      if (stopId === null && stopSequence === null) continue;
      if (!c.skipped.some((s) => s.stopId === stopId && s.stopSequence === stopSequence)) c.skipped.push({ stopId, stopSequence });
    }
  }
  for (const [key, c] of all) if (!c.cancelled && !c.skipped.length) all.delete(key);
  return all;
}

/**
 * Qué parte del viaje se ha suprimido, por la posición de sus paradas suprimidas: las últimas (no llega a
 * su destino: termina en la anterior), las primeras (no sale de su origen: empieza en la siguiente),
 * todas o algunas intermedias.
 * @param {number} n  paradas del viaje
 * @param {number[]} positions  posición en el viaje de cada parada suprimida
 * @returns {{ part: 'todas'|'final'|'inicio'|'intermedias', endsAt?: number, startsAt?: number }}
 *   endsAt: dónde termina ('final'); startsAt: dónde empieza ('inicio')
 */
export function skippedPart(n, positions) {
  const idx = [...new Set(positions)].filter((i) => i >= 0 && i < n).sort((a, b) => a - b);
  if (n > 0 && idx.length === n) return { part: 'todas' };
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (idx.length && contiguous && idx.at(-1) === n - 1 && idx[0] > 0) return { part: 'final', endsAt: idx[0] - 1 };
  if (idx.length && contiguous && idx[0] === 0) return { part: 'inicio', startsAt: idx.at(-1) + 1 };
  return { part: 'intermedias' };
}

/**
 * Cuándo vio el radar por primera vez cada incidencia: la hora de antes para las que siguen, `now` para
 * las nuevas. Las que ya no están se olvidan (si vuelven, son otra vez nuevas).
 * @param {Map<string, number>} previous  id → epoch ms
 * @param {Iterable<string>} ids  las de esta lectura
 * @returns {{ seen: Map<string, number>, added: string[], removed: number }}
 */
export function stampSeen(previous, ids, now) {
  const seen = new Map();
  const added = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const before = previous.get(id);
    if (Number.isFinite(before)) seen.set(id, before);
    else {
      seen.set(id, now);
      added.push(id);
    }
  }
  let removed = 0;
  for (const id of previous.keys()) if (!seen.has(id)) removed++;
  return { seen, added, removed };
}

/**
 * @typedef {{ name: string, time?: number|null, at?: number[]|null, code?: string|null, skipped?: boolean }} CancelledStop
 *   time: hora del horario, en segundos del día de servicio; at: [lon, lat]
 * @typedef {object} Cancellation
 * @property {string} id
 * @property {boolean} cancelled         la fuente lo da como cancelado
 * @property {boolean} running           la fuente también lo da en servicio (con su retraso o su posición)
 * @property {CancelledStop[]|null} stops  paradas del viaje en su horario, en orden (null si no se saben)
 * @property {string[]} [skippedNames]   paradas suprimidas que no están en `stops` (o sin `stops`), por su nombre
 * @property {string} who                el tren o la línea, para el título («Alvia 00291», «Cercanías C3 31413»)
 * @property {string} operator
 * @property {import('./model.js').Mode} mode
 * @property {string|null} [service]
 * @property {string|null} [line]
 * @property {string|null} [number]
 * @property {string|null} [origin]      si no hay `stops`
 * @property {string|null} [destination] si no hay `stops`
 * @property {string|null} [date]        día del viaje («AAAAMMDD») si la fuente lo dice
 * @property {number} [trips]            expediciones afectadas (paradas suprimidas de una línea de autobús)
 * @property {number[]|null} [at]        dónde situarla ([lon, lat]) si no hay `stops` (la primera parada suprimida)
 * @property {string} publisher          quién lo publica («Renfe»)
 * @property {string} feed               de qué fichero sale («GTFS-RT de AV/LD/MD»)
 * @property {string|null} [feedUrl]     dirección pública de ese fichero
 * @property {string|null} [credit]      atribución que pide su licencia
 * @property {number} seen               epoch ms en que el radar la vio por primera vez
 * @property {boolean} [seenAtStart]     ya estaba en la primera lectura tras arrancar el radar: pudo publicarse antes
 */

const SEVERITY = { cancelado: 'alta', parcial: 'media' };

/**
 * La incidencia de una cancelación (category 'cancelacion'): `type` 'cancelado' si no circula y
 * 'parcial' si circula sin parar en algunas paradas. Si la fuente se contradice (cancelado y también en
 * servicio), se dice en la descripción.
 * @param {Cancellation} c @param {number} now  la hora de la lectura (para `expires`)
 * @returns {import('./model.js').IncidentEvent}
 */
export function cancellationEvent(c, now) {
  const stops = c.stops?.length ? c.stops : null;
  const skippedAt = stops ? stops.map((s, i) => (s.skipped ? i : -1)).filter((i) => i >= 0) : [];
  const skippedNames = [...skippedAt.map((i) => stops[i].name), ...(c.skippedNames ?? [])];
  const part = stops && skippedAt.length ? skippedPart(stops.length, skippedAt) : { part: skippedNames.length ? 'intermedias' : 'todas' };
  // Cancelado si la fuente lo dice y no lo da en servicio con paradas suprimidas, o si las suprime todas.
  const whole = part.part === 'todas' || (c.cancelled && !(c.running && skippedNames.length));
  const type = whole ? 'cancelado' : 'parcial';
  const origin = stops?.[0]?.name ?? c.origin ?? null;
  const destination = stops?.at(-1)?.name ?? c.destination ?? null;
  const departure = clockOf(stops?.[0]?.time ?? null);
  const arrival = clockOf(stops?.at(-1)?.time ?? null);
  const bus = c.mode === 'bus';
  const stopWord = (n) => (bus ? (n === 1 ? 'parada' : 'paradas') : (n === 1 ? 'estación' : 'estaciones'));

  let title;
  if (whole) {
    const route = origin && destination ? `: ${origin}${departure ? ` ${departure}` : ''} → ${destination}` : '';
    title = `${c.who} cancelado${route}`;
  } else if (part.part === 'final') {
    title = `${c.who} no llega a ${destination}: termina en ${stops[part.endsAt].name}`;
  } else if (part.part === 'inicio') {
    title = `${c.who} no sale de ${origin}: empieza en ${stops[part.startsAt].name}`;
  } else {
    title = `${c.who} no para en ${skippedNames.length === 1 ? skippedNames[0] : `${skippedNames.length} ${stopWord(skippedNames.length)}`}`;
  }

  const schedule = departure || arrival
    ? `Según el horario, ${[departure && `salía de ${origin} a las ${departure}`, arrival && `llegaba a ${destination} a las ${arrival}`].filter(Boolean).join(' y ')}.`
    : '';
  const said = whole
    ? (c.cancelled
      ? `${c.publisher} lo da como cancelado en su tiempo real (${c.feed}).`
      : `${c.publisher} da como suprimidas en su tiempo real (${c.feed}) todas sus paradas.`)
    : c.trips > 1
      ? `${c.publisher} da como suprimidas en su tiempo real (${c.feed}) ${skippedNames.length === 1 ? 'esta parada' : `estas ${skippedNames.length} paradas`} en ${c.trips} expediciones: ${skippedNames.join('; ')}.`
      : `${c.publisher} da como suprimidas en su tiempo real (${c.feed}) ${skippedNames.length === 1 ? 'esta parada' : `estas ${skippedNames.length} paradas`}: ${skippedNames.join('; ')}.`;
  const doubts = whole && c.cancelled && c.running
    ? `${c.publisher} también publica su retraso o su posición: puede que circule en parte.`
    : !whole && c.cancelled ? `${c.publisher} además lo marca como cancelado en otra entrada de su tiempo real.` : '';

  // En el mapa: donde empieza lo que no se hace (su origen o la primera parada suprimida).
  const placed = (s) => Array.isArray(s?.at) && s.at.length === 2 && s.at.every(Number.isFinite);
  const place = (whole ? stops : skippedAt.map((i) => stops[i]))?.find(placed) ?? (placed(c) ? { at: c.at, name: skippedNames[0] ?? null } : null);
  return {
    id: c.id,
    category: 'cancelacion',
    type,
    severity: bus && !whole ? 'baja' : SEVERITY[type],
    title,
    description: [said, schedule, doubts].filter(Boolean).join(' '),
    lat: place ? round5(place.at[1]) : null,
    lon: place ? round5(place.at[0]) : null,
    ...(place?.name ? { area: place.name } : {}),
    seen: c.seen,
    ...(c.seenAtStart ? { seenAtStart: true } : {}),
    expires: now + CANCELLATION_UNCONFIRMED_MS,
    ...(c.credit ? { credit: c.credit } : {}),
    trip: {
      operator: c.operator,
      mode: c.mode,
      service: c.service ?? null,
      line: c.line ?? null,
      number: c.number ?? null,
      origin,
      destination,
      date: c.date ? `${c.date.slice(0, 4)}-${c.date.slice(4, 6)}-${c.date.slice(6, 8)}` : null,
      departure,
      arrival,
      ...(part.part === 'final' ? { endsAt: stops[part.endsAt].name } : {}),
      ...(part.part === 'inicio' ? { startsAt: stops[part.startsAt].name } : {}),
      skipped: whole ? [] : skippedNames,
      stops: stops?.map((s) => ({
        name: s.name,
        time: clockOf(s.time ?? null),
        ...(Array.isArray(s.at) && s.at.every(Number.isFinite) ? { lon: round5(s.at[0]), lat: round5(s.at[1]) } : {}),
        ...(s.skipped && !whole ? { skipped: true } : {}),
      })) ?? null,
      ...(c.trips ? { trips: c.trips } : {}),
      cancelled: c.cancelled,
      running: c.running,
      publisher: c.publisher,
      feed: c.feed,
      feedUrl: c.feedUrl ?? null,
    },
  };
}
