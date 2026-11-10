// El día en cifras: pide el resumen del día (/api/dia o /api/dia/AAAA-MM-DD) y lo dibuja. El de hoy se
// vuelve a pedir cada minuto; uno pasado se pide una vez (mientras el servidor lo lee del disco, responde
// 503 y se vuelve a pedir enseguida). Los nombres de los tipos de vehículo vienen del servidor (su
// registro de tipos), así que un tipo nuevo sale aquí sin tocar nada.
import { creditHtml, esc, fmtTime } from './format.js';
import {
  columnChart, dayShort, dayTitle, fmt, hbars, hourAt, hourLabel, lineChart, medianPhrase,
} from './dia-graficas.js';

const el = document.getElementById('dia');
const prev = document.getElementById('dia-prev');
const next = document.getElementById('dia-next');
const select = document.getElementById('dia-select');
const todayLink = document.getElementById('dia-today');
const REFRESH_MS = 60_000;
const RETRY_MS = 2000;
const SEVERITY = { 'muy alta': 'Muy alta', alta: 'Alta', media: 'Media', baja: 'Baja' };

let data = null;
let timer = null;
let asked = null; // el día que se ha pedido (null: hoy)

const dayParam = () => {
  const d = new URLSearchParams(location.search).get('dia');
  return /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? d : null;
};

