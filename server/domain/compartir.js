// Compartir: el enlace propio de una incidencia, una estación o un vehículo, y lo que dice su vista previa (el
// título, la descripción y la tarjeta que enseñan WhatsApp, Telegram o X al pegar el enlace). Puro: sin red, ni
// reloj, ni disco. Lo usan el servidor (la página de cada enlace y su tarjeta) y el navegador (el botón Compartir y
// abrir un enlace), así que sólo importa otros módulos que también usa el navegador.
//
// Enlaces: /incidencia/<id>, /estacion/<código> y /vehiculo/<id>, con el id tal cual va en el radar («dgt:18811074»).
// Lo que no es letra, cifra, «:», «-», «.», «_» o «~» va escapado (encodeURIComponent).
//
// Una tarjeta sólo dice lo que dice su fuente (los títulos, las horas y el retraso que publica) y lo que el radar ha
// comprobado él mismo, con su hora: si una incidencia ya no sale en el directo, «ya no está en el directo del radar»,
// nunca «ha terminado» ni «su fuente la ha retirado» (puede que la fuente esté caída, y los terremotos salen del
// directo a los dos días aunque sigan en el catálogo del IGN). Lo calculado por el radar (la posición estimada de un
// vehículo por su horario) va como aproximado.
import { serverTextEn } from './en-servidor.js';
import { modeInfo } from './modos.js';
import { shortHash } from './seguir.js';

export const SHARE_KINDS = Object.freeze(['incidencia', 'estacion', 'vehiculo']);
/** Ningún id del radar pasa de unos 130 caracteres (los de los avisos de AEMET): más no es nuestro. */
export const SHARE_ID_MAX = 256;
const PATH_RE = /^\/(incidencia|estacion|vehiculo)\/([^/]+)$/;
// Caracteres de control (y separadores de línea): un id con ellos no es nuestro y rompería el HTML o la tarjeta.
const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;

/** ¿Es un id que puede ir en un enlace? (que exista lo mira quien lo usa) */
export const isShareId = (id) => typeof id === 'string' && id.length > 0 && id.length <= SHARE_ID_MAX && !CONTROL_RE.test(id);

/** La ruta del enlace de algo («/incidencia/dgt:18811074»); null si no se puede compartir. */
export function sharePath(kind, id) {
  if (!SHARE_KINDS.includes(kind) || !isShareId(id)) return null;
  return `/${kind}/${encodeURIComponent(id).replaceAll('%3A', ':')}`;
}

