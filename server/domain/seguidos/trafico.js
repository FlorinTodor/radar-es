// El tráfico en el bot «Sigue tu tren»: de qué incidencias de carretera (las de category 'carretera': DGT, Servei
// Català de Trànsit, Tráfico de Euskadi…) se avisa a quien sigue una carretera o una provincia, con qué texto y
// cómo está ahora. Pocas y claras: hay más de mil incidencias a la vez, casi todas obras, y el bot no puede ser
// un aluvión. Los textos de las fuentes van tal cual (sus licencias piden no alterarlos, ver /legal), sólo
// juntados y con lo que añade el radar detrás (si corta la carretera, la gravedad, desde cuándo); la atribución de
// cada fuente va en cada mensaje. Puro: sin red, ni reloj, ni disco (la hora llega en `now`).
import { parseRoadKey, roadCode, roadKey, roadLabel } from '../seguir.js';
import { PROVINCIAS_ES, findProvince, provinceOfPoint } from '../provincias.js';

/** Gravedades que cuentan como graves (las de domain/model.js), según su fuente. */
const SEVERE = new Set(['alta', 'muy alta']);
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
/** De dónde salen los avisos de tráfico, para decirlo al seguir una carretera. */
export const TRAFFIC_SOURCES_TEXT = 'Datos de la DGT, del Servei Català de Trànsit y de Tráfico de Euskadi.';
/** Lo que se añade al seguir una provincia. */
export const PROVINCE_TRAFFIC_TEXT = 'También de los cortes de carretera y de los accidentes graves (no de las obras ni de las retenciones).';

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const MADRID_DATE = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric', year: 'numeric' });
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
/** «las 21:52» si es de hoy (en hora de Madrid); si no, «el 21/11/2025». */
const whenText = (ms, now) => (MADRID_DAY.format(ms) === MADRID_DAY.format(now) ? `las ${MADRID_TIME.format(ms)}` : `el ${MADRID_DATE.format(ms)}`);

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
  return e.type === ACCIDENT || SEVERE.has(e.severity);
}

/**
 * ¿Se avisa de ella a quien sigue la provincia? Sólo los cortes de carretera y los accidentes graves (de gravedad
 * alta o muy alta según su fuente, o que cortan la carretera). Los cortes por obras, no: están previstos y algunos
 * vuelven cada noche con otro número; quien quiera saberlos sigue esa carretera.
 */
