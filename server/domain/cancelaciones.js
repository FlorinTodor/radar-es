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
 * @property {Notice|null} [notice]      aviso del operador que habla de este viaje (ver noticesAbout)
 * @property {Notice[]} [lineNotices]    avisos del operador sobre su línea que pueden explicarlo
 * @property {string} [reason]           el motivo, si lo dice quien lo publica (un aviso de desvío de AUVASA)
 *
 * @typedef {{ id: string, text: string, url?: string|null, lines?: string[] }} Notice
 *   Un aviso de servicio del operador: su texto, su enlace y las líneas a las que se refiere.
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
  const notice = c.notice?.text ? `Aviso de ${c.publisher} sobre este viaje: ${c.notice.text}` : '';
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
    description: [c.reason, said, schedule, doubts, notice].filter(Boolean).join(' '),
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
      ...(c.reason ? { reason: c.reason } : {}),
      ...(c.notice?.text ? { notice: noticeOut(c.notice) } : {}),
      ...(c.lineNotices?.length ? { lineNotices: c.lineNotices.map(noticeOut) } : {}),
      cancelled: c.cancelled,
      running: c.running,
      publisher: c.publisher,
      feed: c.feed,
      feedUrl: c.feedUrl ?? null,
    },
  };
}

const noticeOut = (n) => ({ text: n.text, ...(n.url ? { url: n.url } : {}) });

// ---------- Avisos del operador que explican una cancelación ----------

// Sin tildes ni mayúsculas, y lo que no es letra o número, un espacio.
const plain = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñç]+/g, ' ').trim();
// La hora de salida de un tren en un aviso: «salida a las 15:40h», «salida prevista a las 17:13h», «eixida
// prevista a les 17:03h» (en valenciano), «14.15 h».
const DEPARTURE_RE = /(?:salida|eixida|sortida)[^.;]{0,25}?\ba l[ae]s ?(\d{1,2})[:.,h](\d{2})/gi;
const TRAIN_NUMBER_RE = /\btren(?:es)? (?:n[ºo°.]* ?)?0*(\d{3,6})\b/gi;
// Avisos de una estación (ascensores, accesos…), no de los trenes.
const FACILITIES_RE = /ascensor|escaler|aseos?\b|accesib|\bpmr\b|taquill|m[aá]quinas? (?:de )?(?:venta|autoventa)|vest[ií]bulo|acceso|aparcamiento|parking|igogailu|eskailera/i;
// Un aviso que habla de un tren concreto (por su hora de salida o su número).
const namesATrain = (text) => new RegExp(DEPARTURE_RE.source, 'i').test(text) || new RegExp(TRAIN_NUMBER_RE.source, 'i').test(text);
// Las palabras del nombre de una estación que la distinguen (no «estación», «de», «la»…).
const SKIP_WORDS = new Set(['estacion', 'estacio', 'de', 'del', 'la', 'el', 'les', 'los', 'las', 'puerta', 'clara', 'campoamor', 'almudena', 'grandes']);
const keyWords = (name) => plain(name).split(' ').filter((w) => w.length >= 4 && !SKIP_WORDS.has(w));

/**
 * Los avisos de servicio del operador que hablan de una cancelación. El que nombra el viaje (por su número
 * de tren, o por su hora de salida y su origen: «Tren con salida a las 15:40h de FUENGIROLA … no presta
 * servicio») es el aviso sobre este viaje; los de su línea que no hablan de otro tren ni de una estación
 * (obras, una avería, una huelga) pueden explicarlo, y se dan aparte, como mucho tres.
 * @param {{ number?: string|null, departure?: string|null, origin?: string|null, line?: string|null }} trip
 *   departure: «HH:MM» del horario; line: la clave de su línea, la misma que en `Notice.lines`
 * @param {Notice[]} notices
 * @returns {{ notice: Notice|null, lineNotices: Notice[] }}
 */
