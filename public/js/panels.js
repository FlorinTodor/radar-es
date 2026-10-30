// Render de los paneles laterales y la barra de KPIs. Funciones puras de estado → HTML;
// los clics se gestionan por delegación en app.js mediante data-id / data-kind.
import {
  DELAY_CLASSES, MODE_LABEL, SEVERITY_LABEL, SEVERITY_RANK, esc, fmtDateTime, fmtDelay, fmtNum, fmtTime, sevClass, timeAgo, vehicleTitle,
} from './format.js';
import { pictoFor, vehicleIconUrl } from './icons.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 250;

export function renderKpis(kpis, metrics, alertCount) {
  $('k-vehicles').textContent = fmtNum(kpis?.vehicles);
  $('k-delayed').textContent = fmtNum(kpis?.delayed);
  $('k-delayed-sub').textContent = kpis?.withDelayInfo ? `${Math.round((kpis.delayed / kpis.withDelayInfo) * 100)} % de los que informan retraso` : '';
  $('k-median').textContent = kpis?.medianDelay === null || kpis?.medianDelay === undefined ? '–' : `${fmtNum(Math.round(kpis.medianDelay))} min`;
  $('k-alerts').textContent = fmtNum(alertCount);
  const ree = metrics?.ree;
  $('k-grid').textContent = ree?.demandMW ? `${fmtNum(ree.demandMW)} MW` : '–';
  $('k-grid-sub').textContent = ree?.deviation !== null && ree?.deviation !== undefined
    ? `${ree.deviation >= 0 ? '+' : '−'}${Math.abs(ree.deviation * 100).toFixed(1).replace('.', ',')} % frente a lo previsto`
    : '';
}

function severityPill(sev) {
  return `<span class="pill ${sevClass(sev)}">${esc(SEVERITY_LABEL[sev] ?? sev)}</span>`;
}

/**
 * Barra de selección común a Alertas, Incidencias y Trenes.
 * @param {{ ids: Set<string>, total: number, multi: boolean }} sel  total = elementos marcados en todas las listas
 */
function selectionBar(sel, what) {
  return `
    <div class="alerts-toolbar">
      <label class="switch"><input type="checkbox" data-action="multi" ${sel.multi ? 'checked' : ''}><span class="track"></span>Varias a la vez</label>
      ${sel.total ? '<button type="button" class="btn-ghost" data-action="clear-focus">Ver todo</button>' : ''}
    </div>
    <div class="hint">${sel.total
      ? `El mapa muestra sólo lo marcado (${sel.total}). ${sel.multi ? 'Pulsa más elementos para sumarlos o uno marcado para quitarlo.' : ''}`
      : sel.multi ? `Pulsa ${what.plural} para verlos juntos en el mapa; vuelve a pulsar para quitar.`
        : `Pulsa ${what.one} para ver en el mapa sólo eso.`}</div>`;
}

const NO_SELECTION = { ids: new Set(), total: 0, multi: false };
const check = (on) => (on ? '<span class="check" aria-hidden="true">✓</span>' : '');

export function renderAlerts(el, alerts, resolved, sel = NO_SELECTION) {
  const now = Date.now();
  const toolbar = alerts.length ? selectionBar(sel, { one: 'una alerta', plural: 'las alertas' }) : '';
  const active = alerts.length
    ? alerts.map((a) => {
      const on = sel.ids.has(a.id);
      return `
      <button class="item alert-item ${sevClass(a.severity)}${on ? ' selected' : ''}" data-kind="alert" data-id="${esc(a.id)}" aria-pressed="${on}">
        <div class="row">${severityPill(a.severity)}${check(on)}</div>
        <div class="title">${esc(a.title)}</div>
        ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
        <div class="meta"><span>Desde las ${fmtTime(a.since)} (${timeAgo(a.since, now)})</span></div>
      </button>`;
    }).join('')
    : `<div class="empty">Sin alertas activas.<br>El motor revisa trenes detenidos en plena vía, saltos de retraso, terremotos,
       focos de incendio cerca de trenes, avisos meteorológicos naranja o rojo, la red eléctrica y la salud de las fuentes.</div>`;
  const done = resolved.slice(0, 15).map((a) => `
      <div class="item resolved ${sevClass(a.severity)}">
        <div class="title">${esc(a.title)}</div>
        <div class="meta"><span>${fmtTime(a.since)} – ${fmtTime(a.resolvedAt)}</span></div>
      </div>`).join('');
  el.innerHTML = `<div class="section-title">Activas</div>${toolbar}${active}${done ? `<div class="section-title">Resueltas recientemente</div>${done}` : ''}`;
}

