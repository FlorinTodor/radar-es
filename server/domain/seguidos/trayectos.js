// «Mi trayecto»: seguir los trenes de una estación a otra en una franja horaria y unos días, sin saber su número
// («/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V»). Qué se escribe (parseTrayectoText), qué estaciones son
// (trayectoOptions), qué trenes encajan (los que paran en el origen y luego en el destino y salen del origen en la
// franja uno de esos días), qué se avisa de ellos (cancelados o sin parar en una de las dos, con retraso, sin
// datos) y cómo van (para /estado y el parte). Vale para cualquier fuente que diga las paradas de sus viajes: todo
// sale de las paradas de las cancelaciones y de cada vehículo y de las estaciones del catálogo, comparadas como en
// la ficha de una estación (mismo nombre y cerca). Los textos, en el idioma de quien los recibe (`tr`, de
// idioma.js; en español si no se dice), y lo que se escribe, en español o en inglés («L-V», «Mon-Fri»). Puro: sin
// red, ni reloj, ni disco (la hora llega en `now`; las paradas de cada vehículo, de `stopsOf`).
import { ALL_DAYS, describeFollow, followKind, parseFollowKey, trayectoKey } from '../seguir.js';
import { modeInfo } from '../modos.js';
import { distanceKm } from '../geo.js';
import { DELAY_MIN, DELAY_STEP, madridDay, madridHourMinute, nearStation, plainStop, tripsAt, vehicleName } from './avisos.js';
import { cutText, sourceText } from './texto.js';
import { sameNetwork, stationCandidates, stationLabel } from './estaciones.js';
import { ES } from './idioma.js';

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
/** En la lista de trayectos posibles, uno que ningún tren visto une y cuyas estaciones están más lejos que esto, fuera
 * (si queda alguno más): «Alcalá de Chivert → Madrid-Atocha Cercanías» no es lo que quiere quien escribe «Alcalá». */
const FAR_KM = 150;
/** Cómo se escribe un trayecto, en el idioma del chat (con su orden: /trayecto, /journey). */
const example = ({ t }) => t('/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V');

