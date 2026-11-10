// Puntualidad histórica en la ficha de un vehículo, de una cancelación o de un tren sin datos
// (/api/puntualidad/<clave>): la de su servicio o, si no la hay, la de su línea, con una tira de los últimos
// días. Vale para cualquier tipo de vehículo: sólo usa sus claves `follow` (ver docs/vehiculos.md) y los
// nombres del registro de tipos (/api/modes).
//
// La ficha se repinta entera cada pocos segundos: punctualitySlot pone lo que ya se sabe (o nada) y, si hace
// falta, lo pide; cuando llega, rellena el hueco que esté en la página. Así no hay parpadeo ni peticiones de más.
import { esc } from './format.js';

const STRIP_DAYS = 14;
const FRESH_MS = 60_000; // lo de hoy cambia cada minuto (como la caché de la ruta)
const LATE = 5;

const DAY_FMT = new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso) => DAY_FMT.format(Date.parse(`${iso}T12:00:00Z`)).replace(/\./g, '');
const pct = (share) => `${Math.round(share * 100)} %`; // espacio duro: que el % no salte de línea

// Cada estado de un día: su signo (para no depender del color) y cómo se dice.
const STATUS = {
  'a-tiempo': { mark: '✓', label: 'a tiempo' },
  tarde: { mark: '+', label: `${LATE} min o más de retraso` },
  cancelado: { mark: '×', label: 'cancelado' },
  parcial: { mark: '–', label: 'con paradas suprimidas' },
  'en-curso': { mark: '…', label: 'en curso' },
  'sin-dato': { mark: '', label: 'sin dato' },
};

/** Las claves que importan de una lista `follow`: la del servicio y la de la línea. */
export function punctualityKeys(follow) {
  const list = Array.isArray(follow) ? follow : [];
  return { service: list.find((k) => typeof k === 'string' && k.startsWith('s-')) ?? null, line: list.find((k) => typeof k === 'string' && k.startsWith('l-')) ?? null };
}

const minutes = (n) => `${n} min`;
const delayText = (d) => (d === null || d === undefined ? '' : d <= 0 ? 'en hora' : `+${minutes(d)}`);

/** Lo que dice un día de un servicio, para su descripción y la lista accesible. */
function serviceDayText(d) {
  const what = STATUS[d.status]?.label ?? d.status;
  const delay = d.delay !== undefined && d.status !== 'cancelado' ? ` (${d.status === 'en-curso' ? 'ahora ' : 'al llegar '}${delayText(d.delay)}${d.max > d.delay ? `; máx. +${minutes(d.max)}` : ''})` : '';
  return `${dayLabel(d.day)}: ${what}${delay}${d.partial && d.status !== 'parcial' ? ', con paradas suprimidas' : ''}`;
}

function serviceStrip(days) {
  const shown = days.slice(-STRIP_DAYS);
  const cells = shown.map((d) => `<li class="pd pd-${esc(d.status)}" title="${esc(serviceDayText(d))}"><span aria-hidden="true">${STATUS[d.status]?.mark ?? ''}</span></li>`).join('');
  const label = `Últimos ${shown.length} días, del más antiguo al de hoy: ${shown.map(serviceDayText).join('; ')}`;
  // La leyenda, de los estados que salen en la tira (en el orden de STATUS).
  const present = new Set(shown.map((d) => d.status));
  const legend = Object.keys(STATUS).filter((s) => present.has(s))
    .map((s) => `<span><i class="pd pd-${s}" aria-hidden="true">${STATUS[s].mark}</i>${STATUS[s].label}</span>`).join('');
  return `<ol class="pstrip" role="img" aria-label="${esc(label)}">${cells}</ol><div class="plegend" aria-hidden="true">${legend}</div>`;
}

