// El tráfico en el bot «Sigue tu tren»: de qué incidencias de carretera (las de category 'carretera': DGT, Servei
// Català de Trànsit, Tráfico de Euskadi…) se avisa a quien sigue una carretera o una provincia, con qué texto y
// cómo está ahora. Pocas y claras: hay más de mil incidencias a la vez, casi todas obras, y el bot no puede ser
// un aluvión. Los textos de las fuentes van tal cual (sus licencias piden no alterarlos, ver /legal), sólo
// juntados y con lo que añade el radar detrás (si corta la carretera, la gravedad, desde cuándo); la atribución de
// cada fuente va en cada mensaje. Los textos, en el idioma de quien los recibe (`tr`, de idioma.js; en español si no
// se dice): lo que añade el radar, traducido; los títulos que escribe nuestro servidor («Accidente · A-7 km 12.0»),
// con las plantillas de la web (en-servidor.js); lo que publica cada fuente, tal cual. Puro: sin red, ni reloj, ni
// disco (la hora llega en `now`).
import { parseRoadKey, roadCode, roadKey, roadLabel } from '../seguir.js';
import { PROVINCIAS_ES, findProvince, provinceOfPoint } from '../provincias.js';
import { ES, frase } from './idioma.js';
import { SEVERITY_RANK } from '../model.js';

/** Gravedades que cuentan como graves (las de domain/model.js), según su fuente: alta o muy alta. */
const isSevere = (severity) => (SEVERITY_RANK[severity] ?? 0) >= SEVERITY_RANK.alta;
const WORKS = 'roadMaintenance';
const ACCIDENT = 'accident';
/**
 * Una incidencia sin noticias (ni empieza ni su fuente la revisa) desde hace más de esto no se avisa aunque se vea
 * por primera vez: es que su fuente ha estado caída un rato, no que sea nueva. Al volver, no llegan de golpe todos
 * los cortes de la provincia, algunos de hace meses.
 */
export const TRAFFIC_FRESH_MS = 6 * 3600_000;
/** Lo que se cuenta de una carretera o de una provincia en /estado y en el parte; del resto, cuántas son. */
const STATUS_MAX = 5;
/** De dónde salen los avisos de tráfico, para decirlo al seguir una carretera (en español: se traduce con t()). */
export const TRAFFIC_SOURCES_TEXT = frase('Datos de la DGT, del Servei Català de Trànsit y de Tráfico de Euskadi.');
/** Lo que se añade al seguir una provincia (en español: se traduce con t()). */
export const PROVINCE_TRAFFIC_TEXT = frase('También de los cortes de carretera y de los accidentes graves (no de las obras ni de las retenciones).');

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MADRID_DATE = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric', year: 'numeric' });
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «HH:MM» si es de hoy (en hora de Madrid), con `today`; si no, «21/11/2025», con `other`: dos frases de t(). */
const whenText = (ms, now, today, other, t) => (MADRID_DAY.format(ms) === MADRID_DAY.format(now)
  ? t(today, { time: MADRID_TIME.format(ms) }) : t(other, { date: MADRID_DATE.format(ms) }));

/** ¿Es una incidencia de tráfico? (y no un aviso de un operador de autobuses, que también va por carretera) */
export const isTrafficIncident = (e) => e?.category === 'carretera' && e.type !== 'aviso';

/**
 * ¿Se avisa de ella a quien sigue su carretera? Los cortes, los accidentes y lo de gravedad alta o muy alta según su
 * fuente; las obras, sólo si cortan la carretera.
 */
export function roadWorthy(e) {
  if (!isTrafficIncident(e)) return false;
  if (e.closed === true) return true;
  if (e.type === WORKS) return false;
  return e.type === ACCIDENT || isSevere(e.severity);
}

/**
 * ¿Se avisa de ella a quien sigue la provincia? Sólo los cortes de carretera y los accidentes graves (de gravedad
 * alta o muy alta según su fuente, o que cortan la carretera). Los cortes por obras, no: están previstos y algunos
 * vuelven cada noche con otro número; quien quiera saberlos sigue esa carretera.
 */
export function provinceWorthy(e) {
  if (!isTrafficIncident(e) || e.type === WORKS) return false;
  return e.closed === true || (e.type === ACCIDENT && isSevere(e.severity));
}

const BY_COMPACT = new Map(PROVINCIAS_ES.map((p) => [p.id.replaceAll('-', ''), p]));

/**
 * La provincia de una incidencia de tráfico: la que dice su fuente (la DGT: «València/Valencia», «Araba/Álava») o,
 * si no la dice, la de su punto (los círculos aproximados de domain/provincias.js).
 * @returns {string|null}  su id
 */
