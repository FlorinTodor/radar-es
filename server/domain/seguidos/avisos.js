// Avisos para quien sigue algo (un servicio, una línea, una parada o una provincia): qué pasa ahora con cada
// cosa seguida («hechos»: una cancelación, un retraso que pasa del umbral, un tren sin datos, un aviso del
// operador, un aviso naranja de AEMET…), cuáles son nuevos para cada suscripción y el texto de cada mensaje.
// Vale para cualquier tipo de vehículo: todo sale de las claves `follow` (domain/seguir.js) y del registro de
// tipos. Los textos, en el idioma de quien los recibe (`tr`, de idioma.js; en español si no se dice): los nombres y
// lo que publica cada fuente, tal cual. Puro: sin red, ni reloj, ni disco (la hora llega en `now`).
import { answersTo, describeFollow, followKind, isRoadKey, parseFollowKey, stopCode } from '../seguir.js';
import { eventInProvince, feltRadiusKm, provinceById } from '../provincias.js';
import { provinceTrafficLines, roadStatus, trafficFacts } from './trafico.js';
import { distanceKm } from '../geo.js';
import { quakeWhen } from '../sismos.js';
import { modeNoun } from '../modos.js';
import { cutText } from './texto.js';
import { noticesAtStation } from '../avisos-estacion.js';
import { noticeText, stationNoticeFact } from './estacion.js';
import { DAY_FACT_FORGET_MS, fireFacts, fireZones, gridFacts, isDayFact, provinceFacts } from './zona.js';
import { ES } from './idioma.js';

/** Retraso (min) a partir del cual se avisa, y cada cuánto más se vuelve a avisar si empeora. */
export const DELAY_MIN = 15;
export const DELAY_STEP = 15;
/** Un hecho que deja de verse tanto tiempo se olvida: si vuelve, es nuevo (el mismo tren, otro día). */
export const FACT_FORGET_MS = 3 * 3600_000;
/**
 * Lo que se recuerda de lo avisado (pares «suscripción|hecho», unos 230 bytes cada uno): de lo que ya no se ve, como
 * mucho hasta llegar a SEEN_MAX. Lo que se ve en la ronda no se olvida nunca por el tope (unos avisos se perderían y
 * otros se repetirían cada minuto): si sólo eso ya pasa de SEEN_MAX, se deja crecer (y se avisa en el registro) hasta
 * SEEN_HARD_MAX, unos 115 MB, la válvula para que no se coma la memoria del servidor.
 */
export const SEEN_MAX = 100_000;
export const SEEN_HARD_MAX = 500_000;
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

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «10/11, 15:00» en hora de Madrid, en español. Lo que se escribe a un chat va en su idioma: tr.when (idioma.js). */
export const fmtWhen = (ms) => ES.when(ms);
/** «HH:MM» de un instante en hora de Madrid. */
export const madridHourMinute = (ms) => MADRID_TIME.format(ms);
/** «AAAA-MM-DD» de un instante en hora de Madrid. */
export const madridDay = (ms) => MADRID_DAY.format(ms);

const clip = (s, n) => cutText(String(s ?? '').replace(/\s+/g, ' ').trim(), n);
// Los textos de las fuentes (avisos, motivos) van enteros, como piden sus licencias: sólo se juntan sus saltos de línea.
const whole = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @typedef {object} Fact
 * @property {string} id       Único para lo que cuenta (una cancelación: su id; un retraso: el vehículo y su escalón).
 * @property {string} kind     'cancelado' | 'parcial' | 'sin-datos' | 'aviso' | 'retraso' | 'meteo' | 'sismo' | 'emergencia' |
 *                             'apagon' | 'incendio' | 'carretera'
 * @property {string} text     Lo que se cuenta, en una o dos frases.
 * @property {string|null} credit  Atribución de su fuente.
 */

/** Un nombre de parada para compararlo, como en la ficha de la estación de la web: sin tildes, mayúsculas ni espacios dobles. */
export const plainStop = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const isTripEvent = (e) => e?.category === 'cancelacion' || e?.category === 'sin-datos';
export const nearStation = (s, station) => !Number.isFinite(s.lat) || !Number.isFinite(station.lat)
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

