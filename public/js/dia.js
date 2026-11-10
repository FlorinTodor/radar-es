// El día en cifras: pide el resumen del día (/api/dia o /api/dia/AAAA-MM-DD) y lo dibuja. El de hoy se
// vuelve a pedir cada minuto; uno pasado se pide una vez (mientras el servidor lo lee del disco, responde
// 503 y se vuelve a pedir enseguida). Los nombres de los tipos de vehículo vienen del servidor (su
// registro de tipos), así que un tipo nuevo sale aquí sin tocar nada.
import { SEVERITY_LABEL, creditHtml, esc, fmtTime } from './format.js';
import { mountLangSwitch, t, tn, tx } from './i18n.js';
import { followNameText } from './siguiendo.js';

// Nombre de una línea del día (lo escribe el servidor como el de «Siguiendo»: describeFollow), con nuestras palabras traducidas.
const lineLabel = (name) => (name === 'Sin nombre' ? t('Sin nombre') : followNameText(name));
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
// Los niveles de los avisos (AEMET y GDACS, ya pasados a estas palabras por el servidor).
const LEVEL = { amarillo: t('amarillo'), naranja: t('naranja'), rojo: t('rojo'), verde: t('verde') };

let data = null;
// Hoy en Madrid, «AAAA-MM-DD»: la lista de días de un día pasado puede ser de antes de medianoche.
const TODAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const madridToday = () => TODAY_FMT.format(new Date());
let timer = null;
let asked = null; // el día que se ha pedido (null: hoy)

// La fecha de la URL tal cual si tiene forma AAAA-MM-DD (aunque no exista: se dice); si no, hoy.
const dayParam = () => {
  const d = new URLSearchParams(location.search).get('dia');
  return /^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? d : null;
};
/** ¿Existe esa fecha? (el 30 de febrero, no: `new Date` lo pasaría al 2 de marzo) */
const realDay = (d) => { const at = new Date(`${d}T12:00:00Z`); return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === d; };

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
      el.innerHTML = day && !realDay(day)
        ? `<p class="muted">${t('La fecha {day} no existe.', { day: esc(day) })}</p>`
        : `<p class="muted">${t('No hay datos de {day}. El radar guarda los últimos 90 días.', { day: day ? esc(dayTitle(day)) : t('hoy todavía') })}</p>`;
      el.setAttribute('aria-busy', 'false');
      navWithout(day);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    render();
  } catch {
    if (!data) el.innerHTML = `<p class="muted">${t('No se ha podido cargar el día. Se volverá a intentar en un momento.')}</p>`;
    timer = setTimeout(() => load(day, { quiet: true }), REFRESH_MS);
    return;
  } finally {
    if (asked === day) el.setAttribute('aria-busy', 'false');
  }
  if (!day || data?.today) timer = setTimeout(() => load(day, { quiet: true }), REFRESH_MS);
}

function go(day) {
  const url = new URL(location.href);
  if (day && day !== madridToday()) url.searchParams.set('dia', day);
  else url.searchParams.delete('dia');
  history.pushState(null, '', url);
  load(dayParam());
}

prev.addEventListener('click', () => data?.prev && go(data.prev));
next.addEventListener('click', () => data?.next && go(data.next));
select.addEventListener('change', () => go(select.value));
addEventListener('popstate', () => load(dayParam()));

/** Sin datos del día pedido: «Volver a hoy» y la lista de días que sí hay (la de hoy), para no quedarse sin salida. */
async function navWithout(day) {
  todayLink.hidden = !day;
  try {
    const res = await fetch('/api/dia');
    if (!res.ok || asked !== day) return;
    const days = (await res.json()).days ?? [];
    if (asked !== day) return;
    const before = days.find((d) => d < day) ?? null;           // los días van del más reciente al más antiguo
    const after = [...days].reverse().find((d) => d > day) ?? null;
    prev.disabled = !before;
    next.disabled = !after;
    prev.onclick = before ? () => go(before) : null;
    next.onclick = after ? () => go(after) : null;
    select.disabled = !days.length;
    select.innerHTML = `<option value="" selected disabled>${t('Elige un día')}</option>${days.map((d) => `<option value="${esc(d)}">${esc(dayShort(d))}${d === madridToday() ? ` (${t('hoy')})` : ''}</option>`).join('')}`;
  } catch { /* sin lista de días: queda «Volver a hoy» */ }
}