function lineStrip(days, noun) {
  const shown = days.slice(-STRIP_DAYS);
  // La escala, hasta el día más alto (al menos el 20 %, redondeado a la decena): de 0 a 100 %, los días
  // normales (entre el 5 y el 30 %) no se distinguían. Arriba se dice cuánto es.
  const top = Math.max(0.2, Math.ceil(Math.max(0, ...shown.map((d) => d.lateShare ?? 0)) * 10) / 10);
  const text = (d) => (d.samples
    ? `${dayLabel(d.day)}: ${pct(d.lateShare)} de las lecturas con ${LATE} min o más (${d.vehicles} ${noun})${d.cancelled ? `, ${d.cancelled} cancelaciones` : ''}`
    : `${dayLabel(d.day)}: ${d.cancelled ? `sin lecturas de retraso, ${d.cancelled} cancelaciones` : 'sin dato'}`);
  const cells = shown.map((d) => {
    const h = d.samples ? Math.max(4, Math.round((d.lateShare / top) * 100)) : 0;
    return `<li class="pb${d.samples ? '' : ' pb-none'}" title="${esc(text(d))}"><span style="height:${h}%"></span></li>`;
  }).join('');
  const label = `Últimos ${shown.length} días, del más antiguo al de hoy: ${shown.map(text).join('; ')}`;
  return `<div class="pbars-wrap"><ol class="pbars" role="img" aria-label="${esc(label)}">${cells}</ol><span class="ptop" aria-hidden="true">${pct(top)}</span></div>
    <div class="plegend" aria-hidden="true"><span>Altura: parte de las lecturas del día con ${LATE} min o más de retraso (arriba, el ${pct(top)})</span></div>`;
}

/** «desde el 10 nov», si el radar lo sigue desde hace poco (menos de los días de la tira). */
function sinceText(r, today) {
  const first = r.firstSeen ?? r.since;
  if (!first || !today) return '';
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000);
  if (days >= STRIP_DAYS) return '';
  return days <= 0 ? ' El radar lo sigue desde hoy.' : ` El radar lo sigue desde el ${dayLabel(first)}.`;
}

/**
 * HTML de la puntualidad de un servicio o de una línea (lo que da /api/puntualidad/<clave>).
 * @param {object} r  informe
 * @param {{ nounPlural?: (mode: string) => string }} [opts]  nombre de varios vehículos de un tipo (de /api/modes)
 */
export function punctualityHtml(r, { nounPlural = () => 'vehículos' } = {}) {
  if (!r?.days?.length) return '';
  const today = r.days.at(-1).day;
  let summary;
  let strip;
  if (r.kind === 'servicio') {
    const ranDays = (r.recent?.days ?? 0) - (r.recent?.cancelled ?? 0);
    const parts = [];
    if (r.now) parts.push(`Hoy va ${r.now.delay > 0 ? `con +${minutes(r.now.delay)}` : 'en hora'}.`);
    if (ranDays > 0) {
      parts.push(ranDays === 1
        ? `El último día en que circuló llegó ${r.recent.late ? `con ${LATE} min o más de retraso` : 'a tiempo'}.`
        : `Llegó con ${LATE} min o más de retraso ${r.recent.late} de los últimos ${ranDays} días en que circuló.`);
    }
    if (r.recent?.cancelled) parts.push(`Cancelado ${r.recent.cancelled === 1 ? '1 día' : `${r.recent.cancelled} días`}.`);
    if (!parts.length) parts.push('Aún no ha acabado ningún recorrido suyo.');
    summary = parts.join(' ') + sinceText(r, today);
    strip = serviceStrip(r.days);
  } else {
    const t = r.days.at(-1);
    const noun = nounPlural(r.mode);
    const parts = [];
    if (t.samples) parts.push(`Hoy, el ${pct(t.lateShare)} de las lecturas con ${LATE} min o más de retraso (${t.vehicles} ${noun} con dato).`);
    if (t.cancelled) parts.push(`${t.cancelled === 1 ? '1 cancelación' : `${t.cancelled} cancelaciones`} hoy.`);
    if (r.summary?.samples) parts.push(`Días anteriores: el ${pct(r.summary.lateShare)}.`);
    if (!parts.length) parts.push('Aún sin lecturas de retraso.');
    summary = `Su línea. ${parts.join(' ')}${sinceText(r, today)}`;
    strip = lineStrip(r.days, noun);
  }
  return `<section class="pblock"><div class="ptitle">Puntualidad</div><p class="psum">${esc(summary)}</p>${strip}${r.note ? `<div class="pnote">${esc(r.note)}</div>` : ''}</section>`;
}