// El título de una cancelación lo escribe nuestro servidor (domain/cancelaciones.js): en el idioma del chat, con
// las plantillas de la web. El motivo y el aviso del operador son suyos: tal cual.
function tripFact(e, credit, here = null, tr = ES) {
  const { t } = tr;
  const at = !here?.time ? ''
    : ` ${here.skipped ? t('Por esta estación pasaba a las {time} (es una de las suprimidas).', { time: here.time })
      : t('Por esta estación pasaba a las {time}.', { time: here.time })}`;
  const title = tr.server(e.title, e.source);
  if (e.category === 'sin-datos') {
    return { id: e.id, kind: 'sin-datos', text: `${title}. ${t('No se sabe si circula: su operador no publica nada de él.')}${at}`, credit };
  }
  const reason = e.trip?.reason ? ` ${t('Motivo: {reason}', { reason: whole(e.trip.reason) })}`
    : e.trip?.notice?.text ? ` ${t('Aviso del operador: {notice}', { notice: whole(e.trip.notice.text) })}` : '';
  return { id: e.id, kind: e.type === 'parcial' ? 'parcial' : 'cancelado', text: `${title}.${at}${reason}`, credit };
}

const credited = (e, creditOf) => e.credit ?? creditOf(e.source, e.trip?.operator) ?? null;

// Los sucesos en vigor (sin los retirados) de cada lista, una vez: /estado y el parte de muchos chats piden lo suyo
// con la misma lista de la ronda.
const LIVE = new WeakMap();
function liveOf(events) {
  const cached = LIVE.get(events);
  if (cached?.size === events.length) return cached.live;
  const live = events.filter((e) => !e.withdrawn);
  if (Array.isArray(events)) LIVE.set(events, { size: events.length, live });
  return live;
}

/** Cómo se llama el vehículo por esta clave («Avant 08058», «Autobús 27 · EMT Málaga, el de las 07:32»). */
export function vehicleName(v, key) {
  const parsed = parseFollowKey(key);
  if (parsed?.number !== undefined) return describeFollow(key, { operator: v.operator, service: v.service ?? undefined, number: v.label ?? undefined });
  const noun = modeNoun(v.mode);
  return describeFollow(key, { operator: v.operator, line: v.line ?? undefined, origin: v.origin ?? undefined, modeLabel: noun[0].toUpperCase() + noun.slice(1) });
}

/** «de Valladolid a Madrid» o «hacia Madrid»; '' si no se sabe. */
function routeOf(v, { t }) {
  if (v.origin && v.destination) return t('de {origin} a {destination}', { origin: v.origin, destination: v.destination });
  return v.destination ? t('hacia {destination}', { destination: v.destination }) : '';
}

/**
 * El retraso de un vehículo: un hecho por su escalón (cada DELAY_STEP desde `delayMin`) y, callados (`silent`), los
 * escalones de debajo. Los callados no se avisan, pero cuentan como vistos: si el retraso baja a uno de ellos no es
 * nuevo (se avisa cuando empeora, no cuando mejora; quien empieza a seguir un tren que ya va con 50 min no recibe
 * «va con 20 min» cuando recupera).
 */
function delayFacts(v, key, delayMin, creditOf, tr = ES) {
  const { t } = tr;
  const level = Math.floor((v.delay - delayMin) / DELAY_STEP);
  const route = routeOf(v, tr);
  const next = v.next ? ` ${t('Próxima parada: {stop}.', { stop: v.next })}` : '';
  const fact = {
    id: `${v.id}|retraso|${level}`,
    kind: 'retraso',
    text: `${t('{name} va con {n} min de retraso', { name: tr.name(vehicleName(v, key)), n: v.delay })}${route ? ` (${route})` : ''}.${next}`,
    credit: creditOf(v.source, v.operator) ?? null,
  };
  return [fact, ...Array.from({ length: level }, (_, l) => ({ ...fact, id: `${v.id}|retraso|${l}`, silent: true }))];
}

