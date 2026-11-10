// Avisos para quien sigue algo (un servicio, una línea, una parada o una provincia): qué pasa ahora con cada
// cosa seguida («hechos»: una cancelación, un retraso que pasa del umbral, un tren sin datos, un aviso del
// operador, un aviso naranja de AEMET…), cuáles son nuevos para cada suscripción y el texto de cada mensaje.
// Vale para cualquier tipo de vehículo: todo sale de las claves `follow` (domain/seguir.js) y del registro de
// tipos. Puro: sin red, ni reloj, ni disco (la hora llega en `now`).
import { answersTo, describeFollow, followKind, parseFollowKey, stopCode } from '../seguir.js';
import { eventInProvince, feltRadiusKm, provinceById } from '../provincias.js';
import { distanceKm } from '../geo.js';
import { quakeWhen } from '../sismos.js';
import { modeNoun } from '../modos.js';
import { cutText } from './texto.js';
import { noticesAtStation } from '../avisos-estacion.js';
import { noticeText, stationNoticeFact } from './estacion.js';
import { DAY_FACT_FORGET_MS, fireFacts, fireZones, gridFacts, isDayFact, provinceFacts } from './zona.js';

/** Retraso (min) a partir del cual se avisa, y cada cuánto más se vuelve a avisar si empeora. */
export const DELAY_MIN = 15;
export const DELAY_STEP = 15;
/** Un hecho que deja de verse tanto tiempo se olvida: si vuelve, es nuevo (el mismo tren, otro día). */
export const FACT_FORGET_MS = 3 * 3600_000;
export const SEEN_MAX = 100_000;
/** Hechos que se cuentan en un mensaje; del resto, cuántos son. */
const MAX_FACTS_PER_MESSAGE = 8;
/** Telegram admite 4.096 caracteres por mensaje: con margen. */
export const MESSAGE_MAX = 3800;
/** Mensajes, como mucho, de un /estado o un parte (cada cosa seguida, entera, en uno de ellos): con 20 cosas y sus
 * atribuciones caben casi siempre; si no, se dice cuántas faltan. */
export const MAX_MESSAGES = 6;
/** Una parada de una cancelación es esta estación si se llama igual y está a menos de esto (como en la ficha de
 * la estación de la web, public/js/station-board.js: así el bot y la web cuentan lo mismo). */
const STATION_KM = 3;

/** La suscripción a una provincia, en el mismo espacio que las claves `follow` (que nunca empiezan así). */
export const provinceSub = (id) => `prov:${id}`;

const MADRID_DATE_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const MADRID_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «10/11, 15:00» en hora de Madrid. */
export const fmtWhen = (ms) => (Number.isFinite(ms) ? MADRID_DATE_TIME.format(ms) : null);
/** «HH:MM» de un instante en hora de Madrid. */
export const madridHourMinute = (ms) => MADRID_TIME.format(ms);
/** «AAAA-MM-DD» de un instante en hora de Madrid. */
export const madridDay = (ms) => MADRID_DAY.format(ms);

const clip = (s, n) => cutText(String(s ?? '').replace(/\s+/g, ' ').trim(), n);

/**
 * @typedef {object} Fact
 * @property {string} id       Único para lo que cuenta (una cancelación: su id; un retraso: el vehículo y su escalón).
 * @property {string} kind     'cancelado' | 'parcial' | 'sin-datos' | 'aviso' | 'retraso' | 'meteo' | 'sismo' | 'emergencia' |
 *                             'apagon' | 'incendio'
 * @property {string} text     Lo que se cuenta, en una o dos frases.
 * @property {string|null} credit  Atribución de su fuente.
 */

/** Un nombre de parada para compararlo, como en la ficha de la estación de la web: sin tildes, mayúsculas ni espacios dobles. */
const plainStop = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const isTripEvent = (e) => e?.category === 'cancelacion' || e?.category === 'sin-datos';
const nearStation = (s, station) => !Number.isFinite(s.lat) || !Number.isFinite(station.lat)
  || distanceKm(station.lat, station.lon, s.lat, s.lon) <= STATION_KM;

/** ¿Pasa esta cancelación (o tren sin datos) por esta estación? Su parada allí, o null. */
export function stopAt(e, station) {
  if (!station?.name) return null;
  const name = plainStop(station.name);
  return (e.trip?.stops ?? []).find((s) => plainStop(s.name) === name && nearStation(s, station)) ?? null;
}