/** Cuando no hay informe: si su operador no publica el retraso, se dice; si no, nada. */
export const noDelayHtml = () => '<section class="pblock"><div class="ptitle">Puntualidad</div><p class="psum">Su operador no publica el retraso: el radar no puede saber su puntualidad.</p></section>';

// ---------- Lo que se pide al servidor ----------

const cache = new Map(); // clave → { at, report }
const loading = new Set();
let nouns = null; // id del tipo → nombre de varios (de /api/modes)
const nounOf = (mode) => nouns?.get(mode) ?? 'vehículos';

function fill(id) {
  const html = slotContent(id);
  for (const el of document.querySelectorAll(`.punct[data-punct="${CSS.escape(id)}"]`)) el.innerHTML = html;
}

async function load(key, id) {
  if (loading.has(key)) return;
  loading.add(key);
  try {
    if (!nouns) {
      nouns = new Map();
      fetch('/api/modes').then((r) => (r.ok ? r.json() : [])).then((list) => {
        for (const m of Array.isArray(list) ? list : []) nouns.set(m.id, m.nounPlural);
      }).catch(() => {});
    }
    const r = await fetch(`/api/puntualidad/${encodeURIComponent(key)}`);
    cache.set(key, { at: Date.now(), report: r.ok ? await r.json() : null });
  } catch {
    cache.set(key, { at: Date.now(), report: null });
  } finally {
    loading.delete(key);
  }
  // Un servicio sin datos: la de su línea.
  const [service, line] = id.split('|');
  if (key === service && line && !hasData(cache.get(key).report) && !fresh(line)) load(line, id);
  else fill(id);
}

const fresh = (key) => {
  const c = cache.get(key);
  return c && Date.now() - c.at < FRESH_MS;
};
const hasData = (r) => Boolean(r && (r.kind === 'linea'
  ? r.days.some((d) => d.samples || d.cancelled)
  : r.now || r.summary?.ran || r.summary?.cancelled || r.days.some((d) => d.status !== 'sin-dato')));

/** El id de un hueco: «servicio|línea|n» (n: su operador no publica el retraso). */
function slotContent(id) {
  const [service, line, noDelay] = id.split('|');
  const own = service ? cache.get(service)?.report : null;
  if (hasData(own)) return punctualityHtml(own, { nounPlural: nounOf });
  const ofLine = line ? cache.get(line)?.report : null;
  if (hasData(ofLine)) return punctualityHtml(ofLine, { nounPlural: nounOf });
  return noDelay === 'n' && (!line || cache.has(line)) && (!service || cache.has(service) || !line) ? noDelayHtml() : '';
}

/**
 * Hueco de la puntualidad para una ficha: lo que ya se sabe y, si hace falta, lo pide (la de su servicio y la
 * de su línea, por si el servicio no tiene). `delayKnown` false: su operador no publica el retraso.
 * @param {string[]|undefined} follow  @param {{ delayKnown?: boolean|null }} [opts]
 */
export function punctualitySlot(follow, { delayKnown = null } = {}) {
  const { service, line } = punctualityKeys(follow);
  if (!service && !line) return '';
  const id = `${service ?? ''}|${line ?? ''}|${delayKnown === false ? 'n' : ''}`;
  // Primero la del servicio; la de la línea, sólo si no tiene servicio o el servicio no tiene datos.
  const first = service && !fresh(service) ? service
    : (!service || !hasData(cache.get(service)?.report)) && line && !fresh(line) ? line : null;
  if (first) queueMicrotask(() => load(first, id));
  return `<div class="punct" data-punct="${esc(id)}">${slotContent(id)}</div>`;
}
