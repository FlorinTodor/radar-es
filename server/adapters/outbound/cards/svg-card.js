// La tarjeta de compartir (1200×630, el tamaño que piden WhatsApp, Telegram y X) como SVG, a partir de lo que dice
// domain/compartir.js: a la izquierda qué pasa, dónde y desde cuándo; a la derecha España con el sitio marcado (y
// Canarias en un recuadro); abajo, la atribución de su fuente y la dirección de la web. Puro: un texto entra y otro
// sale; el PNG lo hace png-card.js en un hilo aparte.
//
// No hay medidas de la letra: el ancho de cada carácter se estima por lo largo (con las de DejaVu Sans, algo por
// encima), así que una línea puede quedar un poco más corta de lo que cabría, nunca salirse.
import { ALGERIA, FRANCE, MOROCCO, PORTUGAL, SPAIN } from './silueta.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const INK = '#f0efec';
const INK_2 = '#c3c2b7';
const MUTED = '#898781';
const PAGE = '#121211';
const LAND = '#2c2b28';
const LAND_EDGE = '#55534c';
const NEIGHBOUR = '#1c1c1a';
const NEIGHBOUR_EDGE = '#34332f';
const ACCENT = '#6ea8fe';
const GOOD = '#0ca30c';

// ---------- Texto ----------
const NARROW = new Set([...'iljI.,:;\'|!¡()[]{}`’‘']);
const SEMI = new Set([...'frtJ-/"“”']);
const WIDE = new Set([...'mwMWÆŒ@%']);
/** Ancho aproximado de un carácter, en «em» (DejaVu Sans, redondeado hacia arriba). */
function charEm(ch) {
  if (ch === ' ') return 0.32;
  if (NARROW.has(ch)) return 0.32;
  if (SEMI.has(ch)) return 0.42;
  if (WIDE.has(ch)) return 0.98;
  if (ch >= '0' && ch <= '9') return 0.64;
  if (ch !== ch.toLowerCase()) return 0.74; // mayúsculas
  return 0.63;
}
/** Ancho aproximado de un texto, en px. */
export function textWidth(text, size, bold = false) {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * size * (bold ? 1.1 : 1);
}

/**
 * Parte un texto en líneas de como mucho `width` px; si no cabe en `max` líneas, la última acaba en «…». Una palabra
 * más larga que la línea se corta.
 * @returns {string[]}
 */