export function trafficProvinceId(e) {
  const named = typeof e?.province === 'string' ? e.province.split('/').map((n) => findProvince(n)).find(Boolean) : null;
  return (named ?? provinceOfPoint(e?.lat, e?.lon))?.id ?? null;
}

/**
 * Lo que dice una clave de carretera: su código y su provincia (null: entera). null si no es una clave de
 * carretera o su provincia no existe.
 * @returns {{ key: string, road: string, province: import('../provincias.js').Province|null }|null}
 */
export function roadSub(key) {
  const parsed = parseRoadKey(key);
  if (!parsed) return null;
  const province = parsed.province ? BY_COMPACT.get(parsed.province) ?? null : null;
  if (parsed.province && !province) return null;
  return { key, road: parsed.road, province };
}

/** Cómo se escribe una carretera: como la publica ahora su fuente («TE-V-1121», «N-340a») o, si no, por su código («A-7»). */
export function roadName(code, events = []) {
  for (const e of events) if (isTrafficIncident(e) && typeof e.road === 'string' && roadCode(e.road) === code) return e.road;
  return roadLabel(code);
}

/**
 * El nombre de lo que se sigue: «Carretera A-7» o «Carretera A-7 (Málaga)». Se guarda en español, como los demás
 * nombres, y se enseña en el idioma del chat (idioma.js nameText: «A-7 road (Málaga)»).
 */
export const roadTitle = (name, province = null) => `${ES.t('Carretera {road}', { road: name })}${province ? ` (${province.name})` : ''}`;

// Lo que se escribe alrededor de la carretera, en español y en inglés («la A-7 en Málaga», «the A-7 in Málaga»).
const FILLER_RE = /^(?:la|el|carretera|ctra\.?|autov[ií]a|autopista|nacional|the|road|motorway)$/i;
const JOINER_RE = /^(?:en|de|por|provincia|in|of|province)$/i;

/**
 * Qué carretera pide «/carretera …»: «A-7», «a7», «A 7», «la AP-7 en Tarragona», «N-340 provincia de Cádiz».
 * La provincia va al final; la carretera, en una palabra o en dos si son sus letras y su número («A 7»).
 * @param {string} text
 * @returns {{ key: string, road: string, province: object|null }|{ error: 'vacia'|'sin-carretera'|'carretera', province?: object }}
 *   sin-carretera: sólo ha dicho una provincia
 */
