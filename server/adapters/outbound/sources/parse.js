// Utilidades de parseo compartidas por los adaptadores de fuentes.
import { XMLParser } from 'fast-xml-parser';

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
});

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Valor de una tabla de traducción para una clave que viene de una fuente externa, sin caer en
 * propiedades heredadas: con «__proto__» o «constructor», `TABLA[clave]` devolvería un objeto y
 * rompería el panel o la lectura de la fuente.
 */
export const lookup = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);

export const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** Texto de un nodo XML parseado, tenga o no atributos. */
export function text(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return v['#text'] !== undefined ? String(v['#text']) : null;
  return String(v);
}

/** Primera clave con ese nombre buscando en profundidad (útil en XML muy anidado como DATEX II). */
export function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findKey(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Todo lo que va en «hora de Madrid» sale de aquí, de un solo formateador: el día de los horarios,
// el de los ficheros del histórico y las horas de paso se calculaban con cuatro distintos, y uno
// tomaba el día en UTC (entre las 00:00 y la 01:00 o las 02:00 de Madrid, el día anterior). Por
// partes, para no depender de cómo escribe la fecha cada idioma.
const MADRID_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function madridParts(t) {
  const p = {};
  for (const { type, value } of MADRID_PARTS.formatToParts(t)) p[type] = value;
  return p;
}

/** Fecha y hora de Madrid de un instante (epoch ms), "2026-10-30T19:05:43" (sin zona). */
export function madridDateTime(t) {
  const p = madridParts(t);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Día de Madrid de un instante (epoch ms), "YYYY-MM-DD". */
export const madridDate = (t) => madridDateTime(t).slice(0, 10);

/** Fecha de hoy en Madrid, "YYYY-MM-DD". `now`, para los tests. */
export const madridToday = (now = Date.now()) => madridDate(now);

/**
 * Día de servicio en Madrid desplazado `offset` días: su fecha («AAAAMMDD» y «AAAA-MM-DD»), su día de la
 * semana (0 = lunes) y su medianoche (epoch ms).
 */
export function madridServiceDay(now, offset = 0) {
  const [y, m, d] = madridDate(now).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + offset));
  const iso = day.toISOString().slice(0, 10);
  return { ymd: iso.replaceAll('-', ''), iso, weekday: (day.getUTCDay() + 6) % 7, midnight: madridLocalToMs(`${iso}T00:00:00`) };
}

/** «HH:MM» de un instante (epoch ms) en hora de Madrid. */
export const madridClock = (t) => madridDateTime(t).slice(11, 16);

/** "2026-10-30T19:05:43" en hora local de Madrid (sin zona) → epoch ms. */
export function madridLocalToMs(s) {
  if (!s) return null;
  const asUtc = Date.parse(`${s}Z`);
  if (Number.isNaN(asUtc)) return null;
  const p = madridParts(asUtc);
  const madridAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - (madridAsUtc - asUtc);
}

// Entidades HTML con nombre que usan los avisos de las webs autonómicas (el resto llegan como &#nnn;).
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', middot: '·', euro: '€', deg: '°', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  agrave: 'à', egrave: 'è', ograve: 'ò', Agrave: 'À', Egrave: 'È', Ograve: 'Ò', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', Uuml: 'Ü',
  iuml: 'ï', ccedil: 'ç', Ccedil: 'Ç',
};

/** Decodifica entidades HTML («&oacute;», «&#243;», «&#x27;»); las desconocidas se dejan como están. */
function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return lookup(ENTITIES, e) ?? all;
  });
}

/**
 * Texto de un fragmento HTML (descripción de un RSS, cuerpo de una noticia): sin etiquetas ni
 * comentarios, con las entidades decodificadas (también las escapadas dos veces, «&amp;oacute;») y
 * los espacios juntos. Los párrafos se separan con un salto de línea.
 */
export function htmlText(html) {
  const withBreaks = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(decodeEntities(withBreaks))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