// Las paradas de los viajes cancelados y sin datos, por su nombre, una vez por lista de sucesos (la de una
// ronda): con cientos de estaciones seguidas, recorrer todos los viajes y normalizar cada parada para cada una
// costaba segundos en cada ronda. Se rehace si la lista cambia de tamaño (alguien la ha cambiado). Los nombres
// ya normalizados se guardan con cada suceso mientras viva (cada lista nueva trae los mismos objetos).
const TRIP_STOPS = new WeakMap();
const STOP_NAMES = new WeakMap();
const stopNamesOf = (e) => {
  let names = STOP_NAMES.get(e);
  if (!names) STOP_NAMES.set(e, (names = (e.trip?.stops ?? []).map((stop) => [plainStop(stop.name), stop])));
  return names;
};
function tripStopIndex(events) {
  const cached = TRIP_STOPS.get(events);
  if (cached?.size === events.length) return cached.index;
  const index = new Map(); // nombre → [{ e, stop }], en el orden de los sucesos y de sus paradas
  for (const e of events) {
    if (!isTripEvent(e)) continue;
    for (const [name, stop] of stopNamesOf(e)) {
      if (!name) continue;
      let list = index.get(name);
      if (!list) index.set(name, (list = []));
      list.push({ e, stop });
    }
  }
  TRIP_STOPS.set(events, { size: events.length, index });
  return index;
}

/**
 * Las cancelaciones y trenes sin datos que pasan por una estación, con su parada allí (la primera que encaja,
 * como stopAt), en el orden de los sucesos. Una búsqueda en el índice de la ronda, no un recorrido de todos.
 * @returns {Array<{ e: object, here: object }>}
 */
export function tripsAt(events, station) {
  if (!station?.name || !Array.isArray(events)) return [];
  const out = [];
  const seen = new Set();
  for (const { e, stop } of tripStopIndex(events).get(plainStop(station.name)) ?? []) {
    if (seen.has(e) || !nearStation(stop, station)) continue;
    seen.add(e);
    out.push({ e, here: stop });
  }
  return out;
}

function tripFact(e, credit, here = null) {
  const at = here?.time ? ` Por esta estación pasaba a las ${here.time}${here.skipped ? ' (es una de las suprimidas)' : ''}.` : '';
  if (e.category === 'sin-datos') {
    return { id: e.id, kind: 'sin-datos', text: `${e.title}. No se sabe si circula: su operador no publica nada de él.${at}`, credit };
  }
  const reason = e.trip?.reason ? ` Motivo: ${clip(e.trip.reason, 200)}` : e.trip?.notice?.text ? ` Aviso del operador: ${clip(e.trip.notice.text, 200)}` : '';
  return { id: e.id, kind: e.type === 'parcial' ? 'parcial' : 'cancelado', text: `${e.title}.${at}${reason}`, credit };
}

const credited = (e, creditOf) => e.credit ?? creditOf(e.source, e.trip?.operator) ?? null;

/** Cómo se llama el vehículo por esta clave («Avant 08058», «Autobús 27 · EMT Málaga, el de las 07:32»). */
export function vehicleName(v, key) {
  const parsed = parseFollowKey(key);
  if (parsed?.number !== undefined) return describeFollow(key, { operator: v.operator, service: v.service ?? undefined, number: v.label ?? undefined });
  const noun = modeNoun(v.mode);
  return describeFollow(key, { operator: v.operator, line: v.line ?? undefined, origin: v.origin ?? undefined, modeLabel: noun[0].toUpperCase() + noun.slice(1) });
}

/**
 * El retraso de un vehículo: un hecho por su escalón (cada DELAY_STEP desde `delayMin`) y, callados (`silent`), los
 * escalones de debajo. Los callados no se avisan, pero cuentan como vistos: si el retraso baja a uno de ellos no es
 * nuevo (se avisa cuando empeora, no cuando mejora; quien empieza a seguir un tren que ya va con 50 min no recibe
 * «va con 20 min» cuando recupera).
 */
