export const STATUS = {
  none: '#898781',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
};

// Clases de retraso: índice → [color, etiqueta]. El 0 es "sin dato".
export const DELAY_CLASSES = [
  [STATUS.none, 'Sin dato de retraso'],
  [STATUS.good, 'En hora (menos de 5 min)'],
  [STATUS.warning, '5 a 14 min'],
  [STATUS.serious, '15 a 44 min'],
  [STATUS.critical, '45 min o más'],
];

export function delayClass(v) {
  if (v.delay === null || v.delay === undefined) return v.late === true ? 2 : v.late === false ? 1 : 0;
  if (v.delay < 5) return 1;
  if (v.delay < 15) return 2;
  if (v.delay < 45) return 3;
  return 4;
}

export const SEVERITY_LABEL = { baja: 'Baja', media: 'Media', alta: 'Alta', 'muy alta': 'Muy alta' };
export const SEVERITY_RANK = { 'muy alta': 4, alta: 3, media: 2, baja: 1 };
export const sevClass = (s) => `sev-${(s ?? 'baja').replace(' ', '-')}`;

export const MODE_LABEL = {
  av: 'Alta velocidad', ld: 'Larga distancia', md: 'Media distancia', cercanias: 'Cercanías / Rodalies',
  metro: 'Metro / urbano', tranvia: 'Tranvía', bus: 'Autobús', avion: 'Aviones (ADS-B)', otros: 'Otros',
};

const nf = new Intl.NumberFormat('es-ES');
export const fmtNum = (n) => (n === null || n === undefined ? '–' : nf.format(n));

export function fmtDelay(v) {
  if (v.delay === null || v.delay === undefined) return v.late === true ? 'Con retraso' : v.late === false ? 'En hora' : '—';
  return v.delay <= 0 ? 'En hora' : `+${v.delay} min`;
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} d`;
}

const timeFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
const dateTimeFmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = (ms) => (ms ? timeFmt.format(ms) : '—');
export const fmtDateTime = (ms) => (ms ? dateTimeFmt.format(ms) : '—');

// "2026-10-30T19:17:00" (hora local de Madrid) → "19:17"
export const fmtLocalHour = (s) => (s ? s.slice(11, 16) : '—');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export function vehicleTitle(v) {
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  return `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim();
}