export const EVENT_CATEGORIES = [
  ['ferroviario', 'Ferroviario'],
  ['carretera', 'Carretera'],
  ['meteo', 'Meteorología'],
  ['incendio', 'Incendios'],
  ['sismo', 'Terremotos'],
  ['catastrofe', 'Catástrofes'],
];

export function renderEventFilters(el, prefs) {
  el.innerHTML = EVENT_CATEGORIES.map(([id, label]) =>
    `<button class="chip" data-cat="${id}" aria-pressed="${prefs.eventCats.includes(id)}">${label}</button>`).join('') +
    `<button class="chip" data-cat="obras" aria-pressed="${prefs.obras}">Incluir obras</button>`;
}

export function filterEvents(events, prefs) {
  return events
    .filter((e) => prefs.eventCats.includes(e.category) && (prefs.obras || e.type !== 'roadMaintenance'))
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (b.start ?? 0) - (a.start ?? 0));
}

export function renderEvents(el, events, sel = NO_SELECTION) {
  if (!events.length) {
    el.innerHTML = '<div class="empty">No hay incidencias con estos filtros.</div>';
    return;
  }
  const rows = events.slice(0, MAX_ROWS).map((e) => {
    const on = sel.ids.has(e.id);
    return `
    <button class="item alert-item ${sevClass(e.severity)}${on ? ' selected' : ''}" data-kind="event" data-id="${esc(e.id)}" aria-pressed="${on}">
      <div class="row">${severityPill(e.severity)}${check(on)}</div>
      <div class="title">${esc(e.title)}</div>
      ${e.description && e.category !== 'sismo' ? `<div class="desc">${esc(e.description.length > 220 ? `${e.description.slice(0, 220)}…` : e.description)}</div>` : ''}
      <div class="meta">
        ${e.start ? `<span>${fmtDateTime(e.start)}</span>` : ''}
        ${e.end ? `<span>hasta ${fmtDateTime(e.end)}</span>` : ''}
        ${e.lat === null || e.lat === undefined ? '<span>sin ubicación</span>' : ''}
      </div>
    </button>`;
  }).join('');
  const more = events.length > MAX_ROWS ? `<div class="empty">Mostrando ${MAX_ROWS} de ${fmtNum(events.length)}.</div>` : '';
  el.innerHTML = selectionBar(sel, { one: 'una incidencia', plural: 'las incidencias' }) + rows + more;
}

export function filterVehicles(vehicles, query) {
  const q = query.trim().toLowerCase();
  const list = q
    ? vehicles.filter((v) => [v.label, v.line, v.service, v.origin, v.destination, v.next, v.current, v.area]
      .some((f) => f && String(f).toLowerCase().includes(q)))
    : vehicles;
  return [...list].sort((a, b) => (b.delay ?? (b.late ? 1 : -1)) - (a.delay ?? (a.late ? 1 : -1)));
}