const clip = (s, n) => cutText(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
// Los textos de las fuentes (avisos, motivos) van enteros, como piden sus licencias, con sus saltos de línea (sourceText).
const whole = sourceText;
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
// Lo de cada día que se pregunta mucho (unos pocos días a la vez: ayer, hoy y mañana), sin crear fechas cada vez.
const DAYS = new Map(); // «AAAA-MM-DD» → { weekday, minutes }
function dayInfo(day) {
  let info = DAYS.get(day);
  if (!info) {
    if (DAYS.size > 64) DAYS.clear();
    const ms = Date.parse(`${day}T00:00:00Z`);
    DAYS.set(day, (info = { weekday: (new Date(ms + 12 * 3600_000).getUTCDay() + 6) % 7, minutes: Math.round(ms / 60_000) }));
  }
  return info;
}
/** Día de la semana de una fecha «AAAA-MM-DD»: 0 el lunes… 6 el domingo (como la máscara de días). */
export const weekday = (day) => dayInfo(day).weekday;
/** Un instante como día y minuto de Madrid. */
const madridAt = (ms) => ({ day: madridDay(ms), min: toMin(madridHourMinute(ms)) });
/** Para ordenar y comparar días y minutos: minutos desde 1970 (en hora de Madrid, sin más). */
const order = ({ day, min }) => dayInfo(day).minutes + min;
/**
 * La hora de Madrid de una consulta, una vez (formatear con Intl en cada tren y cada trayecto costaba la mitad de la
 * ronda): el instante, el día, el minuto y su orden.
 * @returns {{ now: number, today: string, min: number, at: number }}
 */
function clockOf(now) {
  const { day, min } = madridAt(now);
  return { now, today: day, min, at: order({ day, min }) };
}

// ---------------------------------------------------------------------------------------------------------------
// Lo que se escribe

/** ¿Parece un trayecto? («Alcalá > Atocha 7-9», sin orden: se busca como tal) */
export const looksLikeTrayecto = (text) => /[>→⟶]/.test(String(text ?? ''));

const ARROW = /\s*(?:[-=–—]?>|→|⟶)\s*/;
// La franja: «7:00-9:00», «7-9», «07.30 a 09.00», «de 7 a 9h», «entre las 7 y las 9»; en inglés, «from 7 to 9»,
// «between 18 and 20». La última que haya.
// Con «am» o «pm» detrás de cada hora («7pm-9pm», «from 7am to 9am», «7-9pm»).
const RANGE = /(?:^|\s)(?:(?:de|entre|from|between)\s+)?(?:las\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*(?:([ap])\.?\s?m\.?)?\s*h?\s*(?:-|–|—|\ba\b|\by\b|\bhasta\b|\bto\b|\band\b)\s*(?:las\s+)?(\d{1,2})(?:[:.h](\d{2}))?\s*(?:([ap])\.?\s?m\.?)?\s*h?(?=[\s,.;]|$)/gi;
// Algo que parece una franja con horas que no lo son («99-100»): se dice que la hora no vale, no que falta la franja.
const BAD_RANGE = /(?:^|\s)\d+(?:[:.h]\d+)?\s*(?:[ap]\.?\s?m\.?)?\s*h?\s*(?:-|–|—|\ba\b|\bhasta\b|\bto\b)\s*\d+/i;
/** Una hora con «am» o «pm» (de 1 a 12) en 24 h; sin, tal cual. NaN si no vale. */
const hour24 = (h, ap) => {
  if (!ap) return Number(h);
  const n = Number(h);
  return n >= 1 && n <= 12 ? (n % 12) + (ap.toLowerCase() === 'p' ? 12 : 0) : NaN;
};
// Los días, en español y en inglés («Mon-Fri», «Saturdays and Sundays»): ningún nombre de uno es el de otro.
const DAY_NAMES = [
  ['l', 'lu', 'lun', 'lunes', 'mon', 'monday', 'mondays'], ['m', 'ma', 'mar', 'martes', 'tue', 'tues', 'tuesday', 'tuesdays'],
  ['x', 'mi', 'mie', 'mier', 'miercoles', 'wed', 'wednesday', 'wednesdays'], ['j', 'ju', 'jue', 'jueves', 'thu', 'thur', 'thurs', 'thursday', 'thursdays'],
  ['v', 'vi', 'vie', 'viernes', 'fri', 'friday', 'fridays'], ['s', 'sa', 'sab', 'sabado', 'sabados', 'sat', 'saturday', 'saturdays'],
  ['d', 'do', 'dom', 'domingo', 'domingos', 'sun', 'sunday', 'sundays'],
];
const DAY_OF = new Map(DAY_NAMES.flatMap((names, i) => names.map((n) => [n, i])));
const ALL_RE = /^(?:todos|todos los dias|toda la semana|diario|a diario|cada dia|siempre|every day|everyday|daily|all week|all days)$/;
const WORKDAYS_RE = /^(?:laborables|dias laborables|entre semana|weekdays|on weekdays|working days|workdays)$/;
const WEEKEND_RE = /^(?:fin de semana|fines de semana|finde|findes|los fines de semana|weekend|weekends|at weekends|at the weekend|on weekends)$/;

/**
 * Los días que dice un texto, como máscara (bit 0 el lunes): «L-V», «de lunes a viernes», «S-D», «L,X,V», «LXV»,
 * «sábados y domingos», «V-L» (de viernes a lunes), «laborables», «fin de semana», «todos»; y en inglés, «Mon-Fri»,
 * «Monday to Friday», «Mon,Wed,Fri», «Saturdays and Sundays», «weekdays», «weekends», «every day». Sin nada, todos.
 * @returns {number|null}  null si no se entiende
 */
export function parseDays(text) {
  const t = String(text ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[.;]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return ALL_DAYS;
  if (ALL_RE.test(t)) return ALL_DAYS;
  if (WORKDAYS_RE.test(t)) return 0x1f;
  if (WEEKEND_RE.test(t)) return 0x60;
  const words = t.replace(/\s*(?:-|–|—)\s*/g, '-').replace(/\s+(?:a|al|hasta|to|through|till|until)\s+/g, '-').split(/[\s,/]+/)
    .filter((w) => w && !['de', 'los', 'las', 'el', 'y', 'e', 'cada', 'on', 'and', 'every', 'from'].includes(w));
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

// Los días también pueden ir antes de la franja («Atocha L-V 7-9», «Atocha Mon-Fri 7-9»): lo que se reconoce como
// días al final del destino. Sólo con un guion, una coma o una palabra de días entera, para no comerse una estación
// que acabe en «D».
const DAYS_TAIL = /\s+((?:de\s+)?(?:[LMXJVSD](?:\s*[-,]\s*[LMXJVSD])+|[LMXJVSD]{2,7}|(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|laborables|entre semana|fin(?:es)? de semana|finde|todos(?: los d[ií]as)?|diario)(?:(?:\s*(?:-|,|\by\b|\ba\b)\s*)(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?))*|(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:\s*[-,]\s*(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun))+|(?:weekdays|weekends?|every day|daily|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)(?:\s*(?:-|,|\band\b|\bto\b)\s*(?:mon|tues|wednes|thurs|fri|satur|sun)days?)*))$/i;

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
  const rest = parts[1].trim();
  const ranges = [...rest.matchAll(RANGE)];
  if (!origin) return { error: 'estaciones' };
  if (!ranges.length) return { error: BAD_RANGE.test(rest) ? 'horas' : 'franja' };
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
  const [, h1raw, m1 = '00', ap1, h2raw, m2 = '00', ap2] = m;
  const h2 = hour24(h2raw, ap2);
  // «7-9pm»: la primera, también de la tarde si así va antes que la segunda (19-21); «11-1pm», no (11-13).
  let h1 = hour24(h1raw, ap1);
  if (!ap1 && ap2 && Number(h1raw) <= 12 && hour24(h1raw, ap2) * 60 + Number(m1) < h2 * 60 + Number(m2)) h1 = hour24(h1raw, ap2);
  const from = h1 * 60 + Number(m1);
  // «hasta las 24» es hasta el final del día.
  const to = h2 === 24 && Number(m2) === 0 ? 24 * 60 - 1 : h2 * 60 + Number(m2);
  if (!(h1 <= 23) || Number(m1) > 59 || !(h2 <= 24) || Number(m2) > 59 || from >= to || to > 24 * 60 - 1) return { error: 'horas' };
  const days = parseDays(daysPart);
  if (days === null) return { error: 'dias', days: clip(daysPart, 40) };
  return { origin, destination, from, to, days };
}

// ---------------------------------------------------------------------------------------------------------------
// Las estaciones

/**
 * Los trayectos que puede querer decir lo escrito: las estaciones del catálogo que encajan con el origen y con el
 * destino, de dos en dos (distintas y de la misma red: un tren de Renfe no para en una de metro), con su clave y
 * su nombre. Primero con las que se llaman tal cual (si las hay); si así no sale ninguno de la misma red, con todas
 * las que encajan («Sants > Aeroport»: «Aeroport» se llama una de Metrovalencia, pero hay otras en Barcelona).
 * Primero los que une algún tren que se ve (`connects`: vehículos con sus paradas y cancelaciones), en el orden de la
 * búsqueda; luego los demás, por la distancia entre sus estaciones; los muy lejanos que ningún tren une, fuera (si
 * queda alguno).
 * @param {import('./estaciones.js').CatalogStation[]} stations
 * @param {{ origin: string, destination: string, from: number, to: number, days: number }} parsed  de parseTrayectoText
 * @param {{ limit?: number, connects?: ((o: object, d: object) => boolean)|null }} [opts]
 * @returns {{ error: 'origen'|'destino'|'misma'|'red', text?: string, origin?: string, destination?: string }
 *   | { pairs: Array<{ key: string, name: string, label: string }>, total: number }}
 *   red: origin y destination, las primeras que encajan (sus nombres en una lista)
 */
export function trayectoOptions(stations, parsed, { limit = 8, connects = null } = {}) {
  const origins = stationCandidates(stations, parsed.origin, { limit: OPTIONS_SIDE_MAX });
  if (!origins.exact.length && !origins.partial.length) return { error: 'origen', text: clip(parsed.origin, 60) };
  const destinations = stationCandidates(stations, parsed.destination, { limit: OPTIONS_SIDE_MAX });
  if (!destinations.exact.length && !destinations.partial.length) return { error: 'destino', text: clip(parsed.destination, 60) };
  const preferred = (c) => (c.exact.length ? c.exact : c.partial);
  const every = (c) => [...c.exact, ...c.partial];
  const combine = (os, ds) => {
    const pairs = [];
    let same = 0;
    for (const o of os) {
      for (const d of ds) {
        if (o.code === d.code) {
          same++;
          continue;
        }
        if (!sameNetwork(o, d)) continue;
        const key = trayectoKey({ origin: o.code, destination: d.code, from: parsed.from, to: parsed.to, days: parsed.days });
        if (key) pairs.push({ key, o, d });
      }
    }
    return { pairs, same };
  };
  let found = combine(preferred(origins), preferred(destinations));
  if (!found.pairs.length) found = combine(every(origins), every(destinations));
  if (!found.pairs.length) {
    return found.same ? { error: 'misma' } : { error: 'red', origin: stationLabel(preferred(origins)[0]), destination: stationLabel(preferred(destinations)[0]) };
  }
  const ranked = found.pairs.map((p, i) => {
    const km = Number.isFinite(p.o.lat) && Number.isFinite(p.d.lat) ? distanceKm(p.o.lat, p.o.lon, p.d.lat, p.d.lon) : Infinity;
    return { ...p, i, km, linked: Boolean(connects?.(p.o, p.d)) };
  });
  const near = ranked.filter((p) => p.linked || p.km <= FAR_KM);
  // Los que une un tren, en el orden de la búsqueda (primero los nombres que encajan mejor); los demás, por distancia.
  const list = (near.length ? near : ranked).sort((a, b) => Number(b.linked) - Number(a.linked) || (a.linked ? 0 : a.km - b.km) || a.i - b.i);
  const pairs = list.map(({ key, o, d }) => ({
    key, name: describeFollow(key, { originName: o.name, destinationName: d.name }), label: `${o.name} → ${d.name}${o.network ? ` · ${o.network}` : ''}`,
  }));
  return { pairs: pairs.slice(0, limit), total: pairs.length };
}

/**
 * ¿Une algún tren que se ve ahora estas dos estaciones, en este orden? Los vehículos que dicen sus paradas (`index`,
 * de passIndex) y las cancelaciones y trenes sin datos con las suyas (`events`).
 * @param {{ index?: Map<string, Array<{ v: object, stops: object[] }>>, events?: object[] }} seen
 * @returns {(o: object, d: object) => boolean}
 */
export function connectedBy({ index = new Map(), events = [] } = {}) {
  return (o, d) => {
    for (const { stops } of index.get(stationName(o)) ?? []) if (legOf(stops, o, d)) return true;
    for (const { e, here } of tripsAt(events, o)) {
      const stops = e.trip.stops;
      if (stopIndexIn(stops, d, stops.indexOf(here) + 1) >= 0) return true;
    }
    return false;
  };
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

/**
 * Lo que tiene mal un trayecto que llega por un enlace (que se puede inventar), con las mismas comprobaciones que
 * /trayecto: que sus estaciones sean distintas y de la misma red. null si está bien (o no es un trayecto); si alguna
 * estación no está en el catálogo, eso lo dice trayectoName.
 * @returns {{ error: 'misma' } | { error: 'red', origin: string, destination: string } | null}
 */
export function trayectoProblem(key, stationOf) {
  const t = trayectoStations(key, stationOf);
  if (!t) return null;
  if (t.origin.code === t.destination.code) return { error: 'misma' };
  return sameNetwork(t.origin, t.destination) ? null : { error: 'red', origin: stationLabel(t.origin), destination: stationLabel(t.destination) };
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
// El nombre comparable de cada estación del catálogo, una vez mientras viva su objeto.
const STATION_NAMES = new WeakMap();
const stationName = (station) => {
  let name = STATION_NAMES.get(station);
  if (name === undefined) STATION_NAMES.set(station, (name = plainStop(station.name)));
  return name;
};
/** Dónde está una estación en una lista de paradas, desde `from`: como en su ficha, mismo nombre y cerca. -1 si no está. */
function stopIndexIn(stops, station, from = 0) {
  const names = namesOf(stops);
  const name = stationName(station);
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
function nearestDay(clock, min) {
  const diff = min - clock.min;
  return diff > 720 ? addDays(clock.today, -1) : diff < -720 ? addDays(clock.today, 1) : clock.today;
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
  return departureAt(v, stops, o, clockOf(now));
}

function departureAt(v, stops, o, clock) {
  const delay = Number.isFinite(v.delay) ? v.delay : 0;
  const scheduled = toMin(stops[o]?.time);
  if (scheduled !== null) return { day: nearestDay(clock, scheduled), min: scheduled, estimated: false };
  const eta = stops[o]?.passed ? null : toMin(stops[o]?.eta);
  if (eta !== null) {
    const min = (((eta - delay) % 1440) + 1440) % 1440;
    return { day: nearestDay(clock, min), min, estimated: true };
  }
  const km = kmTo(v, stops, o);
  if (km === null) return null;
  return { ...madridAt(clock.now + (km / ESTIMATE_KMH) * 3600_000 - delay * 60_000), estimated: true };
}

/** Cuántas veces pasa de medianoche un viaje desde su primera parada hasta la `o` (sus horas ya van de 00 a 23). */
function midnightsUpTo(stops, o) {
  let days = 0;
  let prev = null;
  for (let i = 0; i <= o; i++) {
    const min = toMin(stops[i]?.time);
    if (min === null) continue;
    if (prev !== null && min < prev) days++;
    prev = min;
  }
  return days;
}

/**
 * Cuándo salía del origen (la parada `o`) el tren de una cancelación (o sin datos), por su horario. Con fecha (el día
 * de servicio de su horario), ese día, y uno más por cada medianoche que pasa antes de llegar al origen (una hora de
 * su horario de las 24:00 o más llega como 00-23: sin esto quedaba 24 h antes). Sin fecha (Renfe no la da en las de
 * hoy), de hoy; de madrugada, si salía de noche, de anoche.
 */
function eventDeparture(trip, stops, o, clock) {
  const min = toMin(stops[o]?.time);
  if (min === null) return null;
  const date = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(trip?.date ?? ''));
  if (date) {
    const day = `${date[1]}-${date[2]}-${date[3]}`;
    const late = midnightsUpTo(stops, o);
    return { day: late ? addDays(day, late) : day, min, estimated: false };
  }
  const late = clock.min < 4 * 60 && min >= 20 * 60;
  return { day: late ? addDays(clock.today, -1) : clock.today, min, estimated: false };
}

/** ¿Sale del origen en la franja, uno de los días del trayecto? */
const inWindow = (t, dep) => Boolean(t.days & (1 << weekday(dep.day))) && dep.min >= t.from && dep.min <= t.to;

// Lo que pasa entre dos estaciones no depende de la franja ni de los días de cada trayecto: se busca una vez por par
// origen-destino y consulta (la lista de sucesos o el índice de vehículos de la ronda, a una hora), y cada trayecto
// sólo mira cuáles salen en su franja. Con 1.500 trayectos y 60 cancelaciones se hacía todo 90.000 veces por ronda.
const EVENT_LEGS = new WeakMap(); // lista de sucesos → { now, size, byPair }
const VEHICLE_LEGS = new WeakMap(); // índice de vehículos (passIndex) → { now, byPair }
const pairOf = (t) => `${t.origin.code}>${t.destination.code}`;
function memoByPair(cache, list, t, clock, compute) {
  let entry = cache.get(list);
  if (!entry || entry.now !== clock.now || (Array.isArray(list) && entry.size !== list.length)) {
    entry = { now: clock.now, size: list.length, byPair: new Map() };
    cache.set(list, entry);
  }
  const k = pairOf(t);
  let legs = entry.byPair.get(k);
  if (!legs) entry.byPair.set(k, (legs = compute()));
  return legs;
}

/**
 * Las cancelaciones, paradas suprimidas y trenes sin datos del trayecto: los que pasaban por el origen y luego por
 * el destino y salían del origen en la franja. De los que cancelan sólo algunas paradas, si una es el origen o el
 * destino; de los sin datos, si según su horario aún no ha llegado al destino. Las retiradas (su operador ya no las
 * publica) van marcadas. `end`: cuándo llegaba al destino según su horario (o, si no se sabe, GONE_MIN después de
 * salir del origen), como `order`.
 */
function eventTrains(t, events, clock) {
  return eventLegs(t, events, clock).filter((x) => inWindow(t, x.dep));
}

/** Las de eventTrains de un par de estaciones, sin mirar la franja ni los días: una vez por par y consulta. */
function eventLegs(t, events, clock) {
  return memoByPair(EVENT_LEGS, events, t, clock, () => {
    const out = [];
    for (const { e, here } of tripsAt(events, t.origin)) {
      const stops = e.trip.stops;
      const o = stops.indexOf(here);
      const d = o < 0 ? -1 : stopIndexIn(stops, t.destination, o + 1);
      if (d < 0) continue;
      const dep = eventDeparture(e.trip, stops, o, clock);
      if (!dep) continue;
      let kind;
      if (e.category === 'sin-datos') {
        if (stops[d].passed) continue;
        kind = 'sin-datos';
      } else if (e.type !== 'parcial') kind = 'cancelado';
      else if (stops[o].skipped || stops[d].skipped) kind = 'parcial';
      else continue;
      const arrival = toMin(stops[d].time);
      const end = order(dep) + (arrival === null ? GONE_MIN : (arrival - dep.min + 1440) % 1440);
      out.push({ kind, e, dep, at: order(dep), end, o: stops[o], d: stops[d], withdrawn: Boolean(e.withdrawn) });
    }
    return out;
  });
}

/** Los vehículos del trayecto (index: passIndex): los que paran en el origen y luego en el destino, aún no han pasado
 * por el destino y salen (o han salido) del origen en la franja. */
function vehicleTrains(t, index, clock) {
  return vehicleLegs(t, index, clock).filter((x) => inWindow(t, x.dep));
}

/** Los de vehicleTrains de un par de estaciones, sin mirar la franja ni los días: una vez por par y consulta. */
function vehicleLegs(t, index, clock) {
  return memoByPair(VEHICLE_LEGS, index, t, clock, () => {
    const out = [];
    for (const { v, stops } of index.get(plainStop(t.origin.name)) ?? []) {
      const leg = legOf(stops, t.origin, t.destination);
      if (!leg || stops[leg.d].passed) continue;
      const dep = departureAt(v, stops, leg.o, clock);
      if (!dep) continue;
      out.push({ kind: 'circula', v, dep, at: order(dep), gone: Boolean(stops[leg.o].passed) });
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Qué se avisa y cómo van

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/**
 * Cómo se llama un vehículo: por su servicio, con su línea («Cercanías C2 21518», «AVE 02202») o, si no tiene, por su
 * línea; con nuestras palabras en el idioma de `tr` («Autobús 27» → «Bus 27»).
 */
function trainName(v, tr) {
  const keys = Array.isArray(v.follow) ? v.follow : [];
  const service = keys.find((k) => followKind(k) === 'servicio');
  if (service && parseFollowKey(service).number !== undefined) {
    return tr.name(describeFollow(service, { operator: v.operator, service: v.service ?? undefined, line: v.line ?? undefined, number: v.label ?? undefined }));
  }
  const key = service ?? keys.find((k) => followKind(k) === 'linea');
  return key ? tr.name(vehicleName(v, key)) : `${capital(tr.noun(v.mode))}${v.line ? ` ${v.line}` : ''}`;
}
/** Cómo se llama el tren de una cancelación: «Cercanías C2 21516», «AVE 02202». */
const tripName = (trip, { t }) => [trip.service ?? trip.operator, trip.line && trip.line !== trip.service ? trip.line : null, trip.number]
  .filter(Boolean).join(' ') || t('Un tren');
const serviceKeys = (follow) => (Array.isArray(follow) ? follow.filter((k) => followKind(k) === 'servicio') : []);
const creditOfEvent = (e, creditOf) => e.credit ?? creditOf(e.source, e.trip?.operator) ?? null;
/** «el de las 07:42 en Alcalá de Henares» (con «hora aproximada» si es una estimación). */
const theOne = (dep, station, { t }) => (dep.estimated ? t('el de las {time} en {station} (hora aproximada)', { time: hhmm(dep.min), station: station.name })
  : t('el de las {time} en {station}', { time: hhmm(dep.min), station: station.name }));

/** «No para en …» (en un aviso) o, con `lower`, «no para en …» (en una línea de /estado). */
function skippedText(x, way, { t }, { lower = false } = {}) {
  if (x.o.skipped && x.d.skipped) {
    const at = { origin: way.origin.name, destination: way.destination.name };
    return lower ? t('no para en {origin} ni en {destination}', at) : t('No para en {origin} ni en {destination}', at);
  }
  const at = { station: x.o.skipped ? way.origin.name : way.destination.name };
  return lower ? t('no para en {station}', at) : t('No para en {station}', at);
}

// El título de una cancelación lo escribe nuestro servidor (domain/cancelaciones.js): en el idioma del chat, con las
// plantillas de la web. El motivo y el aviso del operador son suyos: tal cual.
function eventFact(x, way, creditOf, tr) {
  const { e } = x;
  const { t } = tr;
  const credit = creditOfEvent(e, creditOf);
  const title = tr.server(e.title, e.source);
  const at = t('Pasaba por {station} a las {time}.', { station: way.origin.name, time: hhmm(x.dep.min) });
  if (x.kind === 'sin-datos') return { id: e.id, kind: 'sin-datos', text: `${title}. ${t('No se sabe si circula: su operador no publica nada de él.')} ${at}`, credit };
  const reason = e.trip?.reason ? ` ${t('Motivo: {reason}', { reason: whole(e.trip.reason) })}`
    : e.trip?.notice?.text ? ` ${t('Aviso del operador: {notice}', { notice: whole(e.trip.notice.text) })}` : '';
  if (x.kind === 'parcial') {
    // Si el título ya nombra la estación suprimida («no para en Alcalá de Henares»), no se repite.
    const named = [x.o.skipped && way.origin, x.d.skipped && way.destination].filter(Boolean).every((st) => plainStop(e.title).includes(plainStop(st.name)));
    return { id: e.id, kind: 'parcial', text: `${title}.${named ? '' : ` ${skippedText(x, way, tr)}.`} ${at}${reason}`, credit };
  }
  return { id: e.id, kind: 'cancelado', text: `${title}. ${at}${reason}`, credit };
}

/** Su retraso, por escalones como el de un servicio seguido (los de debajo, callados: no se avisa si mejora). */
function delayFacts(x, way, delayMin, creditOf, tr) {
  const { v } = x;
  const { t } = tr;
  const level = Math.floor((v.delay - delayMin) / DELAY_STEP);
  const fact = {
    id: `${v.id}|retraso|${level}`,
    kind: 'retraso',
    text: `${t('{train}, {which}, va con {n} min de retraso.', { train: trainName(v, tr), which: theOne(x.dep, way.origin, tr), n: v.delay })}`
      + `${v.next ? ` ${t('Próxima parada: {stop}.', { stop: v.next })}` : ''}`,
    credit: creditOf(v.source, v.operator) ?? null,
  };
  return [fact, ...Array.from({ length: level }, (_, l) => ({ ...fact, id: `${v.id}|retraso|${l}`, silent: true }))];
}

/**
 * Lo que pasa ahora con cada trayecto seguido (los hechos de avisos.js, con los mismos ids): las cancelaciones
 * de sus trenes y las paradas suprimidas en su origen o su destino, los trenes sin datos y el retraso de los que van
 * con `delayMin` o más (un hecho por escalón). Las cancelaciones que su fuente ya no publica, no; ni las de un tren
 * que según su horario ya habría llegado al destino. Los textos, en el idioma de `tr` (los mismos ids en todos).
 * @param {{ keys: Iterable<string>, vehicles?: object[], events?: object[], now: number,
 *           stationOf?: (code: string) => object|null, stopsOf?: (id: string) => object[]|null,
 *           creditOf?: (source: string, operator?: string) => string|null, delayMin?: number,
 *           tr?: import('./idioma.js').Translator }} ctx
 * @returns {Map<string, import('./avisos.js').Fact[]>}
 */
export function collectTrayectoFacts({
  keys, vehicles = [], events = [], now, stationOf = () => null, stopsOf = () => null, creditOf = () => null, delayMin = DELAY_MIN, tr = ES,
}) {
  const out = new Map();
  const trayectos = [];
  for (const key of keys) {
    const way = followKind(key) === 'trayecto' ? trayectoStations(key, stationOf) : null;
    if (way) trayectos.push([key, way]);
  }
  if (!trayectos.length) return out;
  const clock = clockOf(now);
  // Sólo los que van con retraso: sus paradas, una vez para todos los trayectos.
  const late = passIndex(vehicles.filter((v) => v?.delay >= delayMin), stopsOf);
  // El texto de cada tren depende sólo de su par de estaciones (y del idioma): una vez por tren y par.
  const said = new WeakMap(); // tren de eventLegs/vehicleLegs → sus hechos
  const factsOf = (x, make) => {
    let list = said.get(x);
    if (!list) said.set(x, (list = make()));
    return list;
  };
  for (const [key, way] of trayectos) {
    const facts = [];
    const ids = new Set();
    const add = (f) => {
      if (ids.has(f.id)) return;
      ids.add(f.id);
      facts.push(f);
    };
    // De un tren que ya habría llegado al destino no se avisa: a esas horas ya no sirve de nada.
    for (const x of eventTrains(way, events, clock)) if (!x.withdrawn && x.end >= clock.at) for (const f of factsOf(x, () => [eventFact(x, way, creditOf, tr)])) add(f);
    for (const x of vehicleTrains(way, late, clock)) for (const f of factsOf(x, () => delayFacts(x, way, delayMin, creditOf, tr))) add(f);
    if (facts.length) out.set(key, facts);
  }
  return out;
}

/** Su retraso, con las mismas palabras que el de un servicio seguido (avisos.js statusOf). */
function delayWords(v, { t }) {
  if (v.delay === null || v.delay === undefined) return v.late ? t('con retraso (no dice cuánto)') : t('sin dato de retraso');
  return v.delay >= 5 ? t('con {n} min de retraso', { n: v.delay }) : v.delay > 0 ? t('con {n} min', { n: v.delay }) : t('en hora');
}

/**
 * Cómo va ahora un trayecto (para /estado, al seguirlo y en el parte): los trenes de su franja que se ven, por su
 * hora en el origen. Los que circulan, con su retraso; los cancelados, sin parar en el origen o el destino o sin
 * datos (de los que salían hace más de GONE_MIN, nada: ya no son de los próximos). El mismo tren cancelado y
 * circulando se cuenta una vez, como cancelado.
 * @param {string} key
 * @param {{ vehicles?: object[], events?: object[], now: number, stationOf?: (code: string) => object|null,
 *           stopsOf?: (id: string) => object[]|null, creditOf?: (source: string, operator?: string) => string|null,
 *           index?: Map<string, Array<{ v: object, stops: object[] }>>, tr?: import('./idioma.js').Translator }} ctx
 *   index: passIndex de la ronda (si no, se hace)
 * @returns {{ lines: string[], credits: string[] }}
 */
export function trayectoStatus(key, { vehicles = [], events = [], now, stationOf = () => null, stopsOf = () => null, creditOf = () => null, index = null, tr = ES }) {
  const { t } = tr;
  const way = trayectoStations(key, stationOf);
  if (!way) return { lines: [t('Alguna de las estaciones de este trayecto ya no está en el catálogo del radar.')], credits: [] };
  const credits = new Set();
  const clock = clockOf(now);
  const recent = (x) => x.at >= clock.at - GONE_MIN;
  const found = eventTrains(way, events, clock).filter(recent);
  const live = found.filter((x) => !x.withdrawn);
  const withdrawn = found.length - live.length;
  const told = new Set(live.flatMap((x) => serviceKeys(x.e.trip?.follow)));
  const running = vehicleTrains(way, index ?? passIndex(vehicles, stopsOf), clock).filter((x) => !serviceKeys(x.v.follow).some((k) => told.has(k)));
  const trains = [...live, ...running].sort((a, b) => a.at - b.at);
  const lines = [];
  const at = { origin: way.origin.name, destination: way.destination.name, station: way.origin.name };
  if (!trains.length) {
    lines.push(!(way.days & (1 << weekday(clock.today)))
      ? t('Hoy no es uno de tus días: te aviso {days}.', { days: tr.days(way.days) })
      : t('Ahora no se ve ningún tren de tu franja de {origin} a {destination}. Los trenes salen aquí cuando empiezan su recorrido, y las '
        + 'cancelaciones, cuando su operador las publica.', at));
  } else lines.push(t('Trenes de tu franja que se ven ahora (hora en {station}):', at));
  for (const x of trains.slice(0, STATUS_TRAINS)) {
    const when = x.dep.estimated ? t('{time} (aprox.)', { time: hhmm(x.dep.min) }) : hhmm(x.dep.min);
    if (x.kind === 'circula') {
      const v = x.v;
      const gone = x.gone ? `, ${t('ya ha salido de {station}', at)}` : '';
      lines.push(`- ${when} ${t('{name}: circula {delay}', { name: trainName(v, tr), delay: delayWords(v, tr) })}${gone}.`
        + `${v.next ? ` ${t('Próxima parada: {stop}.', { stop: v.next })}` : ''}`);
      const c = creditOf(v.source, v.operator);
      if (c) credits.add(c);
    } else {
      const what = x.kind === 'cancelado' ? t('cancelado') : x.kind === 'parcial' ? skippedText(x, way, tr, { lower: true })
        : t('sin datos, su operador no publica nada de él');
      lines.push(`- ${when} ${tripName(x.e.trip, tr)}: ${what}.`);
      const c = creditOfEvent(x.e, creditOf);
      if (c) credits.add(c);
    }
  }
  if (trains.length > STATUS_TRAINS) lines.push(t('…y {n} más.', { n: trains.length - STATUS_TRAINS }));
  if (withdrawn) {
    lines.push(tr.tn('Además, {n} que se había cancelado y su operador ya no publica: puede que al final circule.',
      'Además, {n} que se habían cancelado y su operador ya no publica: puede que al final circulen.', withdrawn));
  }
  return { lines, credits: [...credits] };
}

// ---------------------------------------------------------------------------------------------------------------
// Textos de la orden

/** Qué hace /trayecto y cómo se escribe, en el idioma del chat. */
export function trayectoHelpText({ delayMin = DELAY_MIN, tr = ES } = {}) {
  const { t } = tr;
  return [
    t('Dime las dos estaciones, la franja en la que sales y los días:\n{example}', { example: example(tr) }),
    t('Te aviso de los trenes que paran en las dos y salen de la primera en esa franja: si se cancelan o no paran en alguna de las dos, si van '
      + 'con {delay} min de retraso o más (y otra vez si empeora) y si su operador no publica nada de ellos.', { delay: delayMin }),
    t('Los días: L-V, S-D, L,X,V, «laborables»… Sin días, todos. Las estaciones, como en el mapa; si hay varias con ese nombre, te pregunto cuál.'),
  ].join('\n\n');
}

/** Lo que se contesta si no se entiende o no se encuentra (error de parseTrayectoText o de trayectoOptions), en el idioma del chat. */
export function trayectoErrorText(r, tr = ES) {
  const { t } = tr;
  const ex = { example: example(tr) };
  switch (r.error) {
    case 'flecha': return t('Separa las dos estaciones con «>»:\n{example}', ex);
    case 'estaciones': return t('Dime la estación de origen y la de destino:\n{example}', ex);
    case 'franja': return t('Dime también la franja en la que sales del origen, de una hora a otra:\n{example}', ex);
    case 'horas': return t('La franja tiene que ir de una hora a otra más tarde del mismo día, como 7:00-9:00 (como mucho, hasta las 23:59).');
    case 'dias': return t('No entiendo los días «{days}». Escríbelos así: L-V, S-D, L,X,V, «laborables» o «todos».', { days: r.days });
    case 'origen':
    case 'destino': return t('No encuentro la estación «{name}» en el catálogo del radar. Escríbela como en el mapa («Alcalá de Henares», «Madrid-Atocha Cercanías»).', { name: r.text });
    case 'misma': return t('El origen y el destino son la misma estación.');
    case 'red': return t('{origin} y {destination} no son de la misma red: ningún tren para en las dos.', { origin: r.origin, destination: r.destination });
    default: return t('No entiendo ese trayecto. Escríbelo así:\n{example}', ex);
  }
}