function delayFacts(v, key, delayMin, creditOf) {
  const level = Math.floor((v.delay - delayMin) / DELAY_STEP);
  const route = v.origin && v.destination ? ` (de ${v.origin} a ${v.destination})` : v.destination ? ` (hacia ${v.destination})` : '';
  const next = v.next ? ` Próxima parada: ${v.next}.` : '';
  const fact = {
    id: `${v.id}|retraso|${level}`,
    kind: 'retraso',
    text: `${vehicleName(v, key)} va con ${v.delay} min de retraso${route}.${next}`,
    credit: creditOf(v.source, v.operator) ?? null,
  };
  return [fact, ...Array.from({ length: level }, (_, l) => ({ ...fact, id: `${v.id}|retraso|${l}`, silent: true }))];
}

function zoneFact(e, p, creditOf) {
  const credit = credited(e, creditOf);
  if (e.category === 'meteo') {
    const when = [e.start && `desde ${fmtWhen(e.start)}`, e.end && `hasta ${fmtWhen(e.end)}`].filter(Boolean).join(' ');
    return { id: e.id, kind: 'meteo', text: `${e.title}${when ? `, ${when}` : ''}. Emitido el ${fmtWhen(e.issued) ?? '?'}.`, credit };
  }
  if (e.category === 'sismo') {
    return {
      id: e.id,
      kind: 'sismo',
      text: `${e.title}, el ${quakeWhen(e.start, e.lat, e.lon)}. Por su magnitud puede sentirse hasta a unos ${Math.round(feltRadiusKm(e.magnitude))} km, y ${p.name} queda dentro.`,
      credit,
    };
  }
  return { id: e.id, kind: 'emergencia', text: `${e.power ? 'Corte de luz' : 'Aviso oficial'}: ${clip(e.title, 300)}.`, credit };
}

/**
 * Lo que pasa ahora con cada cosa seguida.
 * - Servicio: sus cancelaciones o paradas suprimidas, si su operador deja de publicarlo («sin datos») y su
 *   retraso desde `delayMin` (un hecho por escalón de DELAY_STEP: se vuelve a avisar si empeora; los escalones de
 *   debajo van callados, `silent`, para no avisar si mejora).
 * - Línea: sus cancelaciones y paradas suprimidas, y los avisos de su operador que la nombran (`follow` del aviso).
 * - Parada: las cancelaciones y trenes sin datos que pasaban por ella, y los avisos de Renfe de la estación
 *   (avisos-estacion.js).
 * - Provincia: avisos naranja y rojo de AEMET, terremotos que pueden sentirse y avisos oficiales (eventInProvince);
 *   los posibles apagones de sus islas, de las alertas (`alerts`), y los focos de calor por satélite (zona.js: se
 *   cuentan sólo a quien los pide, provinceFacts).
 * Las cancelaciones que su fuente ya no publica (retiradas) no cuentan: ya se avisó cuando salieron.
 * @param {{ keys: Iterable<string>, provinces?: Iterable<string>, vehicles?: object[], events?: object[], alerts?: object[], now: number,
 *           stationOf?: (code: string) => object|null, creditOf?: (source: string, operator?: string) => string|null,
 *           delayMin?: number }} ctx
 * @returns {Map<string, Fact[]>}  clave (o provinceSub) → sus hechos
 */
export function collectFacts({ keys, provinces = [], vehicles = [], events = [], alerts = [], now, stationOf = () => null, creditOf = () => null, delayMin = DELAY_MIN }) {
  const wanted = new Set(keys);
  const out = new Map();
  const add = (sub, fact) => {
    if (!fact) return;
    let list = out.get(sub);
    if (!list) out.set(sub, (list = []));
    if (!list.some((f) => f.id === fact.id)) list.push(fact);
  };
  const live = events.filter((e) => !e.withdrawn);
  if (wanted.size) {
    for (const e of live) {
      const tripKeys = e.trip?.follow;
      if (Array.isArray(tripKeys) && (e.category === 'cancelacion' || e.category === 'sin-datos')) {
        for (const key of tripKeys) {
          if (!wanted.has(key)) continue;
          // Un tren sin datos sólo para quien sigue ese tren: en una línea entera serían demasiados.
          if (e.category === 'sin-datos' && followKind(key) !== 'servicio') continue;
          add(key, tripFact(e, credited(e, creditOf)));
        }
      } else if (Array.isArray(e.follow) && e.type === 'aviso') {
        for (const key of e.follow) {
          if (wanted.has(key)) add(key, { id: e.id, kind: 'aviso', text: `${clip(e.title, 120)}: ${clip(e.description, 400)}`, credit: credited(e, creditOf) });
        }
      }
    }
    for (const v of vehicles) {
      if (!Array.isArray(v.follow) || !(v.delay >= delayMin)) continue;
      for (const key of v.follow) {
        if (wanted.has(key) && followKind(key) === 'servicio') for (const f of delayFacts(v, key, delayMin, creditOf)) add(key, f);
      }
    }
    for (const key of wanted) {
      if (followKind(key) !== 'parada') continue;
      const station = stationOf(stopCode(key));
      if (!station) continue;
      for (const { e, here } of tripsAt(events, station)) if (!e.withdrawn) add(key, tripFact(e, credited(e, creditOf), here));
      for (const e of noticesAtStation(station, live)) add(key, stationNoticeFact(e, credited(e, creditOf)));
    }
  }
  let fires = null; // los focos de calor de la ronda, una vez para todas las provincias
  for (const id of provinces) {
    const p = provinceById(id);
    if (!p) continue;
    for (const e of events) if (eventInProvince(e, p, { now })) add(provinceSub(id), zoneFact(e, p, creditOf));
    for (const f of gridFacts(alerts, id)) add(provinceSub(id), f);
    for (const f of fireFacts(fires ??= fireZones(events, now), id, (e) => credited(e, creditOf))) add(provinceSub(id), f);
  }
  return out;
}