export function provinceWorthy(e) {
  if (!isTrafficIncident(e) || e.type === WORKS) return false;
  return e.closed === true || (e.type === ACCIDENT && SEVERE.has(e.severity));
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

/** El nombre de lo que se sigue: «Carretera A-7» o «Carretera A-7 (Málaga)». */
export const roadTitle = (name, province = null) => `Carretera ${name}${province ? ` (${province.name})` : ''}`;

const FILLER_RE = /^(?:la|el|carretera|ctra\.?|autov[ií]a|autopista|nacional)$/i;
const JOINER_RE = /^(?:en|de|por|provincia)$/i;

/**
 * Qué carretera pide «/carretera …»: «A-7», «a7», «A 7», «la AP-7 en Tarragona», «N-340 provincia de Cádiz».
 * La provincia va al final; la carretera, en una palabra o en dos si son sus letras y su número («A 7»).
 * @param {string} text
 * @returns {{ key: string, road: string, province: object|null }|{ error: 'vacia'|'sin-carretera'|'carretera', province?: object }}
 *   sin-carretera: sólo ha dicho una provincia
 */
export function parseRoadRequest(text) {
  const words = String(text ?? '').slice(0, 100).trim().split(/\s+/).filter(Boolean);
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

/** Lo que se contesta a un «/carretera …» que no se entiende. */
export function roadRequestHelp(result, arg = '') {
  if (result.error === 'sin-carretera') {
    return `Dime también la carretera, por ejemplo: /carretera A-7 ${result.province.name}. Para los avisos de toda la provincia: /provincia ${result.province.name}.`;
  }
  const intro = result.error === 'vacia' ? 'Dime la carretera' : `No entiendo qué carretera es «${arg}». Escríbela como en las señales`;
  return `${intro}: /carretera A-7, /carretera N-340. Si sólo te interesa una provincia, añádela: /carretera AP-7 Tarragona.\n\n`
    + 'Te aviso de sus cortes, sus accidentes y sus incidencias de gravedad alta o muy alta; de las obras, sólo si la cortan.';
}

/** La respuesta al empezar a seguir una carretera (sin cómo está ahora, que va detrás). */
export function roadFollowedText(sub, name) {
  const where = `la ${name}${sub.province ? ` en ${sub.province.name}` : ''}`;
  const tip = sub.province ? '' : ` Si sólo te interesa una provincia, escribe /carretera ${name} y su nombre.`;
  return `Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de ${where}; de las obras, `
    + `sólo si cortan la carretera. ${TRAFFIC_SOURCES_TEXT}${tip}`;
}

/** Un texto con su punto final, si no lo lleva ya. */
const sentence = (s) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/**
 * El hecho de una incidencia de tráfico: su título y su descripción tal cual los da su fuente y, detrás, lo que
 * añade el radar. Su id sale de lo que cuenta, no del de su fuente: la DGT publica a veces la misma incidencia dos
 * veces (un número por sentido), y así se avisa una. Si pasa a cortar la carretera, es otro hecho (se avisa otra
 * vez); si deja de cortarla, no. La que no tiene noticias desde hace TRAFFIC_FRESH_MS va callada (`silent`): cuenta
 * como vista y no se avisa.
 */
export function trafficFact(e, credit, now) {
  const said = [e.title, e.description].filter(Boolean).join(' · ');
  const parts = [sentence(said)];
  if (e.closed === true && !/carretera cortada/i.test(said)) parts.push('Carretera cortada.');
  if (SEVERE.has(e.severity)) parts.push(`Gravedad: ${e.severity}.`);
  if (Number.isFinite(e.start)) parts.push(`Desde ${whenText(e.start, now)}.`);
  if (Number.isFinite(e.end)) parts.push(`Prevista hasta ${whenText(e.end, now)}.`);
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
export function trafficFacts({ keys = [], provinces = [], events = [], now, creditOf = () => null }) {
  const out = { roads: new Map(), provinces: new Map() };
  const subs = [...keys].map(roadSub).filter(Boolean);
  const wanted = new Set(provinces);
  if (!subs.length && !wanted.size) return out;
  const facts = new Map(); // incidencia → su hecho, una vez aunque vaya a varias cosas seguidas
  const factOf = (e) => {
    if (!facts.has(e)) facts.set(e, trafficFact(e, e.credit ?? creditOf(e.source) ?? null, now));
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
function listed(facts, lines, credits) {
  for (const f of facts.slice(0, STATUS_MAX)) {
    lines.push(`- ${f.text}`);
    if (f.credit) credits.add(f.credit);
  }
  if (facts.length > STATUS_MAX) lines.push(`…y ${facts.length - STATUS_MAX} más.`);
}

/**
 * Cómo está ahora una carretera seguida (para /estado, al seguirla y en el parte): sus cortes, accidentes e
 * incidencias graves y cuántas más leves hay.
 * @returns {{ lines: string[], credits: string[] }}
 */
export function roadStatus(key, { events = [], now, creditOf = () => null }) {
  const sub = roadSub(key);
  if (!sub) return { lines: ['Esa carretera no la conozco.'], credits: [] };
  const name = `la ${roadName(sub.road, events)}${sub.province ? ` (${sub.province.name})` : ''}`;
  const facts = trafficFacts({ keys: [key], events, now, creditOf }).roads.get(key) ?? [];
  const lines = [];
  const credits = new Set();
  if (!facts.length) lines.push(`Ahora no hay cortes, accidentes ni incidencias graves en ${name}.`);
  else {
    lines.push(facts.length === 1 ? `Ahora hay 1 corte, accidente o incidencia grave en ${name}:` : `Ahora hay ${facts.length} cortes, accidentes o incidencias graves en ${name}:`);
    listed(facts, lines, credits);
  }
  const minor = events.filter((e) => isTrafficIncident(e) && !roadWorthy(e) && typeof e.road === 'string' && roadCode(e.road) === sub.road
    && (!sub.province || trafficProvinceId(e) === sub.province.id)).length;
  if (minor) lines.push(`Además, ${minor === 1 ? '1 incidencia más leve' : `${minor} incidencias más leves`} (obras sin corte, retenciones…), en el mapa.`);
  return { lines, credits: [...credits] };
}

/**
 * Las líneas de tráfico de una provincia seguida (van con las de AEMET, terremotos y avisos oficiales).
 * @param {import('../provincias.js').Province} p
 * @returns {{ lines: string[], credits: string[] }}
 */
export function provinceTrafficStatus(p, { events = [], now, creditOf = () => null }) {
  const facts = trafficFacts({ provinces: [p.id], events, now, creditOf }).provinces.get(p.id) ?? [];
  if (!facts.length) return { lines: ['Carreteras: ahora no hay cortes ni accidentes graves.'], credits: [] };
  const lines = [facts.length === 1 ? 'Carreteras: 1 corte o accidente grave.' : `Carreteras: ${facts.length} cortes o accidentes graves.`];
  const credits = new Set();
  listed(facts, lines, credits);
  return { lines, credits: [...credits] };
}