async function load(day, { quiet = false } = {}) {
  clearTimeout(timer);
  asked = day;
  if (!quiet) el.setAttribute('aria-busy', 'true');
  try {
    const res = await fetch(day ? `/api/dia/${day}` : '/api/dia');
    if (asked !== day) return; // mientras tanto se ha pedido otro día
    if (res.status === 503) {
      timer = setTimeout(() => load(day, { quiet }), RETRY_MS);
      return;
    }
    if (res.status === 404 || res.status === 400) {
      data = null;
      el.innerHTML = `<p class="muted">No hay datos de ${day ? esc(dayTitle(day)) : 'hoy todavía'}. El radar guarda los últimos 90 días.</p>`;
      el.setAttribute('aria-busy', 'false');
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    render();
  } catch {
    if (!data) el.innerHTML = '<p class="muted">No se ha podido cargar el día. Se volverá a intentar en un momento.</p>';
    timer = setTimeout(() => load(day, { quiet: true }), REFRESH_MS);
    return;
  } finally {
    if (asked === day) el.setAttribute('aria-busy', 'false');
  }
  if (!day || data?.today) timer = setTimeout(() => load(day, { quiet: true }), REFRESH_MS);
}

function go(day) {
  const url = new URL(location.href);
  if (day && day !== data?.days?.[0]) url.searchParams.set('dia', day);
  else url.searchParams.delete('dia');
  history.pushState(null, '', url);
  load(dayParam());
}

prev.addEventListener('click', () => data?.prev && go(data.prev));
next.addEventListener('click', () => data?.next && go(data.next));
select.addEventListener('change', () => go(select.value));
addEventListener('popstate', () => load(dayParam()));

function renderNav() {
  prev.disabled = !data.prev;
  next.disabled = !data.next;
  select.disabled = !data.days.length;
  select.innerHTML = data.days.map((d, i) => `<option value="${esc(d)}"${d === data.date ? ' selected' : ''}>${esc(dayShort(d))}${i === 0 ? ' (hoy)' : ''}</option>`).join('');
  todayLink.hidden = data.today;
}

// ---------- Cifras ----------

const tile = (label, value, sub = '', hero = false) => `<div class="tile${hero ? ' hero' : ''}">
  <div class="t-label">${esc(label)}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ''}</div>`;

// Lo que no se sabe (un día sin registro, el histórico aún sin leer) sale como «sin dato», nunca como 0.
const UNKNOWN = '<span class="t-unknown">sin dato</span>';
const NOT_SAVED = 'de este día no se guardó';

function tiles(d) {
  const c = d.cancellations;
  const peak = d.vehicles.peak;
  const em = d.emergencies;
  const railOnly = !d.coverage.hoursAllModes;
  const late = d.delay.lateShare;
  const median = medianPhrase(d.delay.median);
  return `<div class="dia-tiles">
    ${tile('Cancelaciones', c ? fmt(c.total) : UNKNOWN, c ? (c.total ? `${fmt(c.whole)} sin circular y ${fmt(c.partial)} con paradas suprimidas, de ${fmt(c.operators)} ${c.operators === 1 ? 'operador' : 'operadores'}` : 'Ningún viaje cancelado') : NOT_SAVED, true)}
    ${tile('Máximo a la vez', peak ? fmt(peak.total) : UNKNOWN, peak ? `${railOnly ? 'trenes, metros y tranvías' : 'vehículos'} vistos en tiempo real a las ${esc(fmtTime(peak.t))}` : '')}
    ${tile('Con 5 min o más de retraso', late !== null ? `${fmt(late)} %` : UNKNOWN, late !== null ? `de los que publican su retraso${median ? `; ${esc(median)}` : ''}` : 'ningún operador publicó su retraso')}
    ${tile('Trenes sin datos', d.missing ? fmt(d.missing.total) : UNKNOWN, d.missing ? 'en algún momento del día' : NOT_SAVED)}
    ${tile('Alertas del radar', d.alerts ? fmt(d.alerts.total) : UNKNOWN, d.alerts ? (d.alerts.bySeverity.alta || d.alerts.bySeverity['muy alta'] ? `${fmt((d.alerts.bySeverity.alta ?? 0) + (d.alerts.bySeverity['muy alta'] ?? 0))} de gravedad alta` : '') : 'aún no se ha leído')}
    ${tile('Avisos de emergencia', em ? fmt(em.meteo.total + em.sismos.total + em.oficiales.total + em.gdacs.total) : UNKNOWN, em ? [em.meteo.total && `${fmt(em.meteo.total)} de AEMET`, em.sismos.total && `${fmt(em.sismos.total)} terremotos`, em.oficiales.total && `${fmt(em.oficiales.total)} oficiales`].filter(Boolean).join(' · ') : NOT_SAVED)}
  </div>`;
}

const chartCard = (id, title, sub = '') => `<div class="chart-card" id="${id}"><h3>${esc(title)}</h3>${sub ? `<p class="c-sub">${sub}</p>` : ''}<div class="plot"></div><div class="tip" hidden></div></div>`;

function vehiclesSection(d) {
  const modes = d.vehicles.modes.filter((m) => m.hourly.some((v) => v > 0) || m.compare?.some((v) => v > 0));
  if (!modes.length) return '';
  const compare = d.vehicles.compareDate;
  return `<h2>Vehículos vistos en tiempo real, por horas</h2>
    <p class="muted">Media de cada hora. ${compare ? `En gris, el ${esc(dayTitle(compare))}, el mismo día de la semana anterior.` : ''}</p>
    ${compare ? `<div class="legend"><span><i class="k-today"></i>${d.today ? 'Hoy' : esc(dayShort(d.date))}</span><span><i class="k-compare"></i>${esc(dayShort(compare))}</span></div>` : ''}
    <div class="dia-grid">${modes.map((m) => chartCard(`v-${m.id}`, m.label, `Máximo a la vez: ${fmt(m.max)} ${esc(m.max === 1 ? m.noun : m.nounPlural)}`)).join('')}</div>`;
}

function delaySection(d) {
  if (!d.delay.hourly.some(Number.isFinite)) return '';
  const rows = d.vehicles.modes.filter((m) => m.delay);
  return `<h2>Retraso</h2>
    <div class="dia-grid one">${chartCard('delay', 'Con 5 min o más de retraso, por horas', 'Porcentaje de los vehículos que publican su retraso')}</div>
    ${rows.length ? `<ul class="dia-list">${rows.map((m) => `<li><strong>${esc(m.label)}</strong>: ${fmt(m.delay.lateShare)} % con 5 min o más${medianPhrase(m.delay.median) ? `; ${esc(medianPhrase(m.delay.median))}` : ''}</li>`).join('')}</ul>` : ''}`;
}

const origins = (g) => (g.origins?.length ? `sobre todo desde ${g.origins.join(' y ')}` : '');

function cancellationsSection(d) {
  const c = d.cancellations;
  if (!c) return `<h2>Cancelaciones</h2><p class="muted">Sin dato: ${NOT_SAVED} (el radar empezó a guardar las cancelaciones de cada día más tarde).</p>`;
  if (!c.total) return '<h2>Cancelaciones</h2><p class="muted">Ningún operador ha dado viajes por cancelados en su tiempo real.</p>';
  return `<h2>Cancelaciones</h2>
    <p class="muted">${fmt(c.total)} viajes cancelados o con paradas suprimidas${c.byMode.length ? `: ${c.byMode.map((m) => `${fmt(m.n)} de ${esc(m.label.toLowerCase())}`).join(', ')}` : ''}.</p>
    <div class="dia-cols">
      <div><h3>Dónde más cancelaciones</h3>${hbars(c.byLine.map((g) => ({ label: g.name, value: g.n, sub: origins(g) })))}</div>
      <div><h3>Por operador</h3>${hbars(c.byOperator.map((o) => ({ label: o.name, value: o.n })))}</div>
    </div>`;
}

function missingSection(d) {
  const m = d.missing;
  if (!m?.total) return '';
  return `<h2>Trenes sin datos</h2>
    <p class="muted">${fmt(m.total)} ${m.total === 1 ? 'tren debía' : 'trenes debían'} circular según su horario y su operador no publicaba nada de ${m.total === 1 ? 'él' : 'ellos'} en algún momento. No es una cancelación: no se sabe si circularon.</p>
    <div class="dia-cols"><div><h3>Dónde más trenes sin datos</h3>${hbars(m.byLine.map((g) => ({ label: g.name, value: g.n })))}</div></div>`;
}

function alertsSection(d) {
  const a = d.alerts;
  if (!a?.total) return '';
  return `<h2>Alertas del radar</h2>
    <p class="muted">${fmt(a.total)} alertas (trenes detenidos, saltos de retraso, fuentes caídas, avisos…). Las de más gravedad:</p>
    <ul class="dia-list">${a.top.map((x) => `<li><span class="pill-sev">${esc(SEVERITY[x.severity] ?? x.severity ?? '')}</span> ${esc(x.title)}${x.since ? ` <span class="muted">· ${esc(fmtTime(x.since))}</span>` : ''}</li>`).join('')}</ul>`;
}

function emergenciesSection(d) {
  const e = d.emergencies;
  if (!e) return `<h2>Avisos de emergencia</h2><p class="muted">Sin dato: ${NOT_SAVED}.</p>`;
  if (!(e.meteo.total + e.sismos.total + e.oficiales.total + e.gdacs.total)) return '';
  const item = (x) => `<li>${x.level ? `<span class="pill-sev">${esc(x.level)}</span> ` : ''}${esc(x.title ?? '')}${x.area && !(x.title ?? '').includes(x.area) ? ` <span class="muted">· ${esc(x.area)}</span>` : ''}</li>`;
  const block = (title, sub, list) => (list.length ? `<div><h3>${esc(title)}</h3><p class="muted">${sub}</p><ul class="dia-list">${list.map(item).join('')}</ul></div>` : '');
  return `<h2>Avisos de emergencia</h2><div class="dia-cols">
    ${block('Meteorología (AEMET)', `${fmt(e.meteo.total)} avisos naranja o rojo: ${fmt(e.meteo.rojo)} rojos y ${fmt(e.meteo.naranja)} naranjas`, e.meteo.top)}
    ${block('Terremotos', `${fmt(e.sismos.total)} en el día; ${fmt(e.sismos.felt)} de magnitud 3 o más`, e.sismos.top)}
    ${block('Avisos oficiales', `${fmt(e.oficiales.total)} avisos de protección civil, 112 y gobiernos autonómicos${e.oficiales.power ? `; ${fmt(e.oficiales.power)} de cortes de luz` : ''}`, e.oficiales.top)}
    ${block('Catástrofes en el mundo (GDACS)', `${fmt(e.gdacs.total)} alertas naranja o roja`, e.gdacs.top)}
  </div>`;
}

function tableSection(d) {
  const modes = d.vehicles.modes;
  const hours = [...Array(24).keys()].filter((h) => modes.some((m) => Number.isFinite(m.hourly[h])) || Number.isFinite(d.delay.hourly[h]));
  if (!hours.length) return '';
  return `<details class="dia-table"><summary>Ver los datos por horas en una tabla</summary><div class="scroll"><table>
    <thead><tr><th>Hora</th>${modes.map((m) => `<th>${esc(m.label)}</th>`).join('')}<th>% con 5 min o más</th></tr></thead>
    <tbody>${hours.map((h) => `<tr><td>${hourLabel(h)}</td>${modes.map((m) => `<td data-label="${esc(m.label)}">${fmt(m.hourly[h])}${m.compare && Number.isFinite(m.compare[h]) ? ` <span class="muted">(${fmt(m.compare[h])})</span>` : ''}</td>`).join('')}<td data-label="% con 5 min o más">${fmt(d.delay.hourly[h])}</td></tr>`).join('')}</tbody>
  </table></div>${d.vehicles.compareDate ? `<p class="muted">Entre paréntesis, el ${esc(dayTitle(d.vehicles.compareDate))}.</p>` : ''}</details>`;
}

function creditsSection(d) {
  if (!d.credits.length) return '';
  return `<h2>Fuentes</h2><ul class="dia-credits">${d.credits.map((c) => `<li><strong>${esc(c.names.join(', '))}</strong>: ${creditHtml(c.credit)}</li>`).join('')}</ul>`;
}

function coverageText(d) {
  const c = d.coverage;
  const parts = [];
  if (d.today) parts.push(`En curso: datos hasta las ${esc(fmtTime(c.to ?? d.generatedAt))}.`);
  if (c.hoursRailOnly && !c.hoursAllModes) parts.push('De este día sólo se guardan los trenes, metros y tranvías con posición real y las alertas: las cancelaciones, los trenes sin datos y los avisos empezaron a guardarse después.');
  else if (c.hoursRailOnly) parts.push(`${c.hoursRailOnly === 1 ? 'Una hora' : `${c.hoursRailOnly} horas`} de este día sólo con los trenes, metros y tranvías con posición real (antes de que se guardara este resumen).`);
  if (d.truncated?.length) parts.push('Alguna lista llegó a su tope: las cifras de ese apartado se quedan cortas.');
  return parts.join(' ');
}

function render() {
  const d = data;
  renderNav();
  el.innerHTML = `<h2 class="dia-date">${esc(dayTitle(d.date))}${d.today ? ' <span class="dia-live">· hoy</span>' : ''}</h2>
    <p class="muted">${coverageText(d)}</p>
    ${tiles(d)}${vehiclesSection(d)}${delaySection(d)}${cancellationsSection(d)}${missingSection(d)}${alertsSection(d)}${emergenciesSection(d)}
    ${tableSection(d)}${creditsSection(d)}`;
  drawCharts();
}

// ---------- Gráficas (a la medida de su caja) y su ficha al pasar por encima ----------

const charts = new Map(); // id de la caja → { series: [{ name, values, unit, compare? }] }

function drawCharts() {
  lastWidth = el.clientWidth;
  charts.clear();
  if (!data) return;
  const compareName = data.vehicles.compareDate ? dayShort(data.vehicles.compareDate) : null;
  for (const m of data.vehicles.modes) {
    const box = document.querySelector(`#v-${CSS.escape(m.id)} .plot`);
    if (!box) continue;
    box.innerHTML = lineChart({ width: box.clientWidth, height: 150, today: m.hourly, compare: m.compare,
      label: `${m.label}: vehículos vistos en tiempo real por horas${m.compare ? ', con el mismo día de la semana anterior' : ''}. Los valores están en la tabla.` });
    charts.set(`v-${m.id}`, { series: [{ name: data.today ? 'Hoy' : dayShort(data.date), values: m.hourly }, ...(m.compare ? [{ name: compareName, values: m.compare }] : [])] });
  }
  const delayBox = document.querySelector('#delay .plot');
  if (delayBox) {
    delayBox.innerHTML = columnChart({ width: delayBox.clientWidth, height: 160, values: data.delay.hourly, unit: ' %', fixedMax: Math.max(10, ...data.delay.hourly.filter(Number.isFinite)),
      label: 'Porcentaje de vehículos con 5 min o más de retraso, por horas. Los valores están en la tabla.' });
    charts.set('delay', { series: [{ name: 'Con 5 min o más', values: data.delay.hourly, unit: ' %' }] });
  }
}

function showTip(card, hour) {
  const chart = charts.get(card.id);
  const svg = card.querySelector('svg.chart');
  if (!chart || !svg) return;
  const x0 = Number(svg.dataset.x0);
  const x1 = Number(svg.dataset.x1);
  const x = x0 + ((x1 - x0) * hour) / 23;
  const cross = svg.querySelector('.crosshair');
  cross.setAttribute('x1', x);
  cross.setAttribute('x2', x);
  cross.setAttribute('visibility', 'visible');
  const tip = card.querySelector('.tip');
  tip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'tip-h';
  head.textContent = `${hourLabel(hour)} a ${hourLabel((hour + 1) % 24)}`;
  tip.append(head);
  chart.series.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = `tip-r${i ? ' compare' : ''}`;
    const key = document.createElement('i');
    const value = document.createElement('strong');
    value.textContent = `${fmt(s.values[hour])}${Number.isFinite(s.values[hour]) ? s.unit ?? '' : ''}`;
    row.append(key, value, document.createTextNode(` ${s.name}`));
    tip.append(row);
  });
  tip.hidden = false;
  const left = svg.getBoundingClientRect().left - card.getBoundingClientRect().left + x;
  tip.style.left = `${Math.min(Math.max(left + 12, 8), card.clientWidth - tip.offsetWidth - 8)}px`;
  card.dataset.hour = String(hour);
}

