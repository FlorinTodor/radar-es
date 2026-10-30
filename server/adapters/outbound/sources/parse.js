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

const madridFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Madrid', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** "2026-10-30T19:05:43" en hora local de Madrid (sin zona) → epoch ms. */
export function madridLocalToMs(s) {
  if (!s) return null;
  const asUtc = Date.parse(`${s}Z`);
  if (Number.isNaN(asUtc)) return null;
  const p = Object.fromEntries(madridFmt.formatToParts(asUtc).map((x) => [x.type, x.value]));
  const madridAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - (madridAsUtc - asUtc);
}

/** Fecha de hoy en Madrid, "YYYY-MM-DD". */
export const madridToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