export function noticesAbout(trip, notices) {
  const number = trip.number ? String(Number(trip.number)) : null;
  const words = keyWords(trip.origin);
  const onLine = (n) => !n.lines?.length || !trip.line || n.lines.includes(trip.line);
  const aboutThis = (n) => {
    if (!onLine(n)) return false;
    if (number) for (const m of n.text.matchAll(TRAIN_NUMBER_RE)) if (String(Number(m[1])) === number) return true;
    if (!trip.departure || !words.length) return false;
    for (const m of n.text.matchAll(DEPARTURE_RE)) {
      if (`${m[1].padStart(2, '0')}:${m[2]}` !== trip.departure) continue;
      const after = plain(n.text.slice(m.index + m[0].length, m.index + m[0].length + 80));
      if (words.some((w) => after.includes(w))) return true;
    }
    return false;
  };
  const notice = notices.find(aboutThis) ?? null;
  const lineNotices = trip.line
    ? notices.filter((n) => n !== notice && n.lines?.includes(trip.line) && !namesATrain(n.text) && !FACILITIES_RE.test(n.text)).slice(0, 3)
    : [];
  return { notice, lineNotices };
}

// ---------- Las que la fuente deja de publicar ----------

/**
 * ¿Había pasado ya su hora de llegada (según el horario) a la hora `clock` («HH:MM», la de su horario)? null
 * si no se sabe. Un viaje que llega pasada la medianoche (llegada antes que la salida) ha llegado si `clock`
 * está entre su llegada y su salida.
 */
function arrivedBy(trip, clock) {
  const { departure, arrival } = trip ?? {};
  if (!arrival || !clock) return null;
  if (departure && arrival < departure) return clock >= arrival && clock < departure;
  return clock >= arrival;
}

/**
 * Una cancelación que su fuente ha dejado de publicar: se sigue viendo hasta el final del día, con poca
 * gravedad y diciendo cuándo se retiró. Si fue después de su hora de llegada, es lo normal (las fuentes
 * quitan los viajes que ya han pasado); si fue antes, puede que al final circule.
 * @param {import('./model.js').IncidentEvent} e  la cancelación tal como se vio por última vez
 * @param {{ now: number, clock: string, endOfDay: number }} when  clock: «HH:MM» de `now` en hora de Madrid
 */
export function withdrawnCancellation(e, { now, clock, endOfDay }) {
  const t = e.trip ?? {};
  const arrived = arrivedBy(t, clock);
  const who = t.publisher ?? 'La fuente';
  const note = arrived === true ? `${who} dejó de publicarlo a las ${clock}, después de su hora de llegada: lo hace con los viajes que ya han pasado.`
    : arrived === false ? `${who} dejó de publicarlo a las ${clock}, antes de su hora de llegada: puede que al final circule, o que lo haya retirado por otro motivo.`
      : `${who} dejó de publicarlo a las ${clock}.`;
  return {
    ...e,
    severity: 'baja',
    withdrawn: now,
    expires: endOfDay,
    description: [e.description, note].filter(Boolean).join(' '),
    trip: { ...t, withdrawnAfterArrival: arrived },
  };
}

/**
 * Sigue las cancelaciones de lectura en lectura: las que estaban en la anterior y ya no están se retiran
 * (withdrawnCancellation) y se guardan hasta el final del día en que se vieron por última vez; si una
 * vuelve a publicarse, vuelve a ser de esta lectura. Las fuentes vacían su tiempo real al cambiar de día:
 * las que desaparecen pasada la medianoche eran de ayer y no se muestran hoy como retiradas.
 * @param {{ shown: Map<string, import('./model.js').IncidentEvent>, withdrawn: Map<string, import('./model.js').IncidentEvent>,
 *           shownUntil?: number|null }} memory
 *   shownUntil: la medianoche que cierra el día de la lectura en que se vieron las de `shown` (sin ella, la de hoy)
 * @param {import('./model.js').IncidentEvent[]} current  las de esta lectura
 * @param {{ now: number, clock: string, endOfDay: number }} when
 * @returns {{ shown: Map<string, import('./model.js').IncidentEvent>, withdrawn: Map<string, import('./model.js').IncidentEvent>,
 *             shownUntil: number }}
 */