export function parseRoadRequest(text) {
  // Sin comillas alrededor («A 7», "A-7"): son de quien escribe, no de la carretera.
  const words = String(text ?? '').slice(0, 100).replace(/[«»"“”‘’']/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && FILLER_RE.test(words[0])) words.shift();
  if (!words.length) return { error: 'vacia' };
  const alone = findProvince(words.join(' '));
  if (alone) return { error: 'sin-carretera', province: alone };
  let province = null;
  for (let n = Math.min(5, words.length - 1); n >= 1 && !province; n--) {
    province = findProvince(words.slice(-n).join(' '));
    if (province) words.splice(-n);
  }
  while (province && words.length > 1 && JOINER_RE.test(words.at(-1))) words.pop();
  // «A 7», «AP 7», «N II»: las letras y el número separados. Más palabras no son una carretera («A7 Mlaga»).
  const joined = words.length === 1 ? words[0]
    : words.length === 2 && /^[A-Za-z]{1,4}$/.test(words[0]) && /^(?:\d|(?:I{1,3}|IV|VI?)A?$)/i.test(words[1]) ? words.join('') : null;
  const key = joined && roadKey(joined, province?.id ?? null);
  return key ? roadSub(key) : { error: 'carretera' };
}

/** ¿Tiene ahora alguna incidencia, aunque sea leve? Una que no tiene ninguna puede estar mal escrita (no hay lista de carreteras). */
export function roadSeen(key, events = []) {
  const sub = roadSub(key);
  return Boolean(sub) && events.some((e) => isTrafficIncident(e) && typeof e.road === 'string' && roadCode(e.road) === sub.road);
}

/**
 * ¿«/estado …» pide una carretera antes que una línea? Sí, si se escribe con guion y una letra que no usan las
 * líneas («A-7», «AP-7», «N-340»): si no, «A-7» encontraba el autobús 7. «C-4», «R-3», «L-5», «S-2», «T-1», «E-1» o
 * «M-30» pueden ser una línea o una carretera: primero las líneas, como siempre.
 */
export function asksForRoad(text) {
  const sub = parseRoadRequest(text);
  if (!sub.key || !/\b[a-z]{1,4}-[0-9ivx]/i.test(String(text))) return null;
  return /^(?:c|r|l|s|t|e|m|ml|tg|tr|fe)$/i.test(/^[a-z]+/i.exec(sub.road)?.[0] ?? '') ? null : sub;
}

/** Lo que se contesta a un «/carretera …» que no se entiende, en el idioma del chat. */
export function roadRequestHelp(result, arg = '', { t } = ES) {
  if (result.error === 'sin-carretera') {
    return t('Dime también la carretera, por ejemplo: /carretera A-7 {province}. Para los avisos de toda la provincia: /provincia {province}.',
      { province: result.province.name });
  }
  const intro = result.error === 'vacia' ? t('Dime la carretera') : t('No entiendo qué carretera es «{road}». Escríbela como en las señales', { road: arg });
  return `${intro}: ${t('/carretera A-7, /carretera N-340. Si sólo te interesa una provincia, añádela: /carretera AP-7 Tarragona.')}\n\n`
    + t('Te aviso de sus cortes, sus accidentes y sus incidencias de gravedad alta o muy alta; de las obras, sólo si la cortan.');
}

/** La respuesta al empezar a seguir una carretera (sin cómo está ahora, que va detrás), en el idioma del chat. */
export function roadFollowedText(sub, name, { t } = ES) {
  const done = sub.province
    ? t('Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de la {road} en {province}; de las obras, '
      + 'sólo si cortan la carretera.', { road: name, province: sub.province.name })
    : t('Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de la {road}; de las obras, '
      + 'sólo si cortan la carretera.', { road: name });
  const tip = sub.province ? '' : ` ${t('Si sólo te interesa una provincia, escribe /carretera {road} y su nombre.', { road: name })}`;
  return `${done} ${t(TRAFFIC_SOURCES_TEXT)}${tip}`;
}

/** Un texto con su punto final, si no lo lleva ya. */
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);
/** Lo que dice el radar de la gravedad que da la fuente, por su rango (domain/model.js): alta o muy alta. */
const SEVERITY_TEXT = { [SEVERITY_RANK.alta]: frase('Gravedad: alta.'), [SEVERITY_RANK.alta + 1]: frase('Gravedad: muy alta.') };

/**
 * El hecho de una incidencia de tráfico: su título y su descripción tal cual los da su fuente y, detrás, lo que
 * añade el radar. Su id sale de lo que cuenta, no del de su fuente: la DGT publica a veces la misma incidencia dos
 * veces (un número por sentido), y así se avisa una. Si pasa a cortar la carretera, es otro hecho (se avisa otra
 * vez); si deja de cortarla, no. La que no tiene noticias desde hace TRAFFIC_FRESH_MS va callada (`silent`): cuenta
 * como vista y no se avisa. En otro idioma (`tr`), el mismo id (del texto en español) y su texto traducido: lo que
 * añade el radar y las etiquetas de nuestro servidor (tr.server, como la web); lo de la fuente, tal cual.
 */
export function trafficFact(e, credit, now, tr = ES) {
  const { t } = tr;
  const said = [e.title, e.description].filter(Boolean).join(' · ');
  const shown = tr === ES ? said : [e.title, e.description].filter(Boolean).map((x) => tr.server(x, e.source)).join(' · ');
  const parts = [sentence(shown)];
  if (e.closed === true && !/carretera cortada/i.test(said)) parts.push(t('Carretera cortada.'));
  if (isSevere(e.severity)) parts.push(t(SEVERITY_TEXT[SEVERITY_RANK[e.severity]]));
  if (Number.isFinite(e.start)) parts.push(whenText(e.start, now, frase('Desde las {time}.'), frase('Desde el {date}.'), t));
  if (Number.isFinite(e.end)) parts.push(whenText(e.end, now, frase('Prevista hasta las {time}.'), frase('Prevista hasta el {date}.'), t));
  const news = Math.max(...[e.start, e.updated].filter(Number.isFinite));
  const fresh = news === -Infinity || now - news <= TRAFFIC_FRESH_MS;
  return {
    id: `carretera|${e.source ?? ''}|${said}|${e.closed === true ? 'corte' : ''}`,
    kind: 'carretera',
    text: parts.join(' '),
    credit,
    ...(fresh ? {} : { silent: true }),
  };
}

const latest = (a, b) => (Number.isFinite(b.start) ? b.start : -Infinity) - (Number.isFinite(a.start) ? a.start : -Infinity);
const push = (map, k, v) => {
  let list = map.get(k);
  if (!list) map.set(k, (list = []));
  if (!list.some((x) => x.id === v.id)) list.push(v);
};

/**
 * Lo que pasa ahora en cada carretera seguida (roadWorthy) y en cada provincia seguida (provinceWorthy), lo más
 * reciente primero.
 * @param {{ keys?: Iterable<string>, provinces?: Iterable<string>, events?: object[], now: number,
 *           creditOf?: (source: string) => string|null }} ctx  keys: las claves seguidas (las que no son de
 *   carretera no cuentan); provinces: ids de provincia
 * @returns {{ roads: Map<string, object[]>, provinces: Map<string, object[]> }}  clave → sus hechos; id de provincia → los suyos
 */
export function trafficFacts({ keys = [], provinces = [], events = [], now, creditOf = () => null, tr = ES }) {
  const out = { roads: new Map(), provinces: new Map() };
  const subs = [...keys].map(roadSub).filter(Boolean);
  const wanted = new Set(provinces);
  if (!subs.length && !wanted.size) return out;
  const facts = new Map(); // incidencia → su hecho, una vez aunque vaya a varias cosas seguidas
  const factOf = (e) => {
    if (!facts.has(e)) facts.set(e, trafficFact(e, e.credit ?? creditOf(e.source) ?? null, now, tr));
    return facts.get(e);
  };
  const provinceIds = new Map();
  const provinceOf = (e) => {
    if (!provinceIds.has(e)) provinceIds.set(e, trafficProvinceId(e));
    return provinceIds.get(e);
  };
  if (subs.length) {
    const byCode = new Map();
    for (const e of events.filter(roadWorthy).sort(latest)) {
      const code = typeof e.road === 'string' ? roadCode(e.road) : null;
      if (code) push(byCode, code, e);
    }
    for (const sub of subs) {
      for (const e of byCode.get(sub.road) ?? []) if (!sub.province || provinceOf(e) === sub.province.id) push(out.roads, sub.key, factOf(e));
    }
  }
  if (wanted.size) {
    for (const e of events.filter(provinceWorthy).sort(latest)) {
      const id = provinceOf(e);
      if (wanted.has(id)) push(out.provinces, id, factOf(e));
    }
  }
  return out;
}

/** Unas líneas con los hechos (como mucho STATUS_MAX y cuántos más) y sus atribuciones. */
function listed(facts, lines, credits, { t }) {
  for (const f of facts.slice(0, STATUS_MAX)) {
    lines.push(`- ${f.text}`);
    if (f.credit) credits.add(f.credit);
  }
  if (facts.length > STATUS_MAX) lines.push(t('…y {n} más.', { n: facts.length - STATUS_MAX }));
}

/**
 * Cómo está ahora una carretera seguida (para /estado, al seguirla y en el parte): sus cortes, accidentes e
 * incidencias graves y cuántas más leves hay.
 * @returns {{ lines: string[], credits: string[] }}
 */
export function roadStatus(key, { events = [], now, creditOf = () => null, tr = ES }) {
  const { t, tn } = tr;
  const sub = roadSub(key);
  if (!sub) return { lines: [t('Esa carretera no la conozco.')], credits: [] };
  // «la A-7» o «la A-7 (Málaga)»: la carretera y la provincia, tal cual.
  const name = `${roadName(sub.road, events)}${sub.province ? ` (${sub.province.name})` : ''}`;
  const facts = trafficFacts({ keys: [key], events, now, creditOf, tr }).roads.get(key) ?? [];
  const lines = [];
  const credits = new Set();
  if (!facts.length) lines.push(t('Ahora no hay cortes, accidentes ni incidencias graves en la {road}.', { road: name }));
  else {
    lines.push(tn('Ahora hay 1 corte, accidente o incidencia grave en la {road}:', 'Ahora hay {n} cortes, accidentes o incidencias graves en la {road}:',
      facts.length, { road: name }));
    listed(facts, lines, credits, tr);
  }
  const minor = events.filter((e) => isTrafficIncident(e) && !roadWorthy(e) && typeof e.road === 'string' && roadCode(e.road) === sub.road
    && (!sub.province || trafficProvinceId(e) === sub.province.id)).length;
  if (minor) {
    lines.push(tn('Además, 1 incidencia más leve (obras sin corte, retenciones…), en el mapa.',
      'Además, {n} incidencias más leves (obras sin corte, retenciones…), en el mapa.', minor));
  }
  return { lines, credits: [...credits] };
}

/**
 * Las líneas de tráfico de una provincia seguida (van con las de AEMET, terremotos y avisos oficiales).
 * @param {import('../provincias.js').Province} p
 * @returns {{ lines: string[], credits: string[] }}
 */
export function provinceTrafficStatus(p, { events = [], now, creditOf = () => null, tr = ES }) {
  const { t, tn } = tr;
  const facts = trafficFacts({ provinces: [p.id], events, now, creditOf, tr }).provinces.get(p.id) ?? [];
  if (!facts.length) return { lines: [t('Carreteras: ahora no hay cortes ni accidentes graves.')], credits: [] };
  const lines = [tn('Carreteras: 1 corte o accidente grave.', 'Carreteras: {n} cortes o accidentes graves.', facts.length)];
  const credits = new Set();
  listed(facts, lines, credits, tr);
  return { lines, credits: [...credits] };
}