function renderNav() {
  prev.onclick = null;
  next.onclick = null;
  prev.disabled = !data.prev;
  next.disabled = !data.next;
  select.disabled = !data.days.length;
  select.innerHTML = data.days.map((d) => `<option value="${esc(d)}"${d === data.date ? ' selected' : ''}>${esc(dayShort(d))}${d === madridToday() ? ` (${t('hoy')})` : ''}</option>`).join('');
  todayLink.hidden = data.today;
}

// ---------- Cifras ----------

const tile = (label, value, sub = '', hero = false) => `<div class="tile${hero ? ' hero' : ''}">
  <div class="t-label">${esc(label)}</div><div class="t-value">${value}</div>${sub ? `<div class="t-sub">${sub}</div>` : ''}</div>`;

// Lo que no se sabe (un día sin registro, el histórico aún sin leer) sale como «sin dato», nunca como 0.
const UNKNOWN = `<span class="t-unknown">${t('sin dato')}</span>`;
const NOT_SAVED = t('de este día no se guardó');

function tiles(d) {
  const c = d.cancellations;
  const peak = d.vehicles.peak;
  const em = d.emergencies;
  const railOnly = !d.coverage.hoursAllModes;
  const late = d.delay.lateShare;
  const median = medianPhrase(d.delay.median);
  return `<div class="dia-tiles">
    ${tile(t('Cancelaciones'), c ? fmt(c.total) : UNKNOWN, c ? (c.total ? t('{whole} sin circular y {partial} con paradas suprimidas, de {operators}', { whole: fmt(c.whole), partial: fmt(c.partial), operators: tn('{n} operador', '{n} operadores', c.operators) }) : t('Ningún viaje cancelado')) : NOT_SAVED, true)}
    ${tile(t('Máximo a la vez'), peak ? fmt(peak.total) : UNKNOWN, peak ? (railOnly ? t('trenes, metros y tranvías vistos en tiempo real a las {time}', { time: esc(fmtTime(peak.t)) }) : t('vehículos vistos en tiempo real a las {time}', { time: esc(fmtTime(peak.t)) })) : '')}
    ${tile(t('Con 5 min o más de retraso'), late !== null ? t('{n} %', { n: fmt(late) }) : UNKNOWN, late !== null ? `${t('de los que publican su retraso')}${median ? `; ${esc(median)}` : ''}` : t('ningún operador publicó su retraso'))}
    ${tile(t('Trenes sin datos'), d.missing ? fmt(d.missing.total) : UNKNOWN, d.missing ? t('en algún momento del día') : NOT_SAVED)}
    ${tile(t('Alertas del radar'), d.alerts ? fmt(d.alerts.total) : UNKNOWN, d.alerts ? (d.alerts.bySeverity.alta || d.alerts.bySeverity['muy alta'] ? t('{n} de gravedad alta', { n: fmt((d.alerts.bySeverity.alta ?? 0) + (d.alerts.bySeverity['muy alta'] ?? 0)) }) : '') : t('aún no se ha leído'))}
    ${tile(t('Avisos de emergencia'), em ? fmt(em.meteo.total + em.sismos.total + em.oficiales.total + em.gdacs.total) : UNKNOWN, em ? [em.meteo.total && t('{n} de AEMET', { n: fmt(em.meteo.total) }), em.sismos.total && t('{n} terremotos', { n: fmt(em.sismos.total) }), em.oficiales.total && t('{n} oficiales', { n: fmt(em.oficiales.total) })].filter(Boolean).join(' · ') : NOT_SAVED)}
  </div>`;
}

