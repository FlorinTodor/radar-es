// Puntualidad histórica en la ficha de un vehículo, de una cancelación o de un tren sin datos
// (/api/puntualidad/<clave>): la de su servicio o, si no la hay, la de su línea, con una tira de los últimos
// días. Vale para cualquier tipo de vehículo: sólo usa sus claves `follow` (ver docs/vehiculos.md) y los
// nombres del registro de tipos (/api/modes).
//
// La ficha se repinta entera cada pocos segundos: punctualitySlot pone lo que ya se sabe (o nada) y, si hace
// falta, lo pide; cuando llega, rellena el hueco que esté en la página. Así no hay parpadeo ni peticiones de más.
import { esc } from './format.js';
import { locale, t, tn, tx } from './i18n.js';

const STRIP_DAYS = 14;
const FRESH_MS = 60_000; // lo de hoy cambia cada minuto (como la caché de la ruta)
const LATE = 5;

const DAY_FMT = new Intl.DateTimeFormat(locale(), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayLabel = (iso) => DAY_FMT.format(Date.parse(`${iso}T12:00:00Z`)).replace(/\./g, '');
const PCT = new Intl.NumberFormat(locale(), { style: 'percent' }); // en español con espacio duro: que el % no salte de línea
const pct = (share) => PCT.format(Math.round(share * 100) / 100);

// Cada estado de un día: su signo (para no depender del color) y cómo se dice.
const STATUS = {
  'a-tiempo': { mark: '✓', label: t('a tiempo') },
  tarde: { mark: '+', label: t('{n} min o más de retraso', { n: LATE }) },
  cancelado: { mark: '×', label: t('cancelado') },
  parcial: { mark: '–', label: t('con paradas suprimidas') },
  'en-curso': { mark: '…', label: t('en curso') },
  'sin-dato': { mark: '', label: t('sin dato') },
};

/** Las claves que importan de una lista `follow`: la del servicio y la de la línea. */
export function punctualityKeys(follow) {
  const list = Array.isArray(follow) ? follow : [];
  return { service: list.find((k) => typeof k === 'string' && k.startsWith('s-')) ?? null, line: list.find((k) => typeof k === 'string' && k.startsWith('l-')) ?? null };
}

const minutes = (n) => `${n} min`;
const delayText = (d) => (d === null || d === undefined ? '' : d <= 0 ? t('en hora') : `+${minutes(d)}`);

/** Lo que dice un día de un servicio, para su descripción y la lista accesible. */
function serviceDayText(d) {
  const what = STATUS[d.status]?.label ?? d.status;
  const when = d.status === 'en-curso' ? t('ahora {delay}', { delay: delayText(d.delay) }) : t('al llegar {delay}', { delay: delayText(d.delay) });
  const delay = d.delay !== undefined && d.status !== 'cancelado' ? ` (${when}${d.max > d.delay ? `; ${t('máx. +{n} min', { n: d.max })}` : ''})` : '';
  return `${dayLabel(d.day)}: ${what}${delay}${d.partial && d.status !== 'parcial' ? `, ${t('con paradas suprimidas')}` : ''}`;
}

function serviceStrip(days) {
  const shown = days.slice(-STRIP_DAYS);
  const cells = shown.map((d) => `<li class="pd pd-${esc(d.status)}" title="${esc(serviceDayText(d))}"><span aria-hidden="true">${STATUS[d.status]?.mark ?? ''}</span></li>`).join('');
  const label = t('Últimos {n} días, del más antiguo al de hoy: {list}', { n: shown.length, list: shown.map(serviceDayText).join('; ') });
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
  const cancelled = (d) => tn('{n} cancelación', '{n} cancelaciones', d.cancelled);
  const text = (d) => (d.samples
    ? `${dayLabel(d.day)}: ${t('{pct} de las lecturas con {late} min o más ({n} {noun})', { pct: pct(d.lateShare), late: LATE, n: d.vehicles, noun })}${d.cancelled ? `, ${cancelled(d)}` : ''}`
    : `${dayLabel(d.day)}: ${d.cancelled ? `${t('sin lecturas de retraso')}, ${cancelled(d)}` : t('sin dato')}`);
  const cells = shown.map((d) => {
    const h = d.samples ? Math.max(4, Math.round((d.lateShare / top) * 100)) : 0;
    return `<li class="pb${d.samples ? '' : ' pb-none'}" title="${esc(text(d))}"><span style="height:${h}%"></span></li>`;
  }).join('');
  const label = t('Últimos {n} días, del más antiguo al de hoy: {list}', { n: shown.length, list: shown.map(text).join('; ') });
  return `<div class="pbars-wrap"><ol class="pbars" role="img" aria-label="${esc(label)}">${cells}</ol><span class="ptop" aria-hidden="true">${pct(top)}</span></div>
    <div class="plegend" aria-hidden="true"><span>${t('Altura: parte de las lecturas del día con {late} min o más de retraso (arriba, el {top})', { late: LATE, top: pct(top) })}</span></div>`;
}

/** «desde el 10 nov», si el radar lo sigue desde hace poco (menos de los días de la tira). */
function sinceText(r, today) {
  const first = r.firstSeen ?? r.since;
  if (!first || !today) return '';
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000);
  if (days >= STRIP_DAYS) return '';
  return ` ${days <= 0 ? t('El radar lo sigue desde hoy.') : t('El radar lo sigue desde el {day}.', { day: dayLabel(first) })}`;
}