/**
 * Desde cuándo se ve cada hecho de cada suscripción (`<sub>|<id del hecho>` → { first, last }): los que siguen
 * guardan su primera vez; los que no se ven desde hace `forgetMs`, fuera (los de un día, como los focos de calor de
 * una zona, no antes de que acabe su día: zona.js, isDayFact); como mucho `max`, los más recientes.
 * @param {Map<string, { first: number, last: number }>} seen
 * @param {Map<string, Fact[]>} factsBySub
 * @returns {Map<string, { first: number, last: number }>}  otro mapa (el de antes no cambia)
 */
export function trackFacts(seen, factsBySub, now, { forgetMs = FACT_FORGET_MS, max = SEEN_MAX } = {}) {
  const next = new Map();
  for (const [k, v] of seen) if (now - v.last <= (isDayFact(k) ? Math.max(forgetMs, DAY_FACT_FORGET_MS) : forgetMs)) next.set(k, v);
  for (const [sub, facts] of factsBySub) {
    for (const f of facts) {
      const k = `${sub}|${f.id}`;
      next.set(k, { first: next.get(k)?.first ?? now, last: now });
    }
  }
  if (next.size > max) {
    for (const [k] of [...next].sort((a, b) => a[1].last - b[1].last).slice(0, next.size - max)) next.delete(k);
  }
  return next;
}

/** Los hechos de una suscripción que han salido después de la última vez que se le avisó (`checkedAt`); los callados, nunca. */
export function newFacts(sub, facts, seen, checkedAt) {
  return (facts ?? []).filter((f) => !f.silent && (seen.get(`${sub}|${f.id}`)?.first ?? -Infinity) > checkedAt);
}

/**
 * El mensaje con los hechos nuevos de una cosa seguida: su nombre, lo que pasa (como mucho
 * MAX_FACTS_PER_MESSAGE, y cuántos más), las fuentes y el enlace a la web.
 * @param {string} title  qué se sigue («Avant 08058», «Provincia de Valencia»)
 * @param {Fact[]} facts
 * @param {{ webUrl: string }} opts
 */
export function factsMessage(title, facts, { webUrl }) {
  const shown = facts.slice(0, MAX_FACTS_PER_MESSAGE);
  const more = facts.length - shown.length;
  const credits = [...new Set(facts.map((f) => f.credit).filter(Boolean))];
  const body = shown.length === 1 ? shown[0].text : shown.map((f) => `- ${f.text}`).join('\n');
  const text = [
    `${title}:`,
    body + (more ? `\n…y ${more} más.` : ''),
    credits.length ? credits.join(' · ') : null,
    `Más en ${webUrl}`,
  ].filter(Boolean).join('\n\n');
  return fitMessage(text);
}

/** Un mensaje que no pase del tope de Telegram (con sus saltos de línea), sin partir un carácter. */
export const fitMessage = (text, max = MESSAGE_MAX) => cutText(text, max);

