// Gráficas del día en cifras, como texto SVG/HTML: sin DOM ni librerías, para poder probarlas en Node.
// Siguen las reglas de la casa para gráficas: líneas de 2 px, columnas de como mucho 24 px con el extremo
// redondeado y la base recta, rejilla de un pelo y en gris, el texto nunca del color del dato, y los
// valores también en la tabla (la ficha sólo los repite al pasar por encima).
import { esc } from './format.js';
import { locale, t } from './i18n.js';

// Los formatos, uno por idioma (se crean la primera vez que hacen falta).
const formats = new Map();
const format = (kind, make) => {
  const key = `${kind}|${locale()}`;
  if (!formats.has(key)) formats.set(key, make(locale()));
  return formats.get(key);
};
/** Número con el formato del idioma («1.284», «12,5» / «1,284», «12.5»); «–» si no hay. */
export const fmt = (n) => (Number.isFinite(n) ? format('num', (l) => new Intl.NumberFormat(l, { maximumFractionDigits: 1 })).format(n) : '–');
/** «7 h» (en inglés, «7:00») */
export const hourLabel = (h) => t('{h} h', { h });

/** Techo «redondo» del eje y sus marcas (0, 50, 100…): de 3 a 5 marcas. */
export function niceScale(max) {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max: top, ticks };
}

/** El tramo de la línea sin huecos: un trazo por cada racha de valores. */
function pathOf(values, x, y) {
  let d = '';
  let open = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) {
      open = false;
      return;
    }
    d += `${open ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    open = true;
  });
  return d;
}

const PAD = { top: 12, right: 40, bottom: 22, left: 34 };

/**
 * Una gráfica de líneas por horas (0–23): hoy y, si la hay, la referencia (el mismo día de la semana
 * anterior), en gris. Al final de la línea de hoy, su valor.
 * @param {{ width: number, height: number, today: Array<number|null>, compare?: Array<number|null>|null,
 *           label: string, unit?: string }} o
 *   label: qué se dibuja, para quien no ve la gráfica (aria-label).
 */
export function lineChart({ width, height, today, compare = null, label, unit = '' }) {
  const w = Math.max(160, width);
  const h = Math.max(100, height);
  const all = [...today, ...(compare ?? [])].filter(Number.isFinite);
  const { max, ticks } = niceScale(Math.max(...all, 0));
  const x = (i) => PAD.left + (i * (w - PAD.left - PAD.right)) / 23;
  const y = (v) => h - PAD.bottom - (v / max) * (h - PAD.top - PAD.bottom);
  const grid = ticks.map((v) => `<line class="grid" x1="${PAD.left}" x2="${w - PAD.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`
    + `<text class="tick" x="${PAD.left - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}${unit}</text>`).join('');
  const xs = [0, 6, 12, 18, 23].map((i) => `<text class="tick" x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${hourLabel(i)}</text>`).join('');
  const last = today.reduce((acc, v, i) => (Number.isFinite(v) ? i : acc), -1);
  const end = last >= 0
    ? `<circle class="dot-today" cx="${x(last).toFixed(1)}" cy="${y(today[last]).toFixed(1)}" r="4"/>`
      + `<text class="end" x="${(x(last) + 7).toFixed(1)}" y="${(y(today[last]) + 4).toFixed(1)}">${fmt(today[last])}${unit}</text>`
    : '';
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" tabindex="0"
    data-x0="${x(0).toFixed(1)}" data-x1="${x(23).toFixed(1)}" data-top="${PAD.top}" data-bottom="${h - PAD.bottom}">
    ${grid}${xs}
    ${compare ? `<path class="line-compare" d="${pathOf(compare, x, y)}"/>` : ''}
    <path class="line-today" d="${pathOf(today, x, y)}"/>${end}
    <line class="crosshair" x1="0" x2="0" y1="${PAD.top}" y2="${h - PAD.bottom}" visibility="hidden"/></svg>`;
}

/**
 * Columnas por horas (0–23), una serie (por ejemplo el % con retraso). Columnas de como mucho 24 px, con
 * su hueco, el extremo redondeado (4 px) y la base recta.
 * @param {{ width: number, height: number, values: Array<number|null>, label: string, unit?: string, fixedMax?: number }} o
 */
export function columnChart({ width, height, values, label, unit = '', fixedMax }) {
  const w = Math.max(160, width);
  const h = Math.max(100, height);
  const { max, ticks } = niceScale(fixedMax ?? Math.max(...values.filter(Number.isFinite), 0));
  const band = (w - PAD.left - PAD.right) / 24;
  const bar = Math.max(2, Math.min(24, band - 2)); // con el hueco de 2 px
  const x = (i) => PAD.left + i * band + (band - bar) / 2;
  const y = (v) => h - PAD.bottom - (Math.min(v, max) / max) * (h - PAD.top - PAD.bottom);
  const base = h - PAD.bottom;
  const grid = ticks.map((v) => `<line class="grid" x1="${PAD.left}" x2="${w - PAD.right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`
    + `<text class="tick" x="${PAD.left - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end">${fmt(v)}${unit}</text>`).join('');
  const r = Math.min(4, bar / 2);
  const cols = values.map((v, i) => {
    if (!Number.isFinite(v) || v <= 0) return '';
    const top = y(v);
    const height = base - top;
    const rr = Math.min(r, height);
    const x0 = x(i).toFixed(1);
    const x1 = (x(i) + bar).toFixed(1);
    // Arriba redondeado, abajo recto: la columna sale de la base.
    return `<path class="col" data-i="${i}" d="M${x0} ${base}V${(top + rr).toFixed(1)}Q${x0} ${top.toFixed(1)} ${(x(i) + rr).toFixed(1)} ${top.toFixed(1)}`
      + `H${(x(i) + bar - rr).toFixed(1)}Q${x1} ${top.toFixed(1)} ${x1} ${(top + rr).toFixed(1)}V${base}Z"/>`;
  }).join('');
  const xs = [0, 6, 12, 18, 23].map((i) => `<text class="tick" x="${(x(i) + bar / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${hourLabel(i)}</text>`).join('');
  return `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}" tabindex="0"
    data-x0="${(x(0) + bar / 2).toFixed(1)}" data-x1="${(x(23) + bar / 2).toFixed(1)}" data-top="${PAD.top}" data-bottom="${base}">
    ${grid}${xs}${cols}<line class="crosshair" x1="0" x2="0" y1="${PAD.top}" y2="${base}" visibility="hidden"/></svg>`;
}