/**
 * HTML de la puntualidad de un servicio o de una línea (lo que da /api/puntualidad/<clave>).
 * @param {object} r  informe
 * @param {{ nounPlural?: (mode: string) => string }} [opts]  nombre de varios vehículos de un tipo (de /api/modes)
 */
export function punctualityHtml(r, { nounPlural = () => 'vehículos' } = {}) {
  // Los nombres de los vehículos llegan del registro de tipos del servidor, en español.
  if (!r?.days?.length) return '';
  const today = r.days.at(-1).day;
  let summary;
  let strip;
  if (r.kind === 'servicio') {
    const ranDays = (r.recent?.days ?? 0) - (r.recent?.cancelled ?? 0);
    const parts = [];
    if (r.now) parts.push(r.now.delay > 0 ? t('Hoy va con +{n} min.', { n: r.now.delay }) : t('Hoy va en hora.'));
    if (ranDays > 0) {
      parts.push(ranDays === 1
        ? (r.recent.late ? t('El último día en que circuló llegó con {late} min o más de retraso.', { late: LATE }) : t('El último día en que circuló llegó a tiempo.'))
        : t('Llegó con {late} min o más de retraso {n} de los últimos {days} días en que circuló.', { late: LATE, n: r.recent.late, days: ranDays }));
    }
    if (r.recent?.cancelled) parts.push(tn('Cancelado {n} día.', 'Cancelado {n} días.', r.recent.cancelled));
    if (!parts.length) parts.push(t('Aún no ha acabado ningún recorrido suyo.'));
    summary = parts.join(' ') + sinceText(r, today);
    strip = serviceStrip(r.days);
  } else {
    const last = r.days.at(-1);
    const noun = t(nounPlural(r.mode));
    const parts = [];
    if (last.samples) parts.push(t('Hoy, el {pct} de las lecturas con {late} min o más de retraso ({n} {noun} con dato).', { pct: pct(last.lateShare), late: LATE, n: last.vehicles, noun }));
    if (last.cancelled) parts.push(tn('{n} cancelación hoy.', '{n} cancelaciones hoy.', last.cancelled));
    if (r.summary?.samples) parts.push(t('Días anteriores: el {pct}.', { pct: pct(r.summary.lateShare) }));
    if (!parts.length) parts.push(t('Aún sin lecturas de retraso.'));
    summary = `${t('Su línea.')} ${parts.join(' ')}${sinceText(r, today)}`;
    strip = lineStrip(r.days, noun);
  }
  return `<section class="pblock"><div class="ptitle">${t('Puntualidad')}</div><p class="psum">${esc(summary)}</p>${strip}${r.note ? `<div class="pnote">${esc(tx(r.note))}</div>` : ''}</section>`;
}

/** Cuando no hay informe: si su operador no publica el retraso, se dice; si no, nada. */
export const noDelayHtml = () => `<section class="pblock"><div class="ptitle">${t('Puntualidad')}</div><p class="psum">${t('Su operador no publica el retraso: el radar no puede saber su puntualidad.')}</p></section>`;

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