const chartCard = (id, title, sub = '') => `<div class="chart-card" id="${id}"><h3>${esc(title)}</h3>${sub ? `<p class="c-sub">${sub}</p>` : ''}<div class="plot"></div><div class="tip" hidden></div></div>`;

function vehiclesSection(d) {
  const modes = d.vehicles.modes.filter((m) => m.hourly.some((v) => v > 0) || m.compare?.some((v) => v > 0));
  if (!modes.length) return '';
  const compare = d.vehicles.compareDate;
  return `<h2>${t('Vehículos vistos en tiempo real, por horas')}</h2>
    <p class="muted">${t('Media de cada hora.')} ${compare ? t('En gris, el {day}, el mismo día de la semana anterior.', { day: esc(dayTitle(compare)) }) : ''}</p>
    ${compare ? `<div class="legend"><span><i class="k-today"></i>${d.today ? t('Hoy') : esc(dayShort(d.date))}</span><span><i class="k-compare"></i>${esc(dayShort(compare))}</span></div>` : ''}
    <div class="dia-grid">${modes.map((m) => chartCard(`v-${m.id}`, t(m.label), t('Máximo a la vez: {n} {noun}', { n: fmt(m.max), noun: esc(t(m.max === 1 ? m.noun : m.nounPlural)) }))).join('')}</div>`;
}

function delaySection(d) {
  if (!d.delay.hourly.some(Number.isFinite)) return '';
  const rows = d.vehicles.modes.filter((m) => m.delay);
  return `<h2>${t('Retraso')}</h2>
    <div class="dia-grid one">${chartCard('delay', t('Con 5 min o más de retraso, por horas'), t('Porcentaje de los vehículos que publican su retraso. Sin barra, las horas con muy pocos (menos de 5 de media): con tan pocos, el porcentaje no dice nada'))}</div>
    ${rows.length ? `<ul class="dia-list">${rows.map((m) => `<li><strong>${esc(t(m.label))}</strong>: ${t('{share} % con 5 min o más', { share: fmt(m.delay.lateShare) })}${medianPhrase(m.delay.median) ? `; ${esc(medianPhrase(m.delay.median))}` : ''}</li>`).join('')}</ul>` : ''}`;
}


function cancellationsSection(d) {
  const c = d.cancellations;
  if (!c) return `<h2>${t('Cancelaciones')}</h2><p class="muted">${t('Sin dato: {why} (el radar empezó a guardar las cancelaciones de cada día más tarde).', { why: NOT_SAVED })}</p>`;
  if (!c.total) return `<h2>${t('Cancelaciones')}</h2><p class="muted">${t('Ningún operador ha dado viajes por cancelados en su tiempo real.')}</p>`;
  return `<h2>${t('Cancelaciones')}</h2>
    <p class="muted">${t('{n} viajes cancelados o con paradas suprimidas', { n: fmt(c.total) })}${c.byMode.length ? `: ${c.byMode.map((m) => t('{n} de {label}', { n: fmt(m.n), label: esc(t(m.label).toLowerCase()) })).join(', ')}` : ''}.</p>
    <div class="dia-cols">
      <div><h3>${t('Dónde más cancelaciones')}</h3>${hbars(c.byLine.map((g) => ({ label: lineLabel(g.name), value: g.n, sub: g.partial ? t('{n} con paradas suprimidas', { n: fmt(g.partial) }) : '' })))}</div>
      <div><h3>${t('Por operador')}</h3>${hbars(c.byOperator.map((o) => ({ label: o.name, value: o.n })))}</div>
    </div>`;
}

function missingSection(d) {
  const m = d.missing;
  if (!m?.total) return '';
  return `<h2>${t('Trenes sin datos')}</h2>
    <p class="muted">${tn('{n} tren debía circular según su horario y su operador no publicaba nada de él en algún momento. No es una cancelación: no se sabe si circularon.',
    '{n} trenes debían circular según su horario y su operador no publicaba nada de ellos en algún momento. No es una cancelación: no se sabe si circularon.', m.total)}</p>
    <div class="dia-cols"><div><h3>${t('Dónde más trenes sin datos')}</h3>${hbars(m.byLine.map((g) => ({ label: lineLabel(g.name), value: g.n })))}</div></div>`;
}