/**
 * Barras horizontales (HTML) de mayor a menor: nombre encima, barra y su valor al final. Una serie.
 * @param {Array<{ label: string, value: number, sub?: string }>} items
 */
export function hbars(items, { unit = '' } = {}) {
  const max = Math.max(...items.map((i) => i.value), 0) || 1;
  return `<ol class="hbars">${items.map((i) => `<li>
    <div class="hb-label">${esc(i.label)}${i.sub ? ` <span class="hb-sub">${esc(i.sub)}</span>` : ''}</div>
    <div class="hb-row"><span class="hb-bar" style="width:${Math.max(1, (100 * i.value) / max).toFixed(1)}%"></span><span class="hb-val">${fmt(i.value)}${unit}</span></div>
  </li>`).join('')}</ol>`;
}

/** La hora (0–23) más cercana a la posición x del puntero dentro de una gráfica por horas. */
export function hourAt(px, x0, x1) {
  if (!(x1 > x0)) return 0;
  return Math.max(0, Math.min(23, Math.round(((px - x0) / (x1 - x0)) * 23)));
}

const dayFormat = (kind, opts) => format(kind, (l) => new Intl.DateTimeFormat(l, { timeZone: 'UTC', ...opts }));
/** «martes, 10 de noviembre de 2026» / «Tuesday, 10 November 2026» */
export const dayTitle = (date) => dayFormat('title', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
/** «mar, 10 nov» / «Tue 10 Nov» */
export const dayShort = (date) => dayFormat('short', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));

/**
 * La mediana del retraso como frase: «la mitad, 2 min o menos» si se sabe el minuto; si cae en un tramo,
 * «retraso mediano: entre 30 y 59 min» o «retraso mediano: 60 min o más». null si no hay.
 */
export function medianPhrase(m) {
  if (!m) return null;
  if (Number.isFinite(m.minutes)) return t('la mitad, {n} min o menos', { n: m.minutes });
  return m.to ? t('retraso mediano: entre {from} y {to} min', { from: m.from, to: m.to }) : t('retraso mediano: {from} min o más', { from: m.from });
}