function hideTip(card) {
  card.querySelector('.tip')?.setAttribute('hidden', '');
  card.querySelector('.crosshair')?.setAttribute('visibility', 'hidden');
}

el.addEventListener('pointermove', (ev) => {
  const svg = ev.target.closest?.('svg.chart');
  const card = svg?.closest('.chart-card');
  if (!card) return;
  const box = svg.getBoundingClientRect();
  showTip(card, hourAt(ev.clientX - box.left, Number(svg.dataset.x0), Number(svg.dataset.x1)));
});
el.addEventListener('pointerout', (ev) => {
  const card = ev.target.closest?.('.chart-card');
  if (card && !card.contains(ev.relatedTarget)) hideTip(card);
});
// Con el teclado: al entrar, la última hora con datos; las flechas mueven la hora.
el.addEventListener('focusin', (ev) => {
  const card = ev.target.closest?.('.chart-card');
  const chart = card && charts.get(card.id);
  if (!chart) return;
  const values = chart.series[0].values;
  const last = values.reduce((acc, v, i) => (Number.isFinite(v) ? i : acc), 0);
  showTip(card, last);
});
el.addEventListener('focusout', (ev) => {
  const card = ev.target.closest?.('.chart-card');
  if (card) hideTip(card);
});
el.addEventListener('keydown', (ev) => {
  const card = ev.target.closest?.('.chart-card');
  if (!card || (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight')) return;
  ev.preventDefault();
  const hour = Math.max(0, Math.min(23, Number(card.dataset.hour ?? 0) + (ev.key === 'ArrowRight' ? 1 : -1)));
  showTip(card, hour);
});

// Las gráficas se dibujan a la medida de su caja: si cambia el ancho (girar el móvil, la ventana), otra vez.
let resizeTimer = null;
let lastWidth = 0;
const redraw = () => {
  if (el.clientWidth === lastWidth) return;
  lastWidth = el.clientWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawCharts, 150);
};
if ('ResizeObserver' in window) new ResizeObserver(redraw).observe(el);
else addEventListener('resize', redraw);

load(dayParam());