export function wrap(text, { size, width, max, bold = false }) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  const fits = (s) => textWidth(s, size, bold) <= width;
  for (let word of words) {
    while (!fits(word)) { // una palabra que no cabe sola: se corta donde quepa
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const out = lines.slice(0, max);
  // Sin el punto o la coma de antes: «… (hora de Canarias).…» no.
  const ellipsis = (s) => `${s.replace(/[\s.,;:·-]+$/u, '')}…`;
  let last = ellipsis(out[max - 1]);
  while (last.length > 1 && !fits(last)) last = ellipsis(last.slice(0, -2));
  out[max - 1] = last;
  return out;
}

// Sin emojis ni caracteres de control (la letra no los tiene: saldrían como cuadros) y con los espacios juntos.
const clean = (s) => String(s ?? '').replace(/[\p{Extended_Pictographic}\p{Cc}️‍]/gu, ' ').replace(/\s+/g, ' ').trim();
const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
// Sólo colores con la forma de los nuestros: el color va dentro de un atributo.
const color = (c, fallback = ACCENT) => (/^#[0-9a-f]{6}$/i.test(c ?? '') ? c : fallback);

// ---------- Mapa ----------
// La península y Baleares, en equirectangular con la escala del paralelo 40 (a ese tamaño basta), y Canarias en un
// recuadro debajo, a la misma escala.
const MAP = { x: 724, y: 96, lon0: -9.7, lon1: 4.6, lat0: 35.5, lat1: 44.1 };
const COS_MAIN = Math.cos((40 * Math.PI) / 180);
const SCALE = 424 / ((MAP.lon1 - MAP.lon0) * COS_MAIN); // px por grado de latitud
const MAP_H = (MAP.lat1 - MAP.lat0) * SCALE;
const INSET = { x: 732, y: MAP.y + MAP_H + 22, lon0: -18.4, lon1: -13.2, lat0: 27.5, lat1: 29.5, pad: 10 };
const COS_INSET = Math.cos((28.5 * Math.PI) / 180);
const INSET_W = (INSET.lon1 - INSET.lon0) * COS_INSET * SCALE;
const INSET_H = (INSET.lat1 - INSET.lat0) * SCALE;

const inInset = ({ lon, lat }) => lon >= INSET.lon0 && lon <= INSET.lon1 && lat >= INSET.lat0 && lat <= INSET.lat1;
const inMain = ({ lon, lat }) => lon >= MAP.lon0 && lon <= MAP.lon1 && lat >= MAP.lat0 && lat <= MAP.lat1;
/** [x, y] en la tarjeta de un punto; null si cae fuera de los dos mapas. */
function project(p) {
  if (inInset(p)) return [INSET.x + (p.lon - INSET.lon0) * COS_INSET * SCALE, INSET.y + (INSET.lat1 - p.lat) * SCALE];
  if (inMain(p)) return [MAP.x + (p.lon - MAP.lon0) * COS_MAIN * SCALE, MAP.y + (MAP.lat1 - p.lat) * SCALE];
  return null;
}
const r1 = (n) => Math.round(n * 10) / 10;
function ringPath(ring, toXY) {
  let d = '';
  for (let i = 0; i < ring.length; i += 2) {
    const [x, y] = toXY(ring[i], ring[i + 1]);
    d += `${i ? 'L' : 'M'}${r1(x)} ${r1(y)}`;
  }
  return `${d}Z`;
}
const mainXY = (lon, lat) => [MAP.x + (lon - MAP.lon0) * COS_MAIN * SCALE, MAP.y + (MAP.lat1 - lat) * SCALE];
const insetXY = (lon, lat) => [INSET.x + (lon - INSET.lon0) * COS_INSET * SCALE, INSET.y + (INSET.lat1 - lat) * SCALE];
const isCanaryRing = (ring) => ring[1] < 30;

// Los contornos no cambian: se dibujan una vez.
let mapSvg = null;
function baseMap() {
  if (mapSvg) return mapSvg;
  const neighbours = [PORTUGAL, FRANCE, MOROCCO, ALGERIA].flat().map((r) => ringPath(r, mainXY)).join('');
  const main = SPAIN.filter((r) => !isCanaryRing(r)).map((r) => ringPath(r, mainXY)).join('');
  const canarias = SPAIN.filter(isCanaryRing).map((r) => ringPath(r, insetXY)).join('');
  const w = (MAP.lon1 - MAP.lon0) * COS_MAIN * SCALE;
  mapSvg = `<clipPath id="peninsula"><rect x="${r1(MAP.x)}" y="${r1(MAP.y)}" width="${r1(w)}" height="${r1(MAP_H)}"/></clipPath>`
    + `<g clip-path="url(#peninsula)"><path d="${neighbours}" fill="${NEIGHBOUR}" stroke="${NEIGHBOUR_EDGE}" stroke-width="1.5" stroke-linejoin="round"/>`
    + `<path d="${main}" fill="${LAND}" stroke="${LAND_EDGE}" stroke-width="2" stroke-linejoin="round"/></g>`
    + `<rect x="${r1(INSET.x - INSET.pad)}" y="${r1(INSET.y - INSET.pad)}" width="${r1(INSET_W + 2 * INSET.pad)}" height="${r1(INSET_H + 2 * INSET.pad)}" rx="8" fill="none" stroke="${NEIGHBOUR_EDGE}" stroke-width="1.5"/>`
    + `<path d="${canarias}" fill="${LAND}" stroke="${LAND_EDGE}" stroke-width="2" stroke-linejoin="round"/>`;
  return mapSvg;
}

/** El sitio (o el viaje) en el mapa, con el color de su gravedad. */
function marker(card) {
  const c = color(card.color);
  let out = '';
  const route = (card.route ?? []).map(([lon, lat]) => project({ lon, lat })).filter(Boolean);
  if (route.length > 1) {
    out += `<polyline points="${route.map(([x, y]) => `${r1(x)},${r1(y)}`).join(' ')}" fill="none" stroke="${c}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`;
    for (const [x, y] of [route[0], route.at(-1)]) out += `<circle cx="${r1(x)}" cy="${r1(y)}" r="7" fill="${PAGE}" stroke="${c}" stroke-width="4"/>`;
  }
  const at = card.point ? project(card.point) : route.length ? route[0] : null;
  if (at && route.length < 2) {
    const [x, y] = at.map(r1);
    if (card.approx) out += `<circle cx="${x}" cy="${y}" r="38" fill="none" stroke="${c}" stroke-width="3" stroke-dasharray="7 7" opacity="0.8"/>`;
    out += `<circle cx="${x}" cy="${y}" r="26" fill="${c}" opacity="0.25"/><circle cx="${x}" cy="${y}" r="12" fill="${c}" stroke="${INK}" stroke-width="3"/>`;
  }
  return out;
}

// El logotipo de la web (los círculos del radar de la barra superior).
const logo = (x, y, r) => `<g fill="none" stroke="${ACCENT}" stroke-width="${r1(r / 6)}"><circle cx="${x}" cy="${y}" r="${r}"/>`
  + `<circle cx="${x}" cy="${y}" r="${r1(r * 0.55)}" opacity="0.6"/></g><circle cx="${x}" cy="${y}" r="${r1(r * 0.22)}" fill="${ACCENT}"/>`;

/**
 * La tarjeta, como SVG.
 * @param {import('../../../domain/compartir.js').ShareCard} card
 * @param {{ font?: string, site?: string }} [o]  font: la familia de la letra (la que tenga el dibujante); site: la
 *   dirección que se lee abajo.
 */
export function cardSvg(card, { font = 'DejaVu Sans', site = 'radarespana.es' } = {}) {
  const left = 64;
  const width = 600;
  const c = color(card.color);
  const parts = [];
  const text = (x, y, s, { size, fill = INK, bold = false, anchor = 'start', spacing = 0 }) => parts.push(
    `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}"${bold ? ' font-weight="bold"' : ''} fill="${fill}"${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${spacing ? ` letter-spacing="${spacing}"` : ''}>${xml(s)}</text>`,
  );

  // Qué es, arriba, con el color de su gravedad.
  // Cabe hasta el mapa (x = 724); el espaciado de las letras, 1 px por cada una, se descuenta del ancho.
  const kickerText = clean(card.kicker).toUpperCase();
  const kicker = wrap(kickerText, { size: 20, width: 636 - kickerText.length, max: 1, bold: true });
  if (kicker[0]) text(left, 92, kicker[0], { size: 20, fill: c, bold: true, spacing: 1 });

  // Lo de en medio: título, descripción, detalles y estado, de arriba abajo, hasta donde cabe (por encima del pie).
  const bottom = 520;
  let title = wrap(card.title, { size: 50, width, max: 3, bold: true });
  let titleSize = 50;
  if (title.length === 3 && title[2].endsWith('…')) {
    titleSize = 42;
    title = wrap(card.title, { size: 42, width, max: 3, bold: true });
  }
  const titleStep = Math.round(titleSize * 1.2);
  const statusLines = card.status ? wrap(card.status.text, { size: 23, width: width - 34, max: 2 }) : [];
  const statusH = statusLines.length ? (statusLines.length - 1) * 30 + 44 : 0;
  // Líneas de base: la del título, y cada bloque a su distancia del anterior.
  let y = 92 + 34 + titleSize;
  title.forEach((line, i) => text(left, y + i * titleStep, line, { size: titleSize, bold: true }));
  y += (title.length - 1) * titleStep;
  const limit = bottom - statusH; // la última línea de base que cabe encima del estado
  const desc = card.description ? wrap(card.description, { size: 27, width, max: 3 }) : [];
  const details = (card.details ?? []).flatMap((d) => wrap(d, { size: 23, width, max: 2 }));
  // Primero los detalles (horas de la fuente, retraso), que son lo que cambia; luego, lo que quepa de la descripción.
  const DESC_GAP = 54;
  const DESC_STEP = 36;
  const DETAILS_GAP = 44;
  const DETAILS_STEP = 31;
  const detailsH = details.length ? DETAILS_GAP + (details.length - 1) * DETAILS_STEP : 0;
  let descFits = desc.length;
  while (descFits && y + DESC_GAP + (descFits - 1) * DESC_STEP + detailsH > limit) descFits--;
  if (descFits) {
    desc.slice(0, descFits).forEach((line, i) => {
      // Si no cabe entera, la última línea que cabe acaba en «…».
      const shown = descFits < desc.length && i === descFits - 1 ? `${line.replace(/[\s.,;:·…-]+$/u, '')}…` : line;
      text(left, y + DESC_GAP + i * DESC_STEP, shown, { size: 27, fill: INK_2 });
    });
    y += DESC_GAP + (descFits - 1) * DESC_STEP;
  }
  details.forEach((line, i) => {
    const at = y + (i ? DETAILS_STEP : descFits ? DETAILS_GAP : DESC_GAP);
    if (at > limit) return;
    text(left, at, line, { size: 23, fill: INK_2 });
    y = at;
  });
  if (statusLines.length) {
    let sy = Math.max(y + 52, bottom - statusH + 30);
    parts.push(`<circle cx="${left + 9}" cy="${r1(sy - 8)}" r="8" fill="${card.status.active ? GOOD : MUTED}"/>`);
    for (const line of statusLines) {
      text(left + 30, sy, line, { size: 23, fill: card.status.active ? INK : INK_2 });
      sy += 30;
    }
  }

  // Bajo el mapa, si el sitio es aproximado (el centro de lo que nombra el aviso, o una posición estimada).
  // A la derecha del recuadro de Canarias, en una o dos líneas.
  const approx = card.approx && card.point ? (card.lang === 'en' ? 'Approximate location' : 'Ubicación aproximada') : null;
  if (approx) {
    const x = INSET.x + INSET_W + INSET.pad + 24;
    const lines = wrap(approx, { size: 19, width: 1150 - x, max: 2 });
    lines.forEach((line, i) => text(x, INSET.y + INSET_H / 2 + 7 - ((lines.length - 1) * 24) / 2 + i * 24, line, { size: 19, fill: MUTED }));
  }

  // Pie: la atribución que pide su fuente (entera: si no cabe en dos líneas, en tres más pequeñas) y la web.
  const footWidth = 820;
  let credit = wrap(card.credit, { size: 20, width: footWidth, max: 2 });
  let creditSize = 20;
  if (credit.at(-1)?.endsWith('…')) {
    creditSize = 16;
    credit = wrap(card.credit, { size: 16, width: footWidth, max: 3 });
  }
  const footTop = 556;
  parts.push(`<rect x="0" y="${footTop}" width="${CARD_WIDTH}" height="1.5" fill="${NEIGHBOUR_EDGE}"/>`);
  const creditStart = footTop + (CARD_HEIGHT - footTop) / 2 - ((credit.length - 1) * creditSize * 1.25) / 2 + creditSize * 0.35;
  credit.forEach((line, i) => text(left, creditStart + i * creditSize * 1.25, line, { size: creditSize, fill: MUTED }));
  text(1136, footTop + 46, site, { size: 28, bold: true, anchor: 'end' });
  parts.push(logo(1136 - textWidth(site, 28, true) - 26, footTop + 36, 15));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="${xml(font)}">`
    + `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${PAGE}"/><rect width="12" height="${footTop}" fill="${c}"/>`
    + `${baseMap()}${marker(card)}${parts.join('')}</svg>`;
}