// El título de un aviso de AEMET o de un aviso oficial es de su fuente: tal cual (tr.server sólo traduce nuestras
// plantillas, como la de los terremotos).
function zoneFact(e, p, creditOf, tr = ES) {
  const { t } = tr;
  const credit = credited(e, creditOf);
  const title = tr.server(e.title, e.source);
  if (e.category === 'meteo') {
    const when = [e.start && t('desde {when}', { when: tr.when(e.start) }), e.end && t('hasta {when}', { when: tr.when(e.end) })].filter(Boolean).join(' ');
    return { id: e.id, kind: 'meteo', text: `${title}${when ? `, ${when}` : ''}. ${t('Emitido el {when}.', { when: tr.when(e.issued) ?? '?' })}`, credit };
  }
  if (e.category === 'sismo') {
    const when = quakeWhen(e.start, e.lat, e.lon).replace(/ \(hora de Canarias\)$/, () => ` (${t('hora de Canarias')})`);
    return {
      id: e.id,
      kind: 'sismo',
      text: t('{title}, el {when}. Por su magnitud puede sentirse hasta a unos {km} km, y {province} queda dentro.',
        { title, when, km: Math.round(feltRadiusKm(e.magnitude)), province: p.name }),
      credit,
    };
  }
  const notice = whole(title);
  return { id: e.id, kind: 'emergencia', text: e.power ? t('Corte de luz: {notice}.', { notice }) : t('Aviso oficial: {notice}.', { notice }), credit };
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
 * - Tráfico (trafico.js): en una carretera seguida, sus cortes, accidentes e incidencias graves; en una provincia,
 *   sus cortes y accidentes graves.
 * Las cancelaciones que su fuente ya no publica (retiradas) no cuentan: ya se avisó cuando salieron.
 * Los textos, en el idioma de `tr`: los mismos hechos (con el mismo id) en otro idioma sólo cambian su texto.
 * @param {{ keys: Iterable<string>, provinces?: Iterable<string>, vehicles?: object[], events?: object[], alerts?: object[], now: number,
 *           stationOf?: (code: string) => object|null, creditOf?: (source: string, operator?: string) => string|null,
 *           delayMin?: number, tr?: import('./idioma.js').Translator }} ctx
 * @returns {Map<string, Fact[]>}  clave (o provinceSub) → sus hechos
 */
export function collectFacts({
  keys, provinces = [], vehicles = [], events = [], alerts = [], now, stationOf = () => null, creditOf = () => null, delayMin = DELAY_MIN, tr = ES,
}) {
  const wanted = new Set(keys);
  const out = new Map();
  const add = (sub, fact) => {
    if (!fact) return;
    let list = out.get(sub);
    if (!list) out.set(sub, (list = []));
    if (!list.some((f) => f.id === fact.id)) list.push(fact);
  };
  const live = liveOf(events);
  if (wanted.size) {
    for (const e of live) {
      const tripKeys = e.trip?.follow;
      if (Array.isArray(tripKeys) && (e.category === 'cancelacion' || e.category === 'sin-datos')) {
        for (const key of tripKeys) {
          if (!wanted.has(key)) continue;
          // Un tren sin datos sólo para quien sigue ese tren: en una línea entera serían demasiados.
          if (e.category === 'sin-datos' && followKind(key) !== 'servicio') continue;
          add(key, tripFact(e, credited(e, creditOf), null, tr));
        }
      } else if (Array.isArray(e.follow) && e.type === 'aviso') {
        for (const key of e.follow) {
          // El título por defecto («Aviso Renfe · C4a») es nuestro; el aviso, del operador.
          if (wanted.has(key)) add(key, { id: e.id, kind: 'aviso', text: `${whole(tr.server(e.title, e.source))}: ${whole(e.description)}`, credit: credited(e, creditOf) });
        }
      }
    }
    for (const v of vehicles) {
      if (!Array.isArray(v.follow) || !(v.delay >= delayMin)) continue;
      for (const key of v.follow) {
        if (wanted.has(key) && followKind(key) === 'servicio') for (const f of delayFacts(v, key, delayMin, creditOf, tr)) add(key, f);
      }
    }
    for (const key of wanted) {
      if (followKind(key) !== 'parada') continue;
      const station = stationOf(stopCode(key));
      if (!station) continue;
      for (const { e, here } of tripsAt(events, station)) if (!e.withdrawn) add(key, tripFact(e, credited(e, creditOf), here, tr));
      // Los avisos de Renfe de la estación: su texto, tal cual, en todos los idiomas (el título por defecto, traducido).
      for (const e of noticesAtStation(station, live)) add(key, stationNoticeFact(e, credited(e, creditOf), tr));
    }
  }
  let fires = null; // los focos de calor de la ronda, una vez para todas las provincias
  const provinceIds = [...provinces];
  for (const id of provinceIds) {
    const p = provinceById(id);
    if (!p) continue;
    for (const e of events) if (eventInProvince(e, p, { now })) add(provinceSub(id), zoneFact(e, p, creditOf, tr));
    for (const f of gridFacts(alerts, id, tr)) add(provinceSub(id), f);
    for (const f of fireFacts(fires ??= fireZones(events, now), id, (e) => credited(e, creditOf), tr)) add(provinceSub(id), f);
  }
  // Las retiradas no cuentan (trafficFacts las deja fuera): con la lista de siempre, su índice es el de toda la ronda.
  const traffic = trafficFacts({ keys: wanted, provinces: provinceIds, events, now, creditOf, tr });
  for (const [key, facts] of traffic.roads) for (const f of facts) add(key, f);
  for (const [id, facts] of traffic.provinces) for (const f of facts) add(provinceSub(id), f);
  return out;
}

/**
 * Recorta lo recordado a `max` (en el sitio): fuera lo más viejo, pero nunca lo visto desde `keepFrom` (la ronda
 * actual), salvo que eso solo pase de `hardMax`. Al cargar lo guardado, `keepFrom` es la última ronda que se guardó.
 * @param {Map<string, { first: number, last: number }>} seen
 */
export function capSeen(seen, { max = SEEN_MAX, hardMax = SEEN_HARD_MAX, keepFrom = Infinity } = {}) {
  if (seen.size <= max) return seen;
  const old = [];
  for (const [k, v] of seen) if (v.last < keepFrom) old.push([k, v.last]);
  old.sort((a, b) => a[1] - b[1]);
  for (const [k] of old.slice(0, seen.size - max)) seen.delete(k);
  // La válvula: sólo si lo de la ronda pasa de hardMax (fuera, también entonces, lo más viejo primero).
  if (seen.size > hardMax) for (const k of [...seen.keys()].slice(0, seen.size - hardMax)) seen.delete(k);
  return seen;
}

/**
 * Desde cuándo se ve cada hecho de cada suscripción (`<sub>|<id del hecho>` → { first, last }): los que siguen
 * guardan su primera vez; los que no se ven desde hace `forgetMs`, fuera (los de un día, como los focos de calor de
 * una zona, no antes de que acabe su día: zona.js, isDayFact). Como mucho `max` (capSeen): lo visto en esta ronda
 * nunca sale por el tope.
 * @param {Map<string, { first: number, last: number }>} seen
 * @param {Map<string, Fact[]>} factsBySub
 * @param {{ forgetMs?: number, max?: number, hardMax?: number, firsts?: Map<string, number[]> }} [opts]
 *   firsts: si se da, apunta en él la primera vez de cada hecho de cada suscripción (en el orden de sus hechos), para
 *   newFactsOf: así no se vuelve a buscar cada par en lo recordado.
 * @returns {Map<string, { first: number, last: number }>}  otro mapa (el de antes no cambia)
 */
export function trackFacts(seen, factsBySub, now, { forgetMs = FACT_FORGET_MS, max = SEEN_MAX, hardMax = SEEN_HARD_MAX, firsts = null } = {}) {
  const next = new Map();
  for (const [k, v] of seen) if (now - v.last <= (isDayFact(k) ? Math.max(forgetMs, DAY_FACT_FORGET_MS) : forgetMs)) next.set(k, v);
  for (const [sub, facts] of factsBySub) {
    const list = firsts ? new Array(facts.length) : null;
    facts.forEach((f, i) => {
      const k = `${sub}|${f.id}`;
      const first = next.get(k)?.first ?? now;
      next.set(k, { first, last: now });
      if (list) list[i] = first;
    });
    if (list) firsts.set(sub, list);
  }
  return capSeen(next, { max, hardMax, keepFrom: now });
}

/**
 * Apunta como vistos, en el sitio, los hechos de lo que se acaba de empezar a seguir (lo que ya había no se avisa). Sin
 * copiar lo recordado: con cientos de miles de pares, cada /seguir lo copiaba entero. Lo viejo y el tope, en la ronda
 * (trackFacts).
 * @param {Map<string, { first: number, last: number }>} seen
 * @param {Map<string, Fact[]>} factsBySub
 */
export function markSeen(seen, factsBySub, now) {
  for (const [sub, facts] of factsBySub) {
    for (const f of facts) {
      const k = `${sub}|${f.id}`;
      const had = seen.get(k);
      if (had) had.last = Math.max(had.last, now);
      else seen.set(k, { first: now, last: now });
    }
  }
  return seen;
}

/** Los hechos de una suscripción que han salido después de la última vez que se le avisó (`checkedAt`); los callados, nunca. */
export function newFacts(sub, facts, seen, checkedAt) {
  return (facts ?? []).filter((f) => !f.silent && (seen.get(`${sub}|${f.id}`)?.first ?? -Infinity) > checkedAt);
}

/**
 * newFacts para muchos chats en una ronda: lo de cada suscripción se mira una vez (su primera vez de cada hecho) y
 * cada chat sólo compara números. Con 20.000 chats y 20 cosas cada uno, buscar cada par en lo recordado para cada
 * chat costaba casi un segundo por ronda; y si nada es más nuevo que lo último que se le avisó, ni eso.
 * @param {Map<string, Fact[]>} factsBySub  @param {Map<string, { first: number }>} seen
 * @param {Map<string, number[]>} [firsts]  los de trackFacts con esos hechos (si no, se buscan en `seen`)
 * @returns {(sub: string, checkedAt: number) => Fact[]}
 */
export function newFactsOf(factsBySub, seen, firsts = null) {
  const bySub = new Map(); // sub → { list: [{ f, first }], newest }
  return (sub, checkedAt) => {
    let entry = bySub.get(sub);
    if (!entry) {
      const known = firsts?.get(sub);
      const list = (factsBySub.get(sub) ?? []).map((f, i) => ({ f, first: known ? known[i] : seen.get(`${sub}|${f.id}`)?.first ?? -Infinity }))
        .filter((x) => !x.f.silent);
      entry = { list, newest: list.reduce((max, x) => Math.max(max, x.first), -Infinity) };
      bySub.set(sub, entry);
    }
    return entry.newest > checkedAt ? entry.list.filter((x) => x.first > checkedAt).map((x) => x.f) : [];
  };
}

/**
 * El mensaje con los hechos nuevos de una cosa seguida: su nombre, lo que pasa (como mucho
 * MAX_FACTS_PER_MESSAGE, y cuántos más), las fuentes y el enlace a la web.
 * @param {string} title  qué se sigue («Avant 08058», «Avisos en Valencia»), ya en el idioma del chat
 * @param {Fact[]} facts  con sus textos en ese idioma (collectFacts con su `tr`)
 * @param {{ webUrl: string, tr?: import('./idioma.js').Translator }} opts
 */
export function factsMessage(title, facts, { webUrl, tr = ES }) {
  const { t } = tr;
  const shown = facts.slice(0, MAX_FACTS_PER_MESSAGE);
  const more = facts.length - shown.length;
  const credits = [...new Set(facts.map((f) => f.credit).filter(Boolean))];
  const body = shown.length === 1 ? shown[0].text : shown.map((f) => `- ${f.text}`).join('\n');
  const text = [
    `${title}:`,
    body + (more ? `\n${t('…y {n} más.', { n: more })}` : ''),
    credits.length ? credits.join(' · ') : null,
    t('Más en {web}', { web: webUrl }),
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
export function packBlocks(blocks, { footer = null, max = MESSAGE_MAX, maxMessages = MAX_MESSAGES, more = (n) => ES.t('…y {n} más que no caben aquí.', { n }) } = {}) {
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
 * @param {string} sub  clave `follow`, de carretera (isRoadKey) o provinceSub
 * @param {{ vehicles?: object[], events?: object[], alerts?: object[], now: number, stationOf?: (code: string) => object|null,
 *           creditOf?: (source: string, operator?: string) => string|null, fires?: boolean,
 *           tr?: import('./idioma.js').Translator }} ctx
 *   fires: en una provincia, también los focos de calor (quien los ha pedido)
 * @returns {{ lines: string[], credits: string[] }}
 */
export function statusOf(sub, { vehicles = [], events = [], alerts = [], now, stationOf = () => null, creditOf = () => null, fires = false, tr = ES }) {
  const { t, tn } = tr;
  const lines = [];
  const credits = new Set();
  const credit = (c) => c && credits.add(c);
  const title = (e) => tr.server(e.title, e.source);
  if (sub.startsWith('prov:')) {
    const p = provinceById(sub.slice(5));
    if (!p) return { lines: [t('Esa provincia no la conozco.')], credits: [] };
    // Todo de una pasada; el tráfico, aparte y detrás (provinceTrafficLines), también lo que no tiene noticias hace horas.
    const all = collectFacts({ keys: [], provinces: [p.id], events, alerts, now, creditOf, tr }).get(sub) ?? [];
    const facts = provinceFacts(all, { fires }).filter((f) => f.kind !== 'carretera');
    if (!facts.length) lines.push(t('Ahora no hay avisos naranja o rojo de AEMET, terremotos que puedan sentirse ni avisos oficiales en {province}.', { province: p.name }));
    for (const f of facts.slice(0, MAX_FACTS_PER_MESSAGE)) {
      lines.push(f.text);
      credit(f.credit);
    }
    if (facts.length > MAX_FACTS_PER_MESSAGE) lines.push(t('…y {n} más.', { n: facts.length - MAX_FACTS_PER_MESSAGE }));
    if (fires && !facts.some((f) => f.kind === 'incendio')) lines.push(t('Focos de calor por satélite: ahora ninguno de los que aviso (confianza alta y potencia alta).'));
    const traffic = provinceTrafficLines(all.filter((f) => f.kind === 'carretera'), tr);
    lines.push(...traffic.lines);
    traffic.credits.forEach(credit);
    return { lines, credits: [...credits] };
  }
  if (isRoadKey(sub)) return roadStatus(sub, { events, now, creditOf, tr });
  const kind = followKind(sub);
  const tripEvents = events.filter((e) => (e.category === 'cancelacion' || e.category === 'sin-datos') && answersTo(e.trip?.follow, sub));
  if (kind === 'servicio') {
    const running = vehicles.filter((v) => answersTo(v.follow, sub)).slice(0, 3);
    for (const v of running) {
      const delay = v.delay === null || v.delay === undefined ? (v.late ? t('con retraso (no dice cuánto)') : t('sin dato de retraso'))
        : v.delay >= 5 ? t('con {n} min de retraso', { n: v.delay }) : v.delay > 0 ? t('con {n} min', { n: v.delay }) : t('en hora');
      const head = [t('{name}: circula {delay}', { name: tr.name(vehicleName(v, sub)), delay }), routeOf(v, tr)].filter(Boolean).join(', ');
      lines.push(`${head}.${v.next ? ` ${t('Próxima parada: {stop}.', { stop: v.next })}` : ''}`);
      credit(creditOf(v.source, v.operator));
    }
    for (const e of tripEvents) {
      lines.push(e.category === 'sin-datos' ? t('{title}: no se sabe si circula.', { title: title(e) })
        : e.withdrawn ? t('{title} (su operador ya no lo publica: puede que al final circule).', { title: title(e) }) : `${title(e)}.`);
      credit(credited(e, creditOf));
    }
    if (!lines.length) lines.push(t('Ahora no se ve circulando: puede que no le toque a esta hora o que su operador no lo publique.'));
  } else if (kind === 'linea') {
    const running = vehicles.filter((v) => answersTo(v.follow, sub));
    const withDelay = running.filter((v) => Number.isFinite(v.delay));
    const late = withDelay.filter((v) => v.delay >= 5).length;
    const mode = running[0]?.mode ?? tripEvents[0]?.trip?.mode;
    const delays = withDelay.length === 1 ? (late ? t('lleva 5 min o más de retraso') : t('no lleva 5 min o más de retraso'))
      : withDelay.length ? t('{late} de los {n} que dicen su retraso llevan 5 min o más', { late, n: withDelay.length }) : '';
    const count = running.length === 1 ? t('Ahora circula 1 {noun}', { noun: tr.noun(mode) })
      : running.length ? t('Ahora circulan {n} {nouns}', { n: running.length, nouns: tr.noun(mode, true) }) : null;
    lines.push(count ? `${[count, delays].filter(Boolean).join('; ')}.` : t('Ahora no se ve ninguno circulando.'));
    for (const v of running.slice(0, 1)) credit(creditOf(v.source, v.operator));
    const cancelled = tripEvents.filter((e) => e.category === 'cancelacion');
    if (cancelled.length) {
      lines.push(t('Cancelados o con paradas suprimidas hoy: {n}.', { n: cancelled.length }));
      for (const e of cancelled.slice(0, 3)) {
        lines.push(e.withdrawn ? t('- {title} (ya no lo publica)', { title: title(e) }) : `- ${title(e)}`);
        credit(credited(e, creditOf));
      }
      if (cancelled.length > 3) lines.push(t('…y {n} más.', { n: cancelled.length - 3 }));
    }
    for (const e of events.filter((x) => x.type === 'aviso' && answersTo(x.follow, sub)).slice(0, 2)) {
      lines.push(t('Aviso: {title}: {notice}', { title: whole(title(e)), notice: whole(e.description) }));
      credit(credited(e, creditOf));
    }
  } else if (kind === 'parada') {
    const station = stationOf(stopCode(sub));
    if (!station) return { lines: [t('Esa estación no la encuentro ahora en el catálogo del radar.')], credits: [] };
    // Como la ficha de la estación en la web: las vigentes por su hora allí; las que su operador ya no publica
    // (retiradas: puede que al final circulen), aparte y sin contarlas como canceladas.
    const passing = tripsAt(events, station);
    const live = passing.filter(({ e }) => !e.withdrawn).sort((a, b) => (a.here.time ?? '99').localeCompare(b.here.time ?? '99'));
    const gone = passing.length - live.length;
    const cancelled = live.filter(({ e }) => e.category === 'cancelacion').length;
    const missing = live.length - cancelled;
    const at = { station: station.name, cancelled, missing };
    if (!live.length) lines.push(t('Hoy no hay cancelaciones en vigor ni servicios sin datos que pasen por {station}.', at));
    else if (!cancelled) lines.push(t('Pasaban hoy por {station} y su operador no publica nada de ellos (sin datos): {missing}.', at));
    else if (!missing) lines.push(t('Pasaban hoy por {station} y están cancelados o con paradas suprimidas: {cancelled}.', at));
    else lines.push(t('Pasaban hoy por {station} y están cancelados o con paradas suprimidas: {cancelled}; sin datos: {missing}.', at));
    for (const { e, here } of live.slice(0, 5)) {
      lines.push(here.time ? t('- {title} (aquí a las {time})', { title: title(e), time: here.time }) : `- ${title(e)}`);
      credit(credited(e, creditOf));
    }
    if (live.length > 5) lines.push(t('…y {n} más.', { n: live.length - 5 }));
    if (gone) {
      lines.push(tn('Además, {n} que se había cancelado y su operador ya no publica: puede que al final circule.',
        'Además, {n} que se habían cancelado y su operador ya no publica: puede que al final circulen.', gone));
    }
    // Los avisos de Renfe de la estación, como en su ficha de la web: su texto tal cual.
    const notices = noticesAtStation(station, events);
    if (notices.length) lines.push(t('Avisos de Renfe en la estación:'));
    for (const e of notices.slice(0, 5)) {
      lines.push(`- ${noticeText(e, tr)}`);
      credit(credited(e, creditOf));
    }
    if (notices.length > 5) lines.push(t('…y {n} más.', { n: notices.length - 5 }));
  }
  return { lines, credits: [...credits] };
}
