// «Mi trayecto»: seguir los trenes de una estación a otra en una franja horaria y unos días, sin saber su número
// («/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V»). Qué se escribe (parseTrayectoText), qué estaciones son
// (trayectoOptions), qué trenes encajan (los que paran en el origen y luego en el destino y salen del origen en la
// franja uno de esos días), qué se avisa de ellos (cancelados o sin parar en una de las dos, con retraso, sin
// datos) y cómo van (para /estado y el parte). Vale para cualquier fuente que diga las paradas de sus viajes: todo
// sale de las paradas de las cancelaciones y de cada vehículo y de las estaciones del catálogo, comparadas como en
// la ficha de una estación (mismo nombre y cerca). Puro: sin red, ni reloj, ni disco (la hora llega en `now`; las
// paradas de cada vehículo, de `stopsOf`).
import { ALL_DAYS, daysText, describeFollow, followKind, parseFollowKey, trayectoKey } from '../seguir.js';
import { modeInfo, modeNoun } from '../modos.js';
import { distanceKm } from '../geo.js';
import { DELAY_MIN, DELAY_STEP, madridDay, madridHourMinute, nearStation, plainStop, tripsAt, vehicleName } from './avisos.js';
import { cutText } from './texto.js';
import { sameNetwork, searchStations, stationLabel } from './estaciones.js';

/**
 * Velocidad media (con sus paradas) con la que se calcula cuándo pasa por una estación un tren del que no se sabe
 * la hora de cada parada (Cercanías: Renfe no la publica en su tiempo real y el radar no guarda ese horario, son
 * 140.000 viajes). En línea recta entre paradas, que es algo menos que por la vía.
 */
export const ESTIMATE_KMH = 45;
/** Trenes que se cuentan en /estado y en el parte; del resto, cuántos son. */
const STATUS_TRAINS = 8;
/** Un tren cancelado o sin datos que salía del origen hace más de esto ya no es de los «próximos». */
const GONE_MIN = 15;
/** Estaciones que se combinan, como mucho, de cada lado (las demás no caben en una lista). */
const OPTIONS_SIDE_MAX = 20;
const EXAMPLE = '/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V';