export function renderVehicles(el, vehicles, total, sel = NO_SELECTION) {
  if (!vehicles.length) {
    el.innerHTML = `<div class="empty">${total ? 'Ningún tren coincide con la búsqueda.' : 'Esperando datos…'}</div>`;
    return;
  }
  const rows = vehicles.slice(0, MAX_ROWS).map((v) => {
    const on = sel.ids.has(v.id);
    return `
    <button class="item vrow${on ? ' selected' : ''}" data-kind="vehicle" data-id="${esc(v.id)}" aria-pressed="${on}" style="border-left-color:${DELAY_CLASSES[v.cls][0]}">
      <img class="plate" src="${vehicleIconUrl(pictoFor(v.mode), v.estimated && !v.cls ? '#c3c2b7' : DELAY_CLASSES[v.cls][0], !!v.estimated)}" alt="">
      <span class="title">${check(on)} ${esc(vehicleTitle(v))}</span>
      <span class="delay">${v.estimated && (v.delay === null || v.delay === undefined) ? 'Estimado' : esc(fmtDelay(v))}</span>
      <span class="sub">${esc(MODE_LABEL[v.mode] ?? v.mode)} · ${esc(v.origin ?? '?')} → ${esc(v.destination ?? '?')}</span>
    </button>`;
  }).join('');
  const more = vehicles.length > MAX_ROWS ? `<div class="empty">Mostrando ${MAX_ROWS} de ${fmtNum(vehicles.length)}. Usa el buscador para afinar.</div>` : '';
  el.innerHTML = `${selectionBar(sel, { one: 'un tren', plural: 'los trenes' })}<div class="section-title">${fmtNum(vehicles.length)} trenes · ordenados por retraso</div>${rows}${more}`;
}

export function renderSources(el, health) {
  const now = Date.now();
  el.innerHTML = health.map((s) => {
    const [cls, label] = !s.enabled ? ['off', 'Desactivada'] : s.ok === null ? ['wait', 'Pendiente'] : s.ok ? ['ok', 'Operativa'] : ['ko', 'Con errores'];
    return `
    <div class="src">
      <div class="row"><span class="name">${esc(s.name)}</span></div>
      <div class="stat">
        <span class="status ${cls}">${label}</span>
        ${s.count !== null && s.count !== undefined ? `<span>${fmtNum(s.count)} elementos</span>` : ''}
        ${s.lastOk ? `<span>leída ${timeAgo(s.lastOk, now)}</span>` : ''}
        ${s.sourceTime ? `<span>dato de ${fmtTime(s.sourceTime)}</span>` : ''}
        ${s.ms ? `<span>${fmtNum(s.ms)} ms</span>` : ''}
        <span>cada ${Math.round(s.interval / 1000)} s</span>
      </div>
      ${s.reason ? `<div class="err">${esc(s.reason)}</div>` : ''}
      ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}
      ${s.license ? `<div class="stat"><span>${esc(s.license)}</span></div>` : ''}
      ${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}
    </div>`;
  }).join('');
}

