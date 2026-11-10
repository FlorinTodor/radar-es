import { locale, t } from './i18n.js';

export const STATUS = {
  none: '#898781',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

// Clases de retraso: índice → [color, etiqueta]. El 0 es "sin dato".
export const DELAY_CLASSES = [
  [STATUS.none, t('Sin dato de retraso')],
  [STATUS.good, t('En hora (menos de 5 min)')],
  [STATUS.warning, t('5 a 14 min')],
  [STATUS.serious, t('15 a 44 min')],
  [STATUS.critical, t('45 min o más')],
];

export function delayClass(v) {
  if (v.delay === null || v.delay === undefined) return v.late === true ? 2 : v.late === false ? 1 : 0;
  if (v.delay < 5) return 1;
  if (v.delay < 15) return 2;
  if (v.delay < 45) return 3;
  return 4;
}

export const SEVERITY_LABEL = { baja: t('Baja'), media: t('Media'), alta: t('Alta'), 'muy alta': t('Muy alta') };
export const SEVERITY_RANK = { 'muy alta': 4, alta: 3, media: 2, baja: 1 };
export const sevClass = (s) => `sev-${(s ?? 'baja').replace(' ', '-')}`;

export const MODE_LABEL = {
  av: t('Alta velocidad'), ld: t('Larga distancia'), md: t('Media distancia'), cercanias: t('Cercanías / Rodalies'),
  metro: t('Metro / urbano'), tranvia: t('Tranvía'), bus: t('Autobús'), otros: t('Otros'),
};

const nf = new Intl.NumberFormat(locale());
export const fmtNum = (n) => (n === null || n === undefined ? '–' : nf.format(n));
/** Un número con `digits` decimales, con la coma o el punto de cada idioma: fmtDec(2.5, 1) → «2,5» / «2.5». */
export const fmtDec = (n, digits = 1) => new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);

export function fmtDelay(v) {
  if (v.delay === null || v.delay === undefined) return v.late === true ? t('Con retraso') : v.late === false ? t('En hora') : '—';
  return v.delay <= 0 ? t('En hora') : `+${v.delay} min`;
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return t('ahora');
  if (s < 60) return t('hace {n} s', { n: s });
  if (s < 3600) return t('hace {n} min', { n: Math.round(s / 60) });
  if (s < 86400) return t('hace {n} h', { n: Math.round(s / 3600) });
  return t('hace {n} d', { n: Math.round(s / 86400) });
}

const timeFmt = new Intl.DateTimeFormat(locale(), { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat(locale(), { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const dateTimeYearFmt = new Intl.DateTimeFormat(locale(), { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const yearFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric' });
export const fmtTime = (ms) => (ms ? timeFmt.format(ms) : '—');
/**
 * «03/11, 09:22» o, si no es de este año, «22/12/2025, 08:20»: sin el año, una fecha del año pasado
 * parece de dentro de unas semanas (los horarios del NAP se publican a veces una vez al año).
 */
export const fmtDateTime = (ms, now = Date.now()) => {
  if (!ms) return '—';
  return (yearFmt.format(ms) === yearFmt.format(now) ? dateTimeFmt : dateTimeYearFmt).format(ms);
};
/** «15/04/2026, 11:22», siempre con el año: en la pestaña Fuentes, una fecha sin año no dice si el horario es de este año. */
export const fmtDateTimeYear = (ms) => (ms ? dateTimeYearFmt.format(ms) : '—');
const dateFmt = new Intl.DateTimeFormat(locale(), { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', year: 'numeric' });
export const fmtDate = (ms) => (ms ? dateFmt.format(ms) : '—');
const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }); // «2026-11-02»: el día en Madrid

// Con cuántos días de antelación se resalta que un horario se acaba (la misma que el aviso del servidor).
const ENDING_DAYS = 14;

/**
 * Hasta cuándo vale un horario ('YYYY-MM-DD', el último día con servicio): el texto y, si le quedan
 * ENDING_DAYS días o menos o ya ha caducado, el aviso. Desde el día siguiente sus vehículos dejan de salir.
 * @returns {{ text: string, warn: string|null, expired: boolean } | null}
 */
export function scheduleValidity(validUntil, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(validUntil ?? '');
  if (!m) return null;
  const [y, mo, d] = dayFmt.format(now).split('-').map(Number);
  const left = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(y, mo - 1, d)) / 86_400_000);
  const text = t('válido hasta el {date}', { date: `${m[3]}/${m[2]}/${m[1]}` });
  if (left < 0) return { text, warn: t('horario caducado'), expired: true };
  if (left > ENDING_DAYS) return { text, warn: null, expired: false };
  return { text, warn: left === 0 ? t('hoy es su último día') : left === 1 ? t('caduca mañana') : t('caduca en {n} días', { n: left }), expired: false };
}

/**
 * Cuándo es un dato: «de las 14:12» si es de hoy (en Madrid) y «del 01/11/2026 a las 14:12» si no.
 * Varias licencias piden la fecha de la última actualización (Llicència oberta de Catalunya, Govern
 * de les Illes Balears, Junta de Castilla y León, Red Eléctrica), y la hora sola parece de hoy.
 */
export function fmtDataTime(ms, now = Date.now()) {
  if (!ms) return '—';
  return dayFmt.format(ms) === dayFmt.format(now) ? t('de las {time}', { time: fmtTime(ms) }) : t('del {date} a las {time}', { date: fmtDate(ms), time: fmtTime(ms) });
}

// "2026-10-30T19:17:00" (hora local de Madrid) → "19:17"
export const fmtLocalHour = (s) => (s ? s.slice(11, 16) : '—');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Enlace externo seguro para un href: sólo http(s); si no, null (el servidor ya filtra, esto es la segunda barrera). */
export function safeUrl(url) {
  try {
    return ['https:', 'http:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

export function vehicleTitle(v) {
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  return `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim();
}

/** «https://commons.wikimedia.org/wiki/File:Fachada_estaci%C3%B3n_de_Sants.jpg» → «Fachada estación de Sants». */
export function photoTitleOf(page) {
  const file = /\/wiki\/File:([^?#]+)/.exec(page ?? '')?.[1];
  if (!file) return null;
  try {
    return decodeURIComponent(file).replace(/_/g, ' ').replace(/\.[a-z0-9]{2,5}$/i, '');
  } catch {
    return null;
  }
}

// Atribuciones que piden su enlace (la del NAP, la del CRTM y la de TRAM Barcelona), igual que en el pie
// del mapa. Sólo se enlaza a sus portadas.
const CREDIT_LINKS = [
  ['MITRAMS', 'https://www.transportes.gob.es/'], ['CRTM', 'https://www.crtm.es/'], ['TRAM Barcelona', 'https://www.tram.cat/'],
  ['CC BY 3.0 ES', 'https://creativecommons.org/licenses/by/3.0/es/'], // Gobierno de Cantabria: la licencia pide enlazarla
];

/** Texto de atribución como HTML, escapado y con el enlace de las que lo piden. */
export function creditHtml(text) {
  return CREDIT_LINKS.reduce((html, [name, url]) => html.replace(name, `<a href="${url}" target="_blank" rel="noopener">${name}</a>`), esc(text));
}