function alertsSection(d) {
  const a = d.alerts;
  if (!a?.total) return '';
  const reopened = Number.isFinite(a.situations) && a.situations < a.total;
  return `<h2>${t('Alertas del radar')}</h2>
    <p class="muted">${reopened
    ? t('{n} alertas (trenes detenidos, saltos de retraso, fuentes caídas, avisos…), de {situations} situaciones distintas: una misma situación se cuenta cada vez que vuelve a abrirse. Las de más gravedad:', { n: fmt(a.total), situations: fmt(a.situations) })
    : t('{n} alertas (trenes detenidos, saltos de retraso, fuentes caídas, avisos…). Las de más gravedad:', { n: fmt(a.total) })}</p>
    <ul class="dia-list">${a.top.map((x) => `<li><span class="pill-sev">${esc(SEVERITY_LABEL[x.severity] ?? x.severity ?? '')}</span> ${esc(tx(x.title))}${x.since ? ` <span class="muted">· ${esc(x.times > 1 ? t('desde las {time}', { time: fmtTime(x.since) }) : fmtTime(x.since))}</span>` : ''}${x.times > 1 ? ` <span class="muted">· ${t('{n} veces', { n: fmt(x.times) })}</span>` : ''}</li>`).join('')}</ul>`;
}

function emergenciesSection(d) {
  const e = d.emergencies;
  if (!e) return `<h2>${t('Avisos de emergencia')}</h2><p class="muted">${t('Sin dato: {why}.', { why: NOT_SAVED })}</p>`;
  if (!(e.meteo.total + e.sismos.total + e.oficiales.total + e.gdacs.total)) return '';
  const item = (x) => `<li>${x.level ? `<span class="pill-sev">${esc(LEVEL[x.level] ?? x.level)}</span> ` : ''}${esc(tx(x.title ?? ''))}${x.area && !(x.title ?? '').includes(x.area) ? ` <span class="muted">· ${esc(x.area)}</span>` : ''}</li>`;
  const block = (title, sub, list) => (list.length ? `<div><h3>${esc(title)}</h3><p class="muted">${sub}</p><ul class="dia-list">${list.map(item).join('')}</ul></div>` : '');
  const official = { n: fmt(e.oficiales.total), power: fmt(e.oficiales.power) };
  return `<h2>${t('Avisos de emergencia')}</h2><div class="dia-cols">
    ${block(t('Meteorología (AEMET)'), t('{total} avisos naranja o rojo: {red} rojos y {orange} naranjas', { total: fmt(e.meteo.total), red: fmt(e.meteo.rojo), orange: fmt(e.meteo.naranja) }), e.meteo.top)}
    ${block(t('Terremotos'), t('{total} en el día; {felt} de magnitud 3 o más', { total: fmt(e.sismos.total), felt: fmt(e.sismos.felt) }), e.sismos.top)}
    ${block(t('Avisos oficiales'), e.oficiales.power ? t('{n} avisos de protección civil, 112 y gobiernos autonómicos; {power} de cortes de luz', official)
    : t('{n} avisos de protección civil, 112 y gobiernos autonómicos', official), e.oficiales.top)}
    ${block(t('Catástrofes en el mundo (GDACS)'), t('{n} alertas naranja o roja', { n: fmt(e.gdacs.total) }), e.gdacs.top)}
  </div>`;
}