const clip = (s, n) => cutText(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
const pad = (n) => String(n).padStart(2, '0');
/** Minutos del día → «HH:MM». */
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
/** «HH:MM» → minutos del día; null si no lo es. */
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const DAY_MS = 86_400_000;
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Día de la semana de una fecha «AAAA-MM-DD»: 0 el lunes… 6 el domingo (como la máscara de días). */
export const weekday = (day) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
/** Un instante como día y minuto de Madrid. */
const madridAt = (ms) => ({ day: madridDay(ms), min: toMin(madridHourMinute(ms)) });
/** Para ordenar y comparar días y minutos: minutos desde 1970 (en hora de Madrid, sin más). */
const order = ({ day, min }) => Math.round(Date.parse(`${day}T00:00:00Z`) / 60_000) + min;

// ---------------------------------------------------------------------------------------------------------------
// Lo que se escribe

/** ¿Parece un trayecto? («Alcalá > Atocha 7-9», sin orden: se busca como tal) */
export const looksLikeTrayecto = (text) => /[>→⟶]/.test(String(text ?? ''));

const ARROW = /\s*(?:[-=–—]?>|→|⟶)\s*/;
// La franja: «7:00-9:00», «7-9», «07.30 a 09.00», «de 7 a 9h», «entre las 7 y las 9». La última que haya.
const RANGE = /(?:^|\s)(?:(?:de|entre)\s+)?(?:las\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*h?\s*(?:-|–|—|\ba\b|\by\b|\bhasta\b)\s*(?:las\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*h?(?=[\s,.;]|$)/gi;
const DAY_NAMES = [
  ['l', 'lu', 'lun', 'lunes'], ['m', 'ma', 'mar', 'martes'], ['x', 'mi', 'mie', 'mier', 'miercoles'], ['j', 'ju', 'jue', 'jueves'],
  ['v', 'vi', 'vie', 'viernes'], ['s', 'sa', 'sab', 'sabado', 'sabados'], ['d', 'do', 'dom', 'domingo', 'domingos'],
];
const DAY_OF = new Map(DAY_NAMES.flatMap((names, i) => names.map((n) => [n, i])));
const ALL_RE = /^(?:todos|todos los dias|toda la semana|diario|a diario|cada dia|siempre)$/;
const WORKDAYS_RE = /^(?:laborables|dias laborables|entre semana)$/;
const WEEKEND_RE = /^(?:fin de semana|fines de semana|finde|findes|los fines de semana)$/;

/**
 * Los días que dice un texto, como máscara (bit 0 el lunes): «L-V», «de lunes a viernes», «S-D», «L,X,V», «LXV»,
 * «sábados y domingos», «V-L» (de viernes a lunes), «laborables», «fin de semana», «todos». Sin nada, todos.
 * @returns {number|null}  null si no se entiende
 */
export function parseDays(text) {
  const t = String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return ALL_DAYS;
  if (ALL_RE.test(t)) return ALL_DAYS;
  if (WORKDAYS_RE.test(t)) return 0x1f;
  if (WEEKEND_RE.test(t)) return 0x60;
  const words = t.replace(/\s*(?:-|–|—)\s*/g, '-').replace(/\s+(?:a|al|hasta)\s+/g, '-').split(/[\s,/]+/)
    .filter((w) => w && !['de', 'los', 'las', 'el', 'y', 'e', 'cada'].includes(w));
  if (!words.length) return null;
  let mask = 0;
  for (const w of words) {
    const range = w.split('-');
    if (range.length === 2 && DAY_OF.has(range[0]) && DAY_OF.has(range[1])) {
      // De uno a otro, también pasando del domingo al lunes («V-L»).
      for (let i = DAY_OF.get(range[0]); ; i = (i + 1) % 7) {
        mask |= 1 << i;
        if (i === DAY_OF.get(range[1])) break;
      }
    } else if (range.length === 1 && DAY_OF.has(w)) mask |= 1 << DAY_OF.get(w);
    else if (range.length === 1 && /^[lmxjvsd]{2,7}$/.test(w)) for (const ch of w) mask |= 1 << DAY_OF.get(ch); // «LXV»
    else return null;
  }
  return mask || null;
}

// Los días también pueden ir antes de la franja («Atocha L-V 7-9»): lo que se reconoce como días al final del
// destino. Sólo con un guion, una coma o una palabra de días entera, para no comerse una estación que acabe en «D».
const DAYS_TAIL = /\s+((?:de\s+)?(?:[LMXJVSD](?:\s*[-,]\s*[LMXJVSD])+|[LMXJVSD]{2,7}|(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|laborables|entre semana|fin(?:es)? de semana|finde|todos(?: los d[ií]as)?|diario)(?:(?:\s*(?:-|,|\by\b|\ba\b)\s*)(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?))*))$/i;

/**
 * Lo que dice «/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V»: el texto del origen y del destino (para
 * buscarlos en el catálogo), la franja en minutos del día en que sale del origen y los días (máscara; sin días,
 * todos).
 * @returns {{ origin: string, destination: string, from: number, to: number, days: number } | { error: string }}
 *   error: 'flecha' (no separa las estaciones con «>»), 'estaciones' (falta alguna), 'franja' (no la dice), 'horas'
 *   (no es de una hora a otra más tarde del mismo día) o 'dias' (no se entienden)
 */
export function parseTrayectoText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const parts = t.split(ARROW);
  if (parts.length !== 2) return { error: 'flecha' };
  const origin = parts[0].trim();
  let rest = parts[1].trim();
  const ranges = [...rest.matchAll(RANGE)];
  if (!origin) return { error: 'estaciones' };
  if (!ranges.length) return { error: 'franja' };
  const m = ranges.at(-1);
  let destination = rest.slice(0, m.index).trim().replace(/[,;]$/, '').trim();
  let daysPart = rest.slice(m.index + m[0].length).trim().replace(/^[,;]\s*/, '');
  if (!daysPart) {
    const tail = DAYS_TAIL.exec(destination);
    if (tail && destination.length > tail[0].length) {
      daysPart = tail[1];
      destination = destination.slice(0, tail.index).trim();
    }
  }
  if (!destination) return { error: 'estaciones' };
  const [, h1, m1 = '00', h2, m2 = '00'] = m;
  const from = Number(h1) * 60 + Number(m1);
  // «hasta las 24» es hasta el final del día.
  const to = Number(h2) === 24 && Number(m2) === 0 ? 24 * 60 - 1 : Number(h2) * 60 + Number(m2);
  if (Number(h1) > 23 || Number(m1) > 59 || Number(h2) > 24 || Number(m2) > 59 || from >= to || to > 24 * 60 - 1) return { error: 'horas' };
  const days = parseDays(daysPart);
  if (days === null) return { error: 'dias', days: clip(daysPart, 40) };
  return { origin, destination, from, to, days };
}

// ---------------------------------------------------------------------------------------------------------------
// Las estaciones

/**
 * Los trayectos que puede querer decir lo escrito: las estaciones del catálogo que encajan con el origen y con el
 * destino, de dos en dos (distintas y de la misma red: un tren de Renfe no para en una de metro), con su clave y
 * su nombre, en el orden de la búsqueda.
 * @param {import('./estaciones.js').CatalogStation[]} stations
 * @param {{ origin: string, destination: string, from: number, to: number, days: number }} parsed  de parseTrayectoText
 * @returns {{ error: 'origen'|'destino'|'misma'|'red', text?: string } | { pairs: Array<{ key: string, name: string, label: string }>, total: number }}
 */
export function trayectoOptions(stations, parsed, { limit = 8 } = {}) {
  const origins = searchStations(stations, parsed.origin, { limit: OPTIONS_SIDE_MAX });
  if (!origins.length) return { error: 'origen', text: clip(parsed.origin, 60) };
  const destinations = searchStations(stations, parsed.destination, { limit: OPTIONS_SIDE_MAX });
  if (!destinations.length) return { error: 'destino', text: clip(parsed.destination, 60) };
  const pairs = [];
  let same = 0;
  for (const o of origins) {
    for (const d of destinations) {
      if (o.code === d.code) {
        same++;
        continue;
      }
      if (!sameNetwork(o, d)) continue;
      const key = trayectoKey({ origin: o.code, destination: d.code, from: parsed.from, to: parsed.to, days: parsed.days });
      if (!key) continue;
      const network = o.network ? ` · ${o.network}` : '';
      pairs.push({ key, name: describeFollow(key, { originName: o.name, destinationName: d.name }), label: `${o.name} → ${d.name}${network}` });
    }
  }
  if (!pairs.length) return same ? { error: 'misma' } : { error: 'red', text: `${stationLabel(origins[0])} y ${stationLabel(destinations[0])}` };
  return { pairs: pairs.slice(0, limit), total: pairs.length };
}

/**
 * Las estaciones, la franja y los días de la clave de un trayecto, con las estaciones del catálogo (stationOf);
 * null si no es un trayecto o alguna ya no está en él.
 * @returns {{ origin: object, destination: object, from: number, to: number, days: number }|null}
 */
export function trayectoStations(key, stationOf) {
  const p = parseFollowKey(key);
  if (p?.kind !== 'trayecto') return null;
  const origin = stationOf(p.origin);
  const destination = stationOf(p.destination);
  if (!origin?.name || !destination?.name) return null;
  return { origin, destination, from: toMin(p.from), to: toMin(p.to), days: p.days };
}

/** «Alcalá de Henares → Madrid-Atocha Cercanías (07:00-09:00, de lunes a viernes)»; null si no se encuentran sus estaciones. */
export function trayectoName(key, stationOf) {
  const t = trayectoStations(key, stationOf);
  return t ? describeFollow(key, { originName: t.origin.name, destinationName: t.destination.name }) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Qué trenes son

// Los nombres de las paradas de cada lista, comparables (plainStop), una vez por lista mientras viva.
const NAMES = new WeakMap();
function namesOf(stops) {
  let names = NAMES.get(stops);
  if (!names) NAMES.set(stops, (names = stops.map((s) => plainStop(s?.name))));
  return names;
}
/** Dónde está una estación en una lista de paradas, desde `from`: como en su ficha, mismo nombre y cerca. -1 si no está. */
function stopIndexIn(stops, station, from = 0) {
  const names = namesOf(stops);
  const name = plainStop(station.name);
  for (let i = Math.max(0, from); i < stops.length; i++) if (names[i] === name && nearStation(stops[i], station)) return i;
  return -1;
}

/**
 * El origen y el destino de un trayecto en las paradas de un viaje: sus índices (el destino, después del origen);
 * null si no para en los dos en ese orden.
 * @returns {{ o: number, d: number }|null}
 */
export function legOf(stops, origin, destination) {
  if (!Array.isArray(stops)) return null;
  const o = stopIndexIn(stops, origin);
  const d = o < 0 ? -1 : stopIndexIn(stops, destination, o + 1);
  return d < 0 ? null : { o, d };
}

/**
 * Por dónde pasan los vehículos: nombre de parada (plainStop) → los vehículos que paran en ella, con sus paradas
 * (stopsOf). Sólo los que dicen sus paradas (`stops`) y no van por carretera: los trayectos son de estaciones del
 * catálogo (de tren, metro y tranvía). Una vez por ronda, para todos los trayectos.
 * @param {object[]} vehicles  @param {(id: string) => object[]|null} stopsOf
 * @returns {Map<string, Array<{ v: object, stops: object[] }>>}
 */
export function passIndex(vehicles, stopsOf) {
  const index = new Map();
  for (const v of vehicles ?? []) {
    if (!v?.stops || modeInfo(v.mode)?.family === 'carretera') continue;
    const stops = stopsOf(v.id);
    if (!Array.isArray(stops) || stops.length < 2) continue;
    for (const name of new Set(namesOf(stops))) {
      if (!name) continue;
      let list = index.get(name);
      if (!list) index.set(name, (list = []));
      list.push({ v, stops });
    }
  }
  return index;
}

/** El día de unos minutos del día que están a menos de 12 h de ahora (un tren que circula ahora). */
function nearestDay(now, min) {
  const today = madridDay(now);
  const diff = min - toMin(madridHourMinute(now));
  return diff > 720 ? addDays(today, -1) : diff < -720 ? addDays(today, 1) : today;
}

/** Lo que le falta a un vehículo por recorrer hasta la parada `o` por sus paradas (en línea recta), en km: negativo si ya
 * ha pasado por ella (lo recorrido desde entonces). null si falta alguna posición. */
function kmTo(v, stops, o) {
  const placed = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon);
  const seg = (a, b) => (placed(a) && placed(b) ? distanceKm(a.lat, a.lon, b.lat, b.lon) : NaN);
  const next = stops.findIndex((s) => !s.passed);
  if (next < 0) return null;
  let km = 0;
  if (o >= next) {
    km += seg(v, stops[next]);
    for (let i = next; i < o; i++) km += seg(stops[i], stops[i + 1]);
    return Number.isFinite(km) ? km : null;
  }
  km += seg(v, stops[next - 1]);
  for (let i = o; i < next - 1; i++) km += seg(stops[i], stops[i + 1]);
  return Number.isFinite(km) ? -km : null;
}

/**
 * Cuándo pasa (o pasaba) un vehículo por la parada `o` de su viaje según su horario: su día y su minuto en Madrid,
 * y si es una estimación.
 * 1. La hora de esa parada en su horario, si se sabe (AV, LD, MD, horarios GTFS).
 * 2. Si no ha pasado aún, la prevista que da su operador, menos su retraso.
 * 3. Si no (Cercanías), por dónde va: lo que le falta hasta ella por sus paradas (o lo recorrido desde ella) a
 *    ESTIMATE_KMH, menos su retraso.
 * @returns {{ day: string, min: number, estimated: boolean }|null}  null si no se puede saber
 */
export function vehicleDeparture(v, stops, o, now) {
  const delay = Number.isFinite(v.delay) ? v.delay : 0;
  const scheduled = toMin(stops[o]?.time);
  if (scheduled !== null) return { day: nearestDay(now, scheduled), min: scheduled, estimated: false };
  const eta = stops[o]?.passed ? null : toMin(stops[o]?.eta);
  if (eta !== null) {
    const min = (((eta - delay) % 1440) + 1440) % 1440;
    return { day: nearestDay(now, min), min, estimated: true };
  }
  const km = kmTo(v, stops, o);
  if (km === null) return null;
  return { ...madridAt(now + (km / ESTIMATE_KMH) * 3600_000 - delay * 60_000), estimated: true };
}

/** Cuándo salía del origen el tren de una cancelación (o sin datos), por su horario. Sin fecha (Renfe no la da en
 * las de hoy), de hoy; de madrugada, si salía de noche, de anoche. */
function eventDeparture(trip, stop, now) {
  const min = toMin(stop?.time);
  if (min === null) return null;
  const date = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(trip?.date ?? ''));
  if (date) return { day: `${date[1]}-${date[2]}-${date[3]}`, min, estimated: false };
  const today = madridDay(now);
  const late = toMin(madridHourMinute(now)) < 4 * 60 && min >= 20 * 60;
  return { day: late ? addDays(today, -1) : today, min, estimated: false };
}

/** ¿Sale del origen en la franja, uno de los días del trayecto? */
const inWindow = (t, dep) => Boolean(t.days & (1 << weekday(dep.day))) && dep.min >= t.from && dep.min <= t.to;

/**
 * Las cancelaciones, paradas suprimidas y trenes sin datos del trayecto: los que pasaban por el origen y luego por
 * el destino y salían del origen en la franja. De los que cancelan sólo algunas paradas, si una es el origen o el
 * destino; de los sin datos, si según su horario aún no ha llegado al destino. Las retiradas (su operador ya no las
 * publica) van marcadas.
 */
function eventTrains(t, events, now) {
  const out = [];
  for (const { e, here } of tripsAt(events, t.origin)) {
    const stops = e.trip.stops;
    const o = stops.indexOf(here);
    const d = o < 0 ? -1 : stopIndexIn(stops, t.destination, o + 1);
    if (d < 0) continue;
    const dep = eventDeparture(e.trip, stops[o], now);
    if (!dep || !inWindow(t, dep)) continue;
    let kind;
    if (e.category === 'sin-datos') {
      if (stops[d].passed) continue;
      kind = 'sin-datos';
    } else if (e.type !== 'parcial') kind = 'cancelado';
    else if (stops[o].skipped || stops[d].skipped) kind = 'parcial';
    else continue;
    out.push({ kind, e, dep, o: stops[o], d: stops[d], withdrawn: Boolean(e.withdrawn) });
  }
  return out;
}

/** Los vehículos del trayecto (index: passIndex): los que paran en el origen y luego en el destino, aún no han pasado
 * por el destino y salen (o han salido) del origen en la franja. */
function vehicleTrains(t, index, now) {
  const out = [];
  for (const { v, stops } of index.get(plainStop(t.origin.name)) ?? []) {
    const leg = legOf(stops, t.origin, t.destination);
    if (!leg || stops[leg.d].passed) continue;
    const dep = vehicleDeparture(v, stops, leg.o, now);
    if (!dep || !inWindow(t, dep)) continue;
    out.push({ kind: 'circula', v, dep, gone: Boolean(stops[leg.o].passed) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Qué se avisa y cómo van

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Cómo se llama un vehículo: por su servicio, con su línea («Cercanías C2 21518», «AVE 02202») o, si no tiene, por su línea. */
function trainName(v) {
  const keys = Array.isArray(v.follow) ? v.follow : [];
  const service = keys.find((k) => followKind(k) === 'servicio');
  if (service && parseFollowKey(service).number !== undefined) {
    return describeFollow(service, { operator: v.operator, service: v.service ?? undefined, line: v.line ?? undefined, number: v.label ?? undefined });
  }
  const key = service ?? keys.find((k) => followKind(k) === 'linea');
  return key ? vehicleName(v, key) : `${capital(modeNoun(v.mode))}${v.line ? ` ${v.line}` : ''}`;
}
/** Cómo se llama el tren de una cancelación: «Cercanías C2 21516», «AVE 02202». */
const tripName = (trip) => [trip.service ?? trip.operator, trip.line && trip.line !== trip.service ? trip.line : null, trip.number]
  .filter(Boolean).join(' ') || 'Un tren';
const serviceKeys = (follow) => (Array.isArray(follow) ? follow.filter((k) => followKind(k) === 'servicio') : []);
const creditOfEvent = (e, creditOf) => e.credit ?? creditOf(e.source, e.trip?.operator) ?? null;
/** «el de las 07:42 en Alcalá de Henares» (con «hora aproximada» si es una estimación). */
const theOne = (dep, station) => `el de las ${hhmm(dep.min)} en ${station.name}${dep.estimated ? ' (hora aproximada)' : ''}`;

function skippedText(x, t) {
  if (x.o.skipped && x.d.skipped) return `No para en ${t.origin.name} ni en ${t.destination.name}`;
  return `No para en ${x.o.skipped ? t.origin.name : t.destination.name}`;
}

function eventFact(x, t, creditOf) {
  const { e } = x;
  const credit = creditOfEvent(e, creditOf);
  const at = `Pasaba por ${t.origin.name} a las ${hhmm(x.dep.min)}.`;
  if (x.kind === 'sin-datos') return { id: e.id, kind: 'sin-datos', text: `${e.title}. No se sabe si circula: su operador no publica nada de él. ${at}`, credit };
  const reason = e.trip?.reason ? ` Motivo: ${clip(e.trip.reason, 200)}` : e.trip?.notice?.text ? ` Aviso del operador: ${clip(e.trip.notice.text, 200)}` : '';
  if (x.kind === 'parcial') {
    // Si el título ya nombra la estación suprimida («no para en Alcalá de Henares»), no se repite.
    const named = [x.o.skipped && t.origin, x.d.skipped && t.destination].filter(Boolean).every((st) => plainStop(e.title).includes(plainStop(st.name)));
    return { id: e.id, kind: 'parcial', text: `${e.title}.${named ? '' : ` ${skippedText(x, t)}.`} ${at}${reason}`, credit };
  }
  return { id: e.id, kind: 'cancelado', text: `${e.title}. ${at}${reason}`, credit };
}

/** Su retraso, por escalones como el de un servicio seguido (los de debajo, callados: no se avisa si mejora). */
function delayFacts(x, t, delayMin, creditOf) {
  const { v } = x;
  const level = Math.floor((v.delay - delayMin) / DELAY_STEP);
  const fact = {
    id: `${v.id}|retraso|${level}`,
    kind: 'retraso',
    text: `${trainName(v)}, ${theOne(x.dep, t.origin)}, va con ${v.delay} min de retraso.${v.next ? ` Próxima parada: ${v.next}.` : ''}`,
    credit: creditOf(v.source, v.operator) ?? null,
  };
  return [fact, ...Array.from({ length: level }, (_, l) => ({ ...fact, id: `${v.id}|retraso|${l}`, silent: true }))];
}

/**
 * Lo que pasa ahora con cada trayecto seguido (los hechos de avisos.js, con los mismos ids): las cancelaciones
 * de sus trenes y las paradas suprimidas en su origen o su destino, los trenes sin datos y el retraso de los que van
 * con `delayMin` o más (un hecho por escalón). Las cancelaciones que su fuente ya no publica, no.
 * @param {{ keys: Iterable<string>, vehicles?: object[], events?: object[], now: number,
 *           stationOf?: (code: string) => object|null, stopsOf?: (id: string) => object[]|null,
 *           creditOf?: (source: string, operator?: string) => string|null, delayMin?: number }} ctx
 * @returns {Map<string, import('./avisos.js').Fact[]>}
 */
export function collectTrayectoFacts({ keys, vehicles = [], events = [], now, stationOf = () => null, stopsOf = () => null, creditOf = () => null, delayMin = DELAY_MIN }) {
  const out = new Map();
  const trayectos = [];
  for (const key of keys) {
    const t = followKind(key) === 'trayecto' ? trayectoStations(key, stationOf) : null;
    if (t) trayectos.push([key, t]);
  }
  if (!trayectos.length) return out;
  // Sólo los que van con retraso: sus paradas, una vez para todos los trayectos.
  const late = passIndex(vehicles.filter((v) => v?.delay >= delayMin), stopsOf);
  for (const [key, t] of trayectos) {
    const facts = [];
    const add = (f) => {
      if (!facts.some((x) => x.id === f.id)) facts.push(f);
    };
    for (const x of eventTrains(t, events, now)) if (!x.withdrawn) add(eventFact(x, t, creditOf));
    for (const x of vehicleTrains(t, late, now)) for (const f of delayFacts(x, t, delayMin, creditOf)) add(f);
    if (facts.length) out.set(key, facts);
  }
  return out;
}

function delayWords(v) {
  if (v.delay === null || v.delay === undefined) return v.late ? 'con retraso (no dice cuánto)' : 'sin dato de retraso';
  return v.delay >= 5 ? `con ${v.delay} min de retraso` : v.delay > 0 ? `con ${v.delay} min` : 'en hora';
}

/**
 * Cómo va ahora un trayecto (para /estado, al seguirlo y en el parte): los trenes de su franja que se ven, por su
 * hora en el origen. Los que circulan, con su retraso; los cancelados, sin parar en el origen o el destino o sin
 * datos (de los que salían hace más de GONE_MIN, nada: ya no son de los próximos). El mismo tren cancelado y
 * circulando se cuenta una vez, como cancelado.
 * @param {string} key
 * @param {{ vehicles?: object[], events?: object[], now: number, stationOf?: (code: string) => object|null,
 *           stopsOf?: (id: string) => object[]|null, creditOf?: (source: string, operator?: string) => string|null,
 *           index?: Map<string, Array<{ v: object, stops: object[] }>> }} ctx  index: passIndex de la ronda (si no, se hace)
 * @returns {{ lines: string[], credits: string[] }}
 */
export function trayectoStatus(key, { vehicles = [], events = [], now, stationOf = () => null, stopsOf = () => null, creditOf = () => null, index = null }) {
  const t = trayectoStations(key, stationOf);
  if (!t) return { lines: ['Alguna de las estaciones de este trayecto ya no está en el catálogo del radar.'], credits: [] };
  const credits = new Set();
  const nowAt = order(madridAt(now));
  const recent = (x) => order(x.dep) >= nowAt - GONE_MIN;
  const found = eventTrains(t, events, now).filter(recent);
  const live = found.filter((x) => !x.withdrawn);
  const withdrawn = found.length - live.length;
  const told = new Set(live.flatMap((x) => serviceKeys(x.e.trip?.follow)));
  const running = vehicleTrains(t, index ?? passIndex(vehicles, stopsOf), now).filter((x) => !serviceKeys(x.v.follow).some((k) => told.has(k)));
  const trains = [...live, ...running].sort((a, b) => order(a.dep) - order(b.dep));
  const lines = [];
  if (!trains.length) {
    lines.push(!(t.days & (1 << weekday(madridDay(now))))
      ? `Hoy no es uno de tus días: te aviso ${daysText(t.days)}.`
      : `Ahora no se ve ningún tren de tu franja de ${t.origin.name} a ${t.destination.name}. Los trenes salen aquí cuando empiezan su recorrido, y las cancelaciones, cuando su operador las publica.`);
  } else lines.push(`Trenes de tu franja que se ven ahora (hora en ${t.origin.name}):`);
  for (const x of trains.slice(0, STATUS_TRAINS)) {
    const when = `${hhmm(x.dep.min)}${x.dep.estimated ? ' (aprox.)' : ''}`;
    if (x.kind === 'circula') {
      const v = x.v;
      lines.push(`- ${when} ${trainName(v)}: circula ${delayWords(v)}${x.gone ? `, ya ha salido de ${t.origin.name}` : ''}.${v.next ? ` Próxima parada: ${v.next}.` : ''}`);
      const c = creditOf(v.source, v.operator);
      if (c) credits.add(c);
    } else {
      const what = x.kind === 'cancelado' ? 'cancelado' : x.kind === 'parcial' ? `n${skippedText(x, t).slice(1)}`
        : 'sin datos, su operador no publica nada de él';
      lines.push(`- ${when} ${tripName(x.e.trip)}: ${what}.`);
      const c = creditOfEvent(x.e, creditOf);
      if (c) credits.add(c);
    }
  }
  if (trains.length > STATUS_TRAINS) lines.push(`…y ${trains.length - STATUS_TRAINS} más.`);
  if (withdrawn) {
    lines.push(withdrawn === 1 ? 'Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule.'
      : `Además, ${withdrawn} que se habían cancelado y su operador ya no publica: puede que al final circulen.`);
  }
  return { lines, credits: [...credits] };
}

// ---------------------------------------------------------------------------------------------------------------
// Textos de la orden

/** Qué hace /trayecto y cómo se escribe. */
export function trayectoHelpText({ delayMin = DELAY_MIN } = {}) {
  return [
    `Dime las dos estaciones, la franja en la que sales y los días:\n${EXAMPLE}`,
    `Te aviso de los trenes que paran en las dos y salen de la primera en esa franja: si se cancelan o no paran en alguna de las dos, si van con ${delayMin} min de retraso o más (y otra vez si empeora) y si su operador no publica nada de ellos.`,
    'Los días: L-V, S-D, L,X,V, «laborables»… Sin días, todos. Las estaciones, como en el mapa; si hay varias con ese nombre, te pregunto cuál.',
  ].join('\n\n');
}

/** Lo que se contesta si no se entiende o no se encuentra (error de parseTrayectoText o de trayectoOptions). */
export function trayectoErrorText(r) {
  switch (r.error) {
    case 'flecha': return `Separa las dos estaciones con «>»:\n${EXAMPLE}`;
    case 'estaciones': return `Dime la estación de origen y la de destino:\n${EXAMPLE}`;
    case 'franja': return `Dime también la franja en la que sales del origen, de una hora a otra:\n${EXAMPLE}`;
    case 'horas': return 'La franja tiene que ir de una hora a otra más tarde del mismo día, como 7:00-9:00 (como mucho, hasta las 23:59).';
    case 'dias': return `No entiendo los días «${r.days}». Escríbelos así: L-V, S-D, L,X,V, «laborables» o «todos».`;
    case 'origen':
    case 'destino': return `No encuentro la estación «${r.text}» en el catálogo del radar. Escríbela como en el mapa («Alcalá de Henares», «Madrid-Atocha Cercanías»).`;
    case 'misma': return 'El origen y el destino son la misma estación.';
    case 'red': return `${r.text} no son de la misma red: ningún tren para en las dos.`;
    default: return `No entiendo ese trayecto. Escríbelo así:\n${EXAMPLE}`;
  }
}