export function followWithdrawn(memory, current, when) {
  const shown = new Map(current.map((e) => [e.id, e]));
  const withdrawn = new Map();
  for (const [id, e] of memory.withdrawn) if (!shown.has(id) && e.expires > when.now) withdrawn.set(id, e);
  const until = Number.isFinite(memory.shownUntil) ? Math.min(memory.shownUntil, when.endOfDay) : when.endOfDay;
  if (until > when.now) {
    for (const [id, e] of memory.shown) if (!shown.has(id) && !withdrawn.has(id)) withdrawn.set(id, withdrawnCancellation(e, { ...when, endOfDay: until }));
  }
  return { shown, withdrawn, shownUntil: when.endOfDay };
}

// ---------- Trenes sin datos ----------

/**
 * @typedef {object} MissingTrain
 * @property {string} id
 * @property {string} who          «MD 37090»
 * @property {string} operator
 * @property {import('./model.js').Mode} mode
 * @property {string|null} service
 * @property {string} number
 * @property {CancelledStop[]} stops  paradas de su viaje con su hora del horario
 * @property {number} at          índice de la última parada por la que debería haber pasado
 * @property {string} date        día de su viaje («AAAA-MM-DD»)
 * @property {string} publisher
 * @property {string} feed        lo que se ha mirado («posiciones y actualizaciones de AV/LD/MD»)
 * @property {string|null} [feedUrl]
 * @property {string|null} [credit]
 * @property {number} seen        desde cuándo lo echa en falta el radar
 * @property {boolean} [seenAtStart]
 */

// Se calcula en cada lectura: si su fuente deja de leerse, desaparece pronto.
export const MISSING_TRAIN_TTL_MS = 10 * 60_000;

/**
 * Un tren que según su horario debería estar circulando y del que su operador no publica nada en tiempo
 * real (ni posición, ni retraso, ni cancelación). No es una cancelación: no se sabe si circula. Se sitúa
 * en la última estación por la que debería haber pasado.
 * @param {MissingTrain} m @param {number} now
 * @returns {import('./model.js').IncidentEvent}
 */
export function missingTrainEvent(m, now) {
  const stops = m.stops;
  const origin = stops[0]?.name ?? null;
  const destination = stops.at(-1)?.name ?? null;
  const departure = clockOf(stops[0]?.time ?? null);
  const arrival = clockOf(stops.at(-1)?.time ?? null);
  const from = stops[m.at];
  const to = stops[m.at + 1] ?? null;
  const placed = Array.isArray(from?.at) && from.at.every(Number.isFinite);
  const between = to ? `ahora iría entre ${from.name} y ${to.name}` : null;
  return {
    id: m.id,
    category: 'sin-datos',
    type: 'sin-datos',
    severity: 'baja',
    title: `${m.who} sin datos de ${m.publisher}: ${origin}${departure ? ` ${departure}` : ''} → ${destination}`,
    description: `Según su horario debería estar circulando: salía de ${origin}${departure ? ` a las ${departure}` : ''} y llega a ${destination}`
      + `${arrival ? ` a las ${arrival}` : ''}${between ? `; ${between}` : ''}. ${m.publisher} no publica en su tiempo real ni su posición, ni su retraso, `
      + 'ni lo da como cancelado: el radar no puede saber si circula.',
    lat: placed ? round5(from.at[1]) : null,
    lon: placed ? round5(from.at[0]) : null,
    ...(from?.name ? { area: from.name } : {}),
    seen: m.seen,
    ...(m.seenAtStart ? { seenAtStart: true } : {}),
    expires: now + MISSING_TRAIN_TTL_MS,
    ...(m.credit ? { credit: m.credit } : {}),
    trip: {
      operator: m.operator,
      mode: m.mode,
      service: m.service ?? null,
      line: null,
      number: m.number,
      origin,
      destination,
      date: m.date,
      departure,
      arrival,
      between: to ? [from.name, to.name] : null,
      stops: stops.map((s, i) => ({
        name: s.name,
        time: clockOf(s.time ?? null),
        ...(Array.isArray(s.at) && s.at.every(Number.isFinite) ? { lon: round5(s.at[0]), lat: round5(s.at[1]) } : {}),
        ...(i <= m.at ? { passed: true } : {}),
      })),
      publisher: m.publisher,
      feed: m.feed,
      feedUrl: m.feedUrl ?? null,
    },
  };
}