/**
 * Bloques enteros (lo de cada cosa seguida) repartidos en mensajes que no pasan de `max`, en vez de un mensaje
 * recortado a media frase. Un bloque que por sí solo no cabe se recorta. Como mucho `maxMessages`: de lo que no
 * quepa se dice cuántos son (`more`). `footer` (la web) va al final del último.
 * @param {string[]} blocks
 * @param {{ footer?: string|null, max?: number, maxMessages?: number, more?: (n: number) => string }} [opts]
 * @returns {string[]}
 */
export function packBlocks(blocks, { footer = null, max = MESSAGE_MAX, maxMessages = MAX_MESSAGES, more = (n) => `…y ${n} más que no caben aquí.` } = {}) {
  const SEP = '\n\n';
  const size = (list) => list.reduce((n, b, i) => n + b.length + (i ? SEP.length : 0), 0);
  const messages = [[]];
  for (const block of blocks.map((b) => fitMessage(b, max))) {
    const last = messages.at(-1);
    if (last.length && size(last) + SEP.length + block.length > max) messages.push([block]);
    else last.push(block);
  }
  const shown = messages.slice(0, maxMessages);
  let left = blocks.length - shown.reduce((n, m) => n + m.length, 0);
  const tail = () => [left ? more(left) : null, footer].filter(Boolean);
  const fits = (list) => size([...list, ...tail()]) <= max;
  if (!fits(shown.at(-1))) {
    if (shown.length < maxMessages) shown.push([]);
    else {
      const last = shown.at(-1);
      while (last.length && !fits(last)) {
        last.pop();
        left++;
      }
    }
  }
  shown.at(-1).push(...tail());
  return shown.map((m) => fitMessage(m.join(SEP), max)).filter(Boolean);
}

/**
 * Cómo está ahora lo que se sigue, en unas líneas (para /estado, al suscribirse y en el parte diario).
 * @param {string} sub  clave `follow` o provinceSub
 * @param {{ vehicles?: object[], events?: object[], alerts?: object[], now: number, stationOf?: (code: string) => object|null,
 *           creditOf?: (source: string, operator?: string) => string|null, fires?: boolean }} ctx
 *   fires: en una provincia, también los focos de calor (quien los ha pedido)
 * @returns {{ lines: string[], credits: string[] }}
 */