/** Qué pide una ruta de enlace ({ kind, id }); null si no es de las de compartir o el id no vale. */
export function parseSharePath(pathname) {
  const m = PATH_RE.exec(String(pathname ?? ''));
  if (!m) return null;
  let id;
  try {
    id = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  return isShareId(id) ? { kind: m[1], id } : null;
}

// ---------- Textos ----------
// Lo que escribe el radar en la tarjeta, en los dos idiomas. Los títulos y descripciones de cada fuente van tal cual
// (los que escribe el servidor, traducidos con serverTextEn), como en la web.
const EN = {
  'Tráfico': 'Traffic', 'Aviso de transporte': 'Transport notice', 'Aviso ferroviario': 'Rail notice', 'Cancelación': 'Cancellation',
  'Tren sin datos': 'Train without data', 'Aviso meteorológico': 'Weather warning', 'Foco de calor por satélite': 'Satellite heat spot',
  'Terremoto': 'Earthquake', 'Catástrofe (GDACS)': 'Disaster (GDACS)', 'Aviso oficial': 'Official notice', 'Incidencia': 'Incident',
  'Corte de luz': 'Power cut',
  'gravedad baja': 'low severity', 'gravedad media': 'medium severity', 'gravedad alta': 'high severity', 'gravedad muy alta': 'very high severity',
  'nivel verde': 'green level', 'nivel amarillo': 'yellow level', 'nivel naranja': 'orange level', 'nivel rojo': 'red level',
  'Carretera cortada': 'Road closed',
  'Emitido: {when}': 'Issued: {when}', 'Inicio: {when}': 'Start: {when}', 'Fin previsto: {when}': 'Expected end: {when}',
  'Última revisión en su fuente: {when}': 'Last reviewed by its source: {when}', 'Visto por el radar: {when}': 'Seen by the radar: {when}',
  'Sigue en el directo del radar · comprobado: {when}': 'Still in the radar\'s live data · checked: {when}',
  'Ya no está en el directo del radar · comprobado: {when}': 'No longer in the radar\'s live data · checked: {when}',
  'Su fuente lo retiró: {when}': 'Withdrawn by its source: {when}',
  'Ubicación aproximada': 'Approximate location',
  'hora de Canarias': 'Canary Islands time',
  'Retraso: {n} min': 'Delay: {n} min', 'En hora': 'On time', 'Adelantado {n} min': '{n} min early', 'Con retraso': 'Delayed',
  'Sin datos de retraso': 'No delay data',
  'Posición estimada por su horario (aprox.)': 'Position estimated from its timetable (approx.)',
  'Próxima parada: {stop}': 'Next stop: {stop}', 'Parado en {stop}': 'Stopped at {stop}',
  'En circulación · comprobado: {when}': 'Running · checked: {when}',
  'Estación': 'Station', 'Estación de {network}': '{network} station', 'Parada': 'Stop',
  'Trenes en directo, avisos y accesibilidad': 'Live trains, notices and accessibility',
  'Vehículos en directo y avisos': 'Live vehicles and notices',
  'Tarjeta de Radar España: {title}': 'Radar España card: {title}',
  'tren': 'train', 'autobús': 'bus', 'metro': 'metro', 'tranvía': 'tram', 'vehículo': 'vehicle',
};
const say = (lang, text, vars = {}) => (lang === 'en' ? EN[text] ?? text : text).replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
/** El texto de una fuente: tal cual; en inglés, los que escribe el servidor del radar, traducidos. */
const sourceText = (lang, text, source) => (lang === 'en' && text ? serverTextEn(text, source) : text ?? '');

// Colores de la gravedad, los de la web (style.css): nunca solos, siempre con su texto en la tarjeta.
export const SEVERITY_COLORS = Object.freeze({ baja: '#898781', media: '#fab219', alta: '#ec835a', 'muy alta': '#d03b3b' });
const LEVEL_COLORS = { verde: '#0ca30c', amarillo: '#fab219', naranja: '#ec835a', rojo: '#d03b3b' };
const ACCENT = '#6ea8fe';

const CATEGORY_LABEL = {
  carretera: 'Tráfico', ferroviario: 'Aviso ferroviario', cancelacion: 'Cancelación', 'sin-datos': 'Tren sin datos',
  meteo: 'Aviso meteorológico', incendio: 'Foco de calor por satélite', sismo: 'Terremoto', catastrofe: 'Catástrofe (GDACS)',
  emergencia: 'Aviso oficial',
};

// Horas en la zona del sitio: la peninsular, o la de Canarias si está allí (lo dice al lado, como los terremotos).
const FORMATS = new Map();
const fmt = (zone) => {
  if (!FORMATS.has(zone)) {
    FORMATS.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return FORMATS.get(zone);
};
const inCanarias = (point) => Boolean(point) && point.lon < -13 && point.lat < 30;
/**
 * «16/11, 17:42» (con el año si no es el de `now`), en hora peninsular o, en Canarias, en la suya y diciéndolo.
 * @param {number} t epoch ms  @param {{ now: number, lang?: string, canarias?: boolean, dayOnly?: boolean }} o
 */
export function shareTime(t, { now, lang = 'es', canarias = false, dayOnly = false }) {
  if (!Number.isFinite(t)) return null;
  const zone = canarias ? 'Atlantic/Canary' : 'Europe/Madrid';
  const p = Object.fromEntries(fmt(zone).formatToParts(t).map((x) => [x.type, x.value]));
  const year = Object.fromEntries(fmt(zone).formatToParts(now).map((x) => [x.type, x.value])).year;
  const day = `${p.day}/${p.month}${p.year !== year ? `/${p.year}` : ''}`;
  const text = dayOnly ? day : `${day}, ${p.hour}:${p.minute}`;
  return canarias ? `${text} (${say(lang, 'hora de Canarias')})` : text;
}

const finite = (x) => (Number.isFinite(x) ? x : null);
const pointOf = (lon, lat) => (Number.isFinite(lon) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lon, lat } : null);
const clip = (text, max) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/**
 * Lo que se guarda de una incidencia que ya no sale en su fuente, para que su enlace siga diciendo qué era: sólo lo
 * que enseña su tarjeta (los textos, recortados; su viaje, como mucho 80 paradas con su posición).
 * @param {import('./model.js').IncidentEvent} e
 */
export function endedSnapshot(e) {
  const keep = ['id', 'source', 'category', 'type', 'severity', 'level', 'road', 'province', 'area', 'approx', 'credit'];
  const out = {};
  for (const k of keep) if (typeof e[k] === 'string') out[k] = e[k].slice(0, 300);
  out.title = clip(e.title, 300);
  if (e.description) out.description = clip(e.description, 500);
  for (const k of ['lat', 'lon', 'start', 'end', 'updated', 'issued', 'seen', 'withdrawn', 'magnitude']) if (Number.isFinite(e[k])) out[k] = e[k];
  for (const k of ['issuedDayOnly', 'closed', 'power']) if (e[k] === true) out[k] = true;
  const stops = Array.isArray(e.trip?.stops) ? e.trip.stops.filter((s) => Number.isFinite(s?.lon) && Number.isFinite(s?.lat)).slice(0, 80) : [];
  if (stops.length) out.trip = { stops: stops.map((s) => ({ lon: Math.round(s.lon * 1e4) / 1e4, lat: Math.round(s.lat * 1e4) / 1e4 })) };
  return out;
}

/**
 * Las incidencias que han dejado de salir desde la última vez: compara las de antes con las de ahora y apunta las que
 * faltan, con la hora a la que lo ha visto (`now`). Las que vuelven a salir dejan de estar entre las terminadas. Se
 * quedan `keepMs` y, como mucho, `max` (las más viejas salen antes).
 * @param {Map<string, { event: object, endedAt: number }>} ended  se modifica
 * @param {Iterable<import('./model.js').IncidentEvent>} before  @param {Iterable<import('./model.js').IncidentEvent>} now_
 * @param {{ now: number, keepMs: number, max: number }} o
 * @returns {number} cuántas se han apuntado
 */
export function noteEnded(ended, before, current, { now, keepMs, max }) {
  const live = new Set();
  for (const e of current) {
    live.add(e.id);
    ended.delete(e.id);
  }
  let added = 0;
  for (const e of before) {
    if (live.has(e.id) || ended.has(e.id) || !isShareId(e.id)) continue;
    ended.set(e.id, { event: endedSnapshot(e), endedAt: now });
    added++;
  }
  for (const [id, x] of ended) if (!(now - x.endedAt < keepMs)) ended.delete(id);
  // En orden de cuándo terminaron (se apuntan así): las primeras son las más viejas.
  while (ended.size > max) ended.delete(ended.keys().next().value);
  return added;
}

/**
 * Lo guardado de las terminadas, de vuelta (lo que no tenga la forma de lo que se guarda, fuera).
 * @returns {Map<string, { event: object, endedAt: number }>}
 */
export function restoreEnded(raw, { now, keepMs, max }) {
  const out = new Map();
  const list = Array.isArray(raw?.ended) ? raw.ended : [];
  for (const x of list.sort((a, b) => (a?.endedAt ?? 0) - (b?.endedAt ?? 0))) {
    const id = x?.event?.id;
    if (!isShareId(id) || !Number.isFinite(x.endedAt) || !(now - x.endedAt < keepMs) || x.endedAt > now + 60_000) continue;
    if (typeof x.event.title !== 'string' || !CATEGORY_LABEL[x.event.category]) continue;
    out.set(id, { event: endedSnapshot(x.event), endedAt: x.endedAt });
  }
  while (out.size > max) out.delete(out.keys().next().value);
  return out;
}

/** Lo que se guarda en el disco de las terminadas. */
export const endedRecord = (ended) => ({ version: 1, ended: [...ended.values()] });

/**
 * La vista previa de una incidencia, en curso o que ya no sale en su fuente.
 * @param {object} e  la incidencia (o lo guardado de ella)
 * @param {{ now: number, lang?: string, credit?: string|null, endedAt?: number|null }} o
 *   now: la hora a la que se comprueba (sale en la tarjeta); credit: la atribución de su fuente; endedAt: cuándo vio
 *   el radar que su fuente ya no la publicaba (null: sigue en ella).
 * @returns {ShareCard}
 */
export function eventShare(e, { now, lang = 'es', credit = null, endedAt = null }) {
  const point = pointOf(e.lon, e.lat);
  const canarias = inCanarias(point);
  const when = (t, dayOnly = false) => shareTime(t, { now, lang, canarias, dayOnly });
  const busNotice = e.category === 'carretera' && e.type === 'aviso';
  const category = busNotice ? 'Aviso de transporte' : e.power ? 'Corte de luz' : CATEGORY_LABEL[e.category] ?? 'Incidencia';
  const grade = e.level && LEVEL_COLORS[e.level] ? say(lang, `nivel ${e.level}`) : SEVERITY_COLORS[e.severity] ? say(lang, `gravedad ${e.severity}`) : null;
  const color = (e.level && LEVEL_COLORS[e.level]) || SEVERITY_COLORS[e.severity] || ACCENT;
  const details = [
    e.closed && e.category === 'carretera' && !String(e.description ?? '').includes('Carretera cortada') && say(lang, 'Carretera cortada'),
    e.issued && say(lang, 'Emitido: {when}', { when: when(e.issued, e.issuedDayOnly === true) }),
    e.start && say(lang, 'Inicio: {when}', { when: when(e.start) }),
    e.end && say(lang, 'Fin previsto: {when}', { when: when(e.end) }),
    e.updated && e.updated !== e.start && say(lang, 'Última revisión en su fuente: {when}', { when: when(e.updated) }),
    (e.category === 'cancelacion' || e.category === 'sin-datos') && e.seen && say(lang, 'Visto por el radar: {when}', { when: when(e.seen) }),
  ].filter(Boolean);
  const status = endedAt
    ? { active: false, text: say(lang, 'Ya no está en el directo del radar · comprobado: {when}', { when: when(endedAt) }) }
    : e.withdrawn
      ? { active: false, text: say(lang, 'Su fuente lo retiró: {when}', { when: when(e.withdrawn) }) }
      : { active: true, text: say(lang, 'Sigue en el directo del radar · comprobado: {when}', { when: when(now) }) };
  const route = Array.isArray(e.trip?.stops)
    ? e.trip.stops.map((s) => pointOf(s.lon, s.lat)).filter(Boolean).map((p) => [p.lon, p.lat]) : [];
  return finish({
    kind: 'incidencia',
    id: e.id,
    kicker: [say(lang, category), grade].filter(Boolean).join(' · '),
    title: clip(sourceText(lang, e.title, e.source), 200),
    description: clip(sourceText(lang, e.description, e.source), 320),
    details,
    color,
    point,
    route: route.length > 1 ? route : null,
    approx: Boolean(e.approx),
    status,
    credit: clip(e.credit ?? credit ?? '', 300),
    lang,
  });
}

/**
 * La vista previa de un vehículo que circula ahora.
 * @param {import('./model.js').Vehicle} v
 * @param {{ now: number, lang?: string, credit?: string|null }} o
 * @returns {ShareCard}
 */
export function vehicleShare(v, { now, lang = 'es', credit = null }) {
  const point = pointOf(v.lon, v.lat);
  const canarias = inCanarias(point);
  const noun = modeInfo(v.mode)?.noun ?? 'vehículo';
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  const title = `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim() || say(lang, noun);
  const delay = finite(v.delay);
  const delayText = delay === null ? (v.late === true ? say(lang, 'Con retraso') : v.late === false ? say(lang, 'En hora') : say(lang, 'Sin datos de retraso'))
    : delay > 0 ? say(lang, 'Retraso: {n} min', { n: Math.round(delay) }) : delay < 0 ? say(lang, 'Adelantado {n} min', { n: Math.round(-delay) }) : say(lang, 'En hora');
  const color = delay === null ? ACCENT : delay >= 30 ? SEVERITY_COLORS['muy alta'] : delay >= 15 ? SEVERITY_COLORS.alta : delay >= 5 ? SEVERITY_COLORS.media : '#0ca30c';
  const stop = v.stopped && v.current ? say(lang, 'Parado en {stop}', { stop: v.current }) : v.next ? say(lang, 'Próxima parada: {stop}', { stop: v.next }) : null;
  const seen = finite(v.fixTime) ?? now;
  return finish({
    kind: 'vehiculo',
    id: v.id,
    kicker: [cap(say(lang, noun)), v.operator].filter(Boolean).join(' · '),
    title: clip(title, 120),
    description: clip([v.origin, v.destination].filter(Boolean).join(' → '), 200),
    details: [delayText, stop, v.estimated && say(lang, 'Posición estimada por su horario (aprox.)')].filter(Boolean),
    color,
    point,
    route: null,
    approx: Boolean(v.estimated),
    status: { active: true, text: say(lang, 'En circulación · comprobado: {when}', { when: shareTime(Math.min(seen, now), { now, lang, canarias }) }) },
    credit: clip(credit ?? '', 300),
    lang,
  });
}

/**
 * La vista previa de una estación o una parada: lo fijo (su nombre, su red y dónde está). Lo de cada momento lo ve
 * quien abre el enlace.
 * @param {object} st  la estación (ficha de /api/stations/<código>)
 * @param {{ lang?: string }} [o]
 * @returns {ShareCard}
 */
export function stationShare(st, { lang = 'es' } = {}) {
  const renfe = !st.networkId;
  const kicker = renfe ? say(lang, 'Estación de {network}', { network: 'Renfe' }) : st.network ? say(lang, 'Estación de {network}', { network: st.network }) : say(lang, 'Estación');
  const place = [st.place, st.province && st.province !== st.place ? st.province : null].filter(Boolean).join(', ');
  return finish({
    kind: 'estacion',
    id: st.code,
    kicker,
    title: clip(st.name, 120),
    description: clip(place, 160),
    details: [say(lang, renfe || st.mode !== 'bus' ? 'Trenes en directo, avisos y accesibilidad' : 'Vehículos en directo y avisos')],
    color: ACCENT,
    point: pointOf(st.lon, st.lat),
    route: null,
    approx: false,
    status: null,
    credit: clip(st.source?.credit ?? (renfe ? 'Origen de los datos: Renfe Operadora' : ''), 300),
    lang,
  });
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * @typedef {object} ShareCard
 * @property {'incidencia'|'estacion'|'vehiculo'} kind
 * @property {string} id
 * @property {string} kicker       Qué es (y su gravedad), arriba y en mayúsculas.
 * @property {string} title
 * @property {string} description
 * @property {string[]} details    Horas de la fuente, retraso…
 * @property {string} color        El de su gravedad.
 * @property {{ lon: number, lat: number }|null} point
 * @property {number[][]|null} route  Las paradas de su viaje ([lon, lat]), en las cancelaciones.
 * @property {boolean} approx       Ubicación aproximada (el centro de lo que nombra un aviso, o una posición estimada).
 * @property {{ active: boolean, text: string }|null} status
 * @property {string} credit       La atribución que pide la licencia de su fuente.
 * @property {'es'|'en'} lang
 * @property {string} path         La ruta del enlace.
 * @property {string} version      Cambia cuando cambia lo que enseña: va en la dirección de la tarjeta.
 * @property {string} summary      Para la descripción de la página (og:description).
 * @property {string} alt          Texto alternativo de la tarjeta.
 */
function finish(card) {
  const out = { ...card, lang: card.lang === 'en' ? 'en' : 'es', path: sharePath(card.kind, card.id) };
  out.summary = clip([card.description, ...card.details, card.status?.text].filter(Boolean).join(' · '), 300);
  out.alt = clip(say(out.lang, 'Tarjeta de Radar España: {title}', { title: card.title }), 200);
  out.version = shortHash(JSON.stringify([out.kicker, out.title, out.description, out.details, out.color, out.point, out.route, out.approx, out.status, out.credit, out.lang]));
  return out;
}