export const MODE_ITEMS = ['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'bus', 'otros'];
// Modos ocultos hasta que el usuario los active (los autobuses taparían los trenes).
export const MODES_OFF_BY_DEFAULT = ['bus'];
export const modeOn = (prefs, m) => prefs.modes[m] ?? !MODES_OFF_BY_DEFAULT.includes(m);
export const GROUPS_OFF_BY_DEFAULT = ['effis', 'trails'];
export const groupOn = (prefs, g) => prefs.groups[g] ?? !GROUPS_OFF_BY_DEFAULT.includes(g);
export const GROUP_ITEMS = [
  ['rail', 'Red ferroviaria'],
  ['lines', 'Líneas de metro, tranvía y Cercanías'],
  ['trails', 'Estelas de todos los trenes (15 min)'],
  ['stations', 'Estaciones Renfe (al acercar)'],
  ['renfe-avisos', 'Avisos ferroviarios (Renfe, Rodalies)'],
  ['meteo', 'Avisos meteorológicos (AEMET)'],
  ['incendios', 'Focos de calor (satélite)'],
  ['effis', 'Áreas quemadas, 30 días (EFFIS)'],
  ['dgt', 'Incidencias de tráfico (leves, al acercar)'],
  ['obras', 'Obras en carretera'],
  ['sismos', 'Terremotos'],
  ['gdacs', 'Alertas de catástrofes (GDACS)'],
];

export function renderLayers(el, prefs, countsByMode) {
  const modes = MODE_ITEMS.map((m) => `
    <label><input type="checkbox" data-mode="${m}" ${modeOn(prefs, m) ? 'checked' : ''}>
      ${esc(MODE_LABEL[m])}<span class="count" data-count="${m}">${fmtNum(countsByMode[m] ?? 0)}</span></label>`).join('');
  const groups = GROUP_ITEMS.map(([g, label]) => `
    <label><input type="checkbox" data-group="${g}" ${(g === 'obras' ? prefs.obras : groupOn(prefs, g)) ? 'checked' : ''}> ${esc(label)}</label>`).join('');
  const plate = (picto, color, estimated) => `<img class="plate" src="${vehicleIconUrl(picto, color, estimated)}" alt="">`;
  const legend = DELAY_CLASSES.slice(1).concat([DELAY_CLASSES[0]]).map(([color, label]) => `${plate('tren', color)}<span>${esc(label)}</span>`).join('');
  const types = [['av', 'Alta velocidad'], ['tren', 'Larga y media distancia, Cercanías'], ['metro', 'Metro'], ['tranvia', 'Tranvía'], ['bus', 'Autobús']]
    .map(([picto, label]) => `${plate(picto, '#8b8b85')}<span>${label}</span>`).join('');
  const shape = (path, fill, stroke) => `<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/></svg>`;
  el.innerHTML = `<h4>Trenes</h4>${modes}<h4>Contexto</h4>${groups}<h4>Tipo de vehículo</h4><div class="legend">${types}</div>
    <h4>Retraso (color de la placa)</h4><div class="legend">${legend}
    ${plate('tren', '#fab219', true)}<span>Posición estimada por horario (no GPS): placa hueca; el color indica el retraso si se conoce</span>
    <i style="background:transparent;border:2px solid #d03b3b"></i><span>Tren con alerta activa</span>
    <i style="background:transparent;border:2.5px solid #6ea8fe"></i><span>Tren seleccionado</span>
    <i style="height:0;border-radius:0;border-top:2.5px dashed #6ea8fe"></i><span>Su recorrido en los últimos 45 min</span>
    <i style="height:0;border-radius:0;border-top:1.5px solid #9db4d8"></i><span>Estela de cada tren (capa opcional, 15 min)</span></div>
    <h4>Incidencias</h4><div class="legend">
    ${shape('M7 1.2L12.8 7L7 12.8L1.2 7Z', '#fab219', '#0d0d0d')}<span>Tráfico (color = gravedad)</span>
    ${shape('M2.2 2.2H11.8V11.8H2.2Z', '#fab219', '#0d0d0d')}<span>Obras en carretera (color = gravedad)</span>
    ${shape('M7 1.5L12.8 12.3L1.2 12.3Z', '#ec835a', '#f0efec')}<span>Aviso Renfe en estación</span>
    <i style="border-radius:2px;background:rgba(236,131,90,.25);border:1.2px solid #ec835a"></i><span>Aviso meteorológico (amarillo, naranja o rojo)</span>
    <i style="background:radial-gradient(circle,#ffd27a 25%,#ff5a1f 60%,transparent 75%)"></i><span>Foco de calor por satélite</span>
    <i style="background:rgba(180,140,255,.25);border:1.5px solid #b48cff"></i><span>Terremoto (tamaño = magnitud)</span>
    <i style="background:transparent;border:2.5px solid #ec835a"></i><span>Alerta GDACS (naranja o roja)</span>
    <i style="border-radius:2px;background:linear-gradient(90deg,#e8261c 33%,#f39c12 33% 66%,#1f6fd1 66%)"></i><span>Área quemada (EFFIS): rojo, último día; naranja, 7 días; azul, 30 días</span></div>`;
}

export function updateModeCounts(el, countsByMode) {
  for (const m of MODE_ITEMS) {
    const c = el.querySelector(`[data-count="${m}"]`);
    if (c) c.textContent = fmtNum(countsByMode[m] ?? 0);
  }
}