export function statusOf(sub, { vehicles = [], events = [], alerts = [], now, stationOf = () => null, creditOf = () => null, fires = false }) {
  const lines = [];
  const credits = new Set();
  const credit = (c) => c && credits.add(c);
  if (sub.startsWith('prov:')) {
    const p = provinceById(sub.slice(5));
    if (!p) return { lines: ['Esa provincia no la conozco.'], credits: [] };
    const all = collectFacts({ keys: [], provinces: [p.id], events, alerts, now, creditOf }).get(sub) ?? [];
    const facts = provinceFacts(all, { fires });
    if (!facts.length) lines.push(`Ahora no hay avisos naranja o rojo de AEMET, terremotos que puedan sentirse ni avisos oficiales en ${p.name}.`);
    for (const f of facts.slice(0, MAX_FACTS_PER_MESSAGE)) {
      lines.push(f.text);
      credit(f.credit);
    }
    if (facts.length > MAX_FACTS_PER_MESSAGE) lines.push(`…y ${facts.length - MAX_FACTS_PER_MESSAGE} más.`);
    if (fires && !facts.some((f) => f.kind === 'incendio')) lines.push('Focos de calor por satélite: ahora ninguno de los que aviso (confianza alta y potencia alta).');
    return { lines, credits: [...credits] };
  }
  const kind = followKind(sub);
  const tripEvents = events.filter((e) => (e.category === 'cancelacion' || e.category === 'sin-datos') && answersTo(e.trip?.follow, sub));
  if (kind === 'servicio') {
    const running = vehicles.filter((v) => answersTo(v.follow, sub)).slice(0, 3);
    for (const v of running) {
      const delay = v.delay === null || v.delay === undefined ? (v.late ? 'con retraso (no dice cuánto)' : 'sin dato de retraso')
        : v.delay >= 5 ? `con ${v.delay} min de retraso` : v.delay > 0 ? `con ${v.delay} min` : 'en hora';
      const route = v.origin && v.destination ? `, de ${v.origin} a ${v.destination}` : v.destination ? `, hacia ${v.destination}` : '';
      lines.push(`${vehicleName(v, sub)}: circula ${delay}${route}.${v.next ? ` Próxima parada: ${v.next}.` : ''}`);
      credit(creditOf(v.source, v.operator));
    }
    for (const e of tripEvents) {
      lines.push(e.category === 'sin-datos' ? `${e.title}: no se sabe si circula.`
        : `${e.title}${e.withdrawn ? ' (su operador ya no lo publica: puede que al final circule)' : ''}.`);
      credit(credited(e, creditOf));
    }
    if (!lines.length) lines.push('Ahora no se ve circulando: puede que no le toque a esta hora o que su operador no lo publique.');
  } else if (kind === 'linea') {
    const running = vehicles.filter((v) => answersTo(v.follow, sub));
    const withDelay = running.filter((v) => Number.isFinite(v.delay));
    const late = withDelay.filter((v) => v.delay >= 5).length;
    const mode = running[0]?.mode ?? tripEvents[0]?.trip?.mode;
    const delays = withDelay.length === 1 ? `; ${late ? 'lleva' : 'no lleva'} 5 min o más de retraso`
      : withDelay.length ? `; ${late} de los ${withDelay.length} que dicen su retraso llevan 5 min o más` : '';
    lines.push(running.length === 1 ? `Ahora circula 1 ${modeNoun(mode)}${delays}.`
      : running.length ? `Ahora circulan ${running.length} ${modeNoun(mode, true)}${delays}.`
        : 'Ahora no se ve ninguno circulando.');
    for (const v of running.slice(0, 1)) credit(creditOf(v.source, v.operator));
    const cancelled = tripEvents.filter((e) => e.category === 'cancelacion');
    if (cancelled.length) {
      lines.push(`Cancelados o con paradas suprimidas hoy: ${cancelled.length}.`);
      for (const e of cancelled.slice(0, 3)) {
        lines.push(`- ${e.title}${e.withdrawn ? ' (ya no lo publica)' : ''}`);
        credit(credited(e, creditOf));
      }
      if (cancelled.length > 3) lines.push(`…y ${cancelled.length - 3} más.`);
    }
    for (const e of events.filter((x) => x.type === 'aviso' && answersTo(x.follow, sub)).slice(0, 2)) {
      lines.push(`Aviso: ${clip(e.title, 100)}: ${clip(e.description, 250)}`);
      credit(credited(e, creditOf));
    }
  } else if (kind === 'parada') {
    const station = stationOf(stopCode(sub));
    if (!station) return { lines: ['Esa estación no la encuentro ahora en el catálogo del radar.'], credits: [] };
    // Como la ficha de la estación en la web: las vigentes por su hora allí; las que su operador ya no publica
    // (retiradas: puede que al final circulen), aparte y sin contarlas como canceladas.
    const passing = tripsAt(events, station);
    const live = passing.filter(({ e }) => !e.withdrawn).sort((a, b) => (a.here.time ?? '99').localeCompare(b.here.time ?? '99'));
    const gone = passing.length - live.length;
    const cancelled = live.filter(({ e }) => e.category === 'cancelacion').length;
    const missing = live.length - cancelled;
    if (!live.length) lines.push(`Hoy no hay cancelaciones en vigor ni servicios sin datos que pasen por ${station.name}.`);
    else if (!cancelled) lines.push(`Pasaban hoy por ${station.name} y su operador no publica nada de ellos (sin datos): ${missing}.`);
    else lines.push(`Pasaban hoy por ${station.name} y están cancelados o con paradas suprimidas: ${cancelled}${missing ? `; sin datos: ${missing}` : ''}.`);
    for (const { e, here } of live.slice(0, 5)) {
      lines.push(`- ${e.title}${here.time ? ` (aquí a las ${here.time})` : ''}`);
      credit(credited(e, creditOf));
    }
    if (live.length > 5) lines.push(`…y ${live.length - 5} más.`);
    if (gone) {
      lines.push(gone === 1 ? 'Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule.'
        : `Además, ${gone} que se habían cancelado y su operador ya no publica: puede que al final circulen.`);
    }
    // Los avisos de Renfe de la estación, como en su ficha de la web: su texto tal cual.
    const notices = noticesAtStation(station, events);
    if (notices.length) lines.push('Avisos de Renfe en la estación:');
    for (const e of notices.slice(0, 5)) {
      lines.push(`- ${noticeText(e)}`);
      credit(credited(e, creditOf));
    }
    if (notices.length > 5) lines.push(`…y ${notices.length - 5} más.`);
  }
  return { lines, credits: [...credits] };
}