function tableSection(d) {
  const modes = d.vehicles.modes;
  const hours = [...Array(24).keys()].filter((h) => modes.some((m) => Number.isFinite(m.hourly[h])) || Number.isFinite(d.delay.hourly[h]));
  if (!hours.length) return '';
  const lateCol = esc(t('% con 5 min o más'));
  return `<details class="dia-table"><summary>${t('Ver los datos por horas en una tabla')}</summary><div class="scroll"><table>
    <thead><tr><th>${t('Hora')}</th>${modes.map((m) => `<th>${esc(t(m.label))}</th>`).join('')}<th>${lateCol}</th></tr></thead>
    <tbody>${hours.map((h) => `<tr><td>${hourLabel(h)}</td>${modes.map((m) => `<td data-label="${esc(t(m.label))}">${fmt(m.hourly[h])}${m.compare && Number.isFinite(m.compare[h]) ? ` <span class="muted">(${fmt(m.compare[h])})</span>` : ''}</td>`).join('')}<td data-label="${lateCol}">${fmt(d.delay.hourly[h])}</td></tr>`).join('')}</tbody>
  </table></div>${d.vehicles.compareDate ? `<p class="muted">${t('Entre paréntesis, el {day}.', { day: esc(dayTitle(d.vehicles.compareDate)) })}</p>` : ''}</details>`;
}

function creditsSection(d) {
  if (!d.credits.length) return '';
  return `<h2>${t('Fuentes')}</h2><ul class="dia-credits">${d.credits.map((c) => `<li><strong>${esc(c.names.join(', '))}</strong>: ${creditHtml(c.credit)}</li>`).join('')}</ul>`;
}

function coverageText(d) {
  const c = d.coverage;
  const parts = [];
  if (d.today) parts.push(t('En curso: datos hasta las {time}.', { time: esc(fmtTime(c.to ?? d.generatedAt)) }));
  if (c.hoursRailOnly && !c.hoursAllModes) parts.push(t('De este día sólo se guardan los trenes, metros y tranvías con posición real y las alertas: las cancelaciones, los trenes sin datos y los avisos empezaron a guardarse después.'));
  else if (c.hoursRailOnly) {
    parts.push(tn('Una hora de este día sólo con los trenes, metros y tranvías con posición real (antes de que se guardara este resumen).',
      '{n} horas de este día sólo con los trenes, metros y tranvías con posición real (antes de que se guardara este resumen).', c.hoursRailOnly));
  }
  if (d.truncated?.length) parts.push(t('Alguna lista llegó a su tope: las cifras de ese apartado se quedan cortas.'));
  return parts.join(' ');
}

function render() {
  const d = data;
  renderNav();
  el.innerHTML = `<h2 class="dia-date">${esc(dayTitle(d.date))}${d.today ? ` <span class="dia-live">· ${t('hoy')}</span>` : ''}</h2>
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
      label: m.compare ? t('{label}: vehículos vistos en tiempo real por horas, con el mismo día de la semana anterior. Los valores están en la tabla.', { label: t(m.label) })
        : t('{label}: vehículos vistos en tiempo real por horas. Los valores están en la tabla.', { label: t(m.label) }) });
    charts.set(`v-${m.id}`, { series: [{ name: data.today ? t('Hoy') : dayShort(data.date), values: m.hourly }, ...(m.compare ? [{ name: compareName, values: m.compare }] : [])] });
  }
  const delayBox = document.querySelector('#delay .plot');
  if (delayBox) {
    delayBox.innerHTML = columnChart({ width: delayBox.clientWidth, height: 160, values: data.delay.hourly, unit: t(' %'), fixedMax: Math.max(10, ...data.delay.hourly.filter(Number.isFinite)),
      label: t('Porcentaje de vehículos con 5 min o más de retraso, por horas. Los valores están en la tabla.') });
    charts.set('delay', { series: [{ name: t('Con 5 min o más'), values: data.delay.hourly, unit: t(' %') }] });
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
  head.textContent = t('{from} a {to}', { from: hourLabel(hour), to: hourLabel((hour + 1) % 24) });
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

// El interruptor ES/EN: al cambiar se recarga con la misma dirección, así que se queda en el día que se ve (?dia=…).
mountLangSwitch();
load(dayParam());
