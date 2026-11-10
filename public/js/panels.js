// Render de los paneles laterales y la barra de KPIs. Funciones puras de estado → HTML;
// los clics se gestionan por delegación en app.js mediante data-id / data-kind.
import {
  DELAY_CLASSES, MODE_LABEL, SEVERITY_LABEL, SEVERITY_RANK, creditHtml, esc, fmtDataTime, fmtDateTime, fmtDateTimeYear, scheduleValidity, fmtDec, fmtDelay, fmtNum, fmtTime, safeUrl, sevClass, timeAgo, vehicleTitle,
} from './format.js';
import { t, tn, tx } from './i18n.js';
import { pictoFor, vehicleIconUrl } from './icons.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 250;

export function renderKpis(kpis, metrics, alertCount) {
  $('k-vehicles').textContent = fmtNum(kpis?.vehicles);
  $('k-delayed').textContent = fmtNum(kpis?.delayed);
  $('k-delayed-sub').textContent = kpis?.withDelayInfo ? t('{pct} % de los que informan retraso', { pct: Math.round((kpis.delayed / kpis.withDelayInfo) * 100) }) : '';
  $('k-median').textContent = kpis?.medianDelay === null || kpis?.medianDelay === undefined ? '–' : `${fmtNum(Math.round(kpis.medianDelay))} min`;
  $('k-alerts').textContent = fmtNum(alertCount);
  const ree = metrics?.ree;
  $('k-grid').textContent = ree?.demandMW ? `${fmtNum(ree.demandMW)} MW` : '–';
  // Red Eléctrica exige citarla y dar la hora del dato.
  $('k-grid-sub').textContent = ree?.deviation !== null && ree?.deviation !== undefined
    ? t('{dev} % frente a lo previsto · Red Eléctrica, {time}', { dev: `${ree.deviation >= 0 ? '+' : '−'}${fmtDec(Math.abs(ree.deviation * 100), 1)}`, time: fmtTime(ree.at) })
    : '';
}

function severityPill(sev) {
  return `<span class="pill ${sevClass(sev)}">${esc(SEVERITY_LABEL[sev] ?? sev)}</span>`;
}

/**
 * Barra de selección común a Alertas, Incidencias y Vehículos.
 * @param {{ ids: Set<string>, total: number, multi: boolean }} sel  total = elementos marcados en todas las listas
 */
function selectionBar(sel, what) {
  return `
    <div class="alerts-toolbar">
      <label class="switch"><input type="checkbox" data-action="multi" ${sel.multi ? 'checked' : ''}><span class="track"></span>${t('Varias a la vez')}</label>
      ${sel.total ? `<button type="button" class="btn-ghost" data-action="clear-focus">${t('Ver todo')}</button>` : ''}
    </div>
    <div class="hint">${sel.total
      ? `${t('El mapa muestra sólo lo marcado ({n}).', { n: sel.total })} ${sel.multi ? t('Pulsa más elementos para sumarlos o uno marcado para quitarlo.') : ''}`
      : sel.multi ? what.many : what.one}</div>`;
}

const NO_SELECTION = { ids: new Set(), total: 0, multi: false };
const check = (on) => (on ? '<span class="check" aria-hidden="true">✓</span>' : '');

// Alertas que cruzan los datos de una fuente con los trenes: AEMET pide «Fuente: AEMET» cuando sus
// avisos se usan para elaborar otra información (los avisos tal cual llevan «© AEMET»).
const ALERT_CREDIT = { meteo: 'Fuente: AEMET' };

export function renderAlerts(el, alerts, resolved, sel = NO_SELECTION) {
  const now = Date.now();
  const toolbar = alerts.length ? selectionBar(sel, {
    one: t('Pulsa una alerta para ver en el mapa sólo eso.'),
    many: t('Pulsa las alertas para verlas juntas en el mapa; vuelve a pulsar para quitar.'),
  }) : '';
  const active = alerts.length
    ? alerts.map((a) => {
      const on = sel.ids.has(a.id);
      return `
      <button class="item alert-item ${sevClass(a.severity)}${on ? ' selected' : ''}" data-kind="alert" data-id="${esc(a.id)}" aria-pressed="${on}">
        <div class="row">${severityPill(a.severity)}${check(on)}</div>
        <div class="title">${esc(tx(a.title))}</div>
        ${a.description ? `<div class="desc">${esc(tx(a.description))}</div>` : ''}
        <div class="meta"><span>${t('Desde las {time} ({ago})', { time: fmtTime(a.since), ago: timeAgo(a.since, now) })}</span>${a.credit || ALERT_CREDIT[a.type] ? `<span>${esc(a.credit || ALERT_CREDIT[a.type])}</span>` : ''}</div>
      </button>`;
    }).join('')
    : `<div class="empty">${t('Sin alertas activas.')}<br>${t('El motor revisa trenes detenidos en plena vía, saltos de retraso, terremotos, focos de incendio cerca de trenes, avisos meteorológicos naranja o rojo, la red eléctrica, los cortes de luz y planes de emergencia que publican protección civil, los 112 y los gobiernos autonómicos, y la salud de las fuentes.')}</div>`;
  const done = resolved.slice(0, 15).map((a) => `
      <div class="item resolved ${sevClass(a.severity)}">
        <div class="title">${esc(tx(a.title))}</div>
        <div class="meta"><span>${fmtTime(a.since)} – ${fmtTime(a.resolvedAt)}</span></div>
      </div>`).join('');
  el.innerHTML = `<div class="section-title">${t('Activas')}</div>${toolbar}${active}${done ? `<div class="section-title">${t('Resueltas recientemente')}</div>${done}` : ''}`;
}

export const EVENT_CATEGORIES = [
  ['ferroviario', t('Ferroviario')],
  ['cancelacion', t('Cancelaciones')],
  ['sin-datos', t('Trenes sin datos')],
  ['carretera', t('Carretera')],
  ['meteo', t('Meteorología')],
  ['incendio', t('Incendios')],
  ['sismo', t('Terremotos')],
  ['catastrofe', t('Catástrofes')],
  ['emergencia', t('Avisos oficiales')],
];

export function renderEventFilters(el, prefs) {
  el.innerHTML = EVENT_CATEGORIES.map(([id, label]) =>
    `<button class="chip" data-cat="${id}" aria-pressed="${prefs.eventCats.includes(id)}">${label}</button>`).join('') +
    `<button class="chip" data-cat="obras" aria-pressed="${prefs.obras}">${t('Incluir obras')}</button>`;
}

export function filterEvents(events, prefs) {
  return events
    .filter((e) => prefs.eventCats.includes(e.category) && (prefs.obras || e.type !== 'roadMaintenance'))
    // A igual gravedad, los cortes de luz primero (como en las alertas).
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (b.power ? 1 : 0) - (a.power ? 1 : 0)
      || (b.start ?? b.issued ?? 0) - (a.start ?? a.issued ?? 0));
}

export function renderEvents(el, events, sel = NO_SELECTION) {
  if (!events.length) {
    el.innerHTML = `<div class="empty">${t('No hay incidencias con estos filtros.')}</div>`;
    return;
  }
  const rows = events.slice(0, MAX_ROWS).map((e) => {
    const on = sel.ids.has(e.id);
    return `
    <button class="item alert-item ${sevClass(e.severity)}${on ? ' selected' : ''}" data-kind="event" data-id="${esc(e.id)}" aria-pressed="${on}">
      <div class="row">${severityPill(e.severity)}${check(on)}</div>
      <div class="title">${esc(tx(e.title, e.source))}</div>
      ${e.description && e.category !== 'sismo' ? `<div class="desc">${esc(shorten(tx(e.description, e.source), 220))}</div>` : ''}
      <div class="meta">
        ${e.issued && e.issued !== e.start ? `<span>${t('publicado el {date}', { date: fmtDateTime(e.issued) })}</span>` : ''}
        ${e.start ? `<span>${fmtDateTime(e.start)}</span>` : ''}
        ${e.trip ? cancellationMeta(e) : ''}
        ${e.end ? `<span>${t('hasta {date}', { date: fmtDateTime(e.end) })}</span>` : ''}
        ${e.lat === null || e.lat === undefined ? `<span>${t('sin ubicación')}</span>` : ''}
        ${e.area ? `<span>${esc(e.area)}</span>` : ''}
        ${e.credit ? `<span>${esc(e.credit)}</span>` : ''}
      </div>
    </button>`;
  }).join('');
  const more = events.length > MAX_ROWS ? `<div class="empty">${t('Mostrando {shown} de {total}.', { shown: MAX_ROWS, total: fmtNum(events.length) })}</div>` : '';
  el.innerHTML = selectionBar(sel, {
    one: t('Pulsa una incidencia para ver en el mapa sólo eso.'),
    many: t('Pulsa las incidencias para verlas juntas en el mapa; vuelve a pulsar para quitar.'),
  }) + rows + more;
}

/** Lo que se ve de una cancelación (o de un tren sin datos) en la lista: quién la publica, desde cuándo la
 * ve el radar y, si su fuente ya no la publica, desde cuándo. */
function cancellationMeta(e) {
  const trip = e.trip;
  if (e.category === 'sin-datos') {
    return `<span>${t('{publisher} no publica nada de él', { publisher: esc(trip.publisher) })}</span>${e.seen ? `<span>${t('en falta desde las {time}', { time: fmtTime(e.seen) })}</span>` : ''}`;
  }
  const seen = e.seen ? `<span title="${esc(e.seenAtStart ? t('Ya estaba publicada cuando el radar empezó a leer la fuente: pudo publicarse antes') : t('Cuándo la vio el radar por primera vez: la fuente no dice cuándo la publicó'))}">${
    e.seenAtStart ? t('vista desde las {time}', { time: fmtTime(e.seen) }) : t('vista a las {time}', { time: fmtTime(e.seen) })}</span>` : '';
  return `<span>${t('{publisher} · tiempo real', { publisher: esc(trip.publisher) })}</span>${seen}${e.withdrawn ? `<span>${t('ya no se publica (desde las {time})', { time: fmtTime(e.withdrawn) })}</span>` : ''}`
    + `${trip.trips > 1 ? `<span>${tn('{n} expedición', '{n} expediciones', trip.trips)}</span>` : ''}${trip.notice || trip.reason ? `<span>${t('con su motivo')}</span>` : ''}`;
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function filterVehicles(vehicles, query) {
  const q = query.trim().toLowerCase();
  const list = q
    ? vehicles.filter((v) => [v.label, v.line, v.service, v.origin, v.destination, v.next, v.current, v.area]
      .some((f) => f && String(f).toLowerCase().includes(q)))
    : vehicles;
  return [...list].sort((a, b) => (b.delay ?? (b.late ? 1 : -1)) - (a.delay ?? (a.late ? 1 : -1)));
}

// Sin tildes ni mayúsculas: «castellon» encuentra Castellón.
const plain = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Clave con la que se cuentan los trenes de cada estación: su nombre sin tildes, mayúsculas ni espacios dobles. */
export const stationKey = (name) => plain(name).replace(/\s+/g, ' ').trim();

/** Redes del selector de la pestaña: Renfe y las demás que haya en la lista, por orden alfabético. */
export function stationNetworks(stations) {
  const nets = new Map();
  for (const s of stations) if (s.networkId) nets.set(s.networkId, s.network);
  return [['renfe', 'Renfe'], ...[...nets].sort((a, b) => a[1].localeCompare(b[1], 'es'))];
}

/**
 * Estaciones cuyo nombre, población o red tiene todas las palabras buscadas, en cualquier orden
 * («atocha almudena» encuentra Madrid-Puerta de Atocha-Almudena Grandes); primero las que empiezan así.
 * Con una red elegida («renfe» o el id de otra), sólo las suyas; sin palabras, todas las de esa red.
 */
export function filterStations(stations, query, network = '') {
  const q = plain(query.trim());
  const words = q.split(/[\s-]+/).filter(Boolean);
  if (!words.length && !network) return [];
  const inNetwork = (s) => !network || (network === 'renfe' ? !s.networkId : s.networkId === network);
  const rank = (s) => (plain(s.name).startsWith(q) ? 0 : plain(s.name).includes(q) ? 1 : 2);
  return stations.filter((s) => {
    if (!inNetwork(s)) return false;
    const text = `${plain(s.name)} ${plain(s.place)} ${plain(s.network ?? 'renfe')}`;
    return words.every((w) => text.includes(w));
  }).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es'));
}

/** @param {Map<string, number>} trainsByName trenes parados en cada estación o que van hacia ella (por stationKey) */
export function renderStations(el, stations, query, trainsByName, network = '') {
  if (!query.trim() && !network) {
    el.innerHTML = `<div class="empty">${t('Escribe el nombre de una estación de tren, metro o tranvía, o el de su población, o elige una red.')}<br>${t('Al pulsarla, el mapa va a ella y muestra sus trenes.')}</div>`;
    return;
  }
  if (!stations.length) {
    el.innerHTML = `<div class="empty">${t('Ninguna estación coincide con la búsqueda.')}</div>`;
    return;
  }
  const rows = stations.slice(0, MAX_ROWS).map((s) => {
    const trains = trainsByName.get(stationKey(s.name)) ?? 0;
    const tags = [s.network, s.cercanias && 'Cercanías', s.accessible === true && t('Accesible'), s.metricGauge && t('Ancho métrico')].filter(Boolean);
    return `
    <button class="item srow" data-station="${esc(s.code)}">
      <span class="title">${esc(s.name)}</span>
      <span class="delay">${trains ? tn('{n} tren', '{n} trenes', trains) : ''}</span>
      <span class="sub">${esc([s.place, s.province !== s.place && s.province, ...tags].filter(Boolean).join(' · ') || '—')}</span>
    </button>`;
  }).join('');
  const more = stations.length > MAX_ROWS ? `<div class="empty">${t('Mostrando {shown} de {total}. Afina la búsqueda.', { shown: MAX_ROWS, total: fmtNum(stations.length) })}</div>` : '';
  el.innerHTML = `<div class="section-title">${tn('{n} estación · trenes ahora en ella o en camino', '{n} estaciones · trenes ahora en ellas o en camino', stations.length)}</div>${rows}${more}`;
}

export function renderVehicles(el, vehicles, total, sel = NO_SELECTION) {
  if (!vehicles.length) {
    el.innerHTML = `<div class="empty">${total ? t('Ningún tren coincide con la búsqueda.') : t('Esperando datos…')}</div>`;
    return;
  }
  const rows = vehicles.slice(0, MAX_ROWS).map((v) => {
    const on = sel.ids.has(v.id);
    return `
    <button class="item vrow${on ? ' selected' : ''}" data-kind="vehicle" data-id="${esc(v.id)}" aria-pressed="${on}" style="border-left-color:${DELAY_CLASSES[v.cls][0]}">
      <img class="plate" src="${vehicleIconUrl(pictoFor(v.mode), v.estimated && !v.cls ? '#c3c2b7' : DELAY_CLASSES[v.cls][0], !!v.estimated)}" alt="">
      <span class="title">${check(on)} ${esc(vehicleTitle(v))}${v.estimated ? ` <span class="est-tag">${t('estimada')}</span>` : ''}</span>
      <span class="delay">${v.estimated && (v.delay === null || v.delay === undefined) ? t('Estimado') : esc(fmtDelay(v))}</span>
      <span class="sub">${esc(MODE_LABEL[v.mode] ?? v.mode)} · ${esc(v.origin ?? '?')} → ${esc(v.destination ?? '?')}</span>
    </button>`;
  }).join('');
  const more = vehicles.length > MAX_ROWS ? `<div class="empty">${t('Mostrando {shown} de {total}. Usa el buscador para afinar.', { shown: MAX_ROWS, total: fmtNum(vehicles.length) })}</div>` : '';
  const bar = selectionBar(sel, {
    one: t('Pulsa un vehículo para ver en el mapa sólo eso.'),
    many: t('Pulsa los vehículos para verlos juntos en el mapa; vuelve a pulsar para quitar.'),
  });
  el.innerHTML = `${bar}<div class="section-title">${tn('{n} vehículo · ordenados por retraso', '{n} vehículos · ordenados por retraso', vehicles.length)}</div>${rows}${more}`;
}

/**
 * @param {object[]} health  estado de cada fuente (/api/health)
 * @param {Array<{ name: string, credit: string, updated: number|null }>} [lineSources]  de dónde sale el
 *   trazado de cada red, con su fecha de actualización (/api/lines/sources)
 */
export function renderSources(el, health, lineSources = [], now = Date.now()) {
  // Hasta cuándo vale el horario de la fuente; en los grupos, el primero que se acaba y de quién es.
  const validity = (s) => {
    const v = scheduleValidity(s.datasetValidUntil, now);
    if (!v) return '';
    const text = s.datasetValidUntilOf ? t('el primer horario que se acaba ({of}) es {validity}', { of: esc(s.datasetValidUntilOf), validity: v.text }) : t('horario {validity}', { validity: v.text });
    return `<span>${text}</span>${v.warn ? `<span class="status ${v.expired ? 'ko' : 'warn'}">${v.warn}</span>` : ''}`;
  };
  const lines = lineSources.length ? `<div class="section-title">${t('Trazados de las líneas')}</div>${lineSources.map((l) => `
    <div class="src">
      <div class="row"><span class="name">${esc(l.name)}</span></div>
      <div class="stat">${l.updated ? `<span>${t('horario actualizado el {date}', { date: fmtDateTimeYear(l.updated) })}</span>` : ''}<span>${esc(l.credit)}</span></div>
    </div>`).join('')}` : '';
  el.innerHTML = health.map((s) => {
    const [cls, label] = !s.enabled ? ['off', t('Desactivada')] : s.ok === null ? ['wait', t('Pendiente')] : s.ok ? ['ok', t('Operativa')] : ['ko', t('Con errores')];
    return `
    <div class="src">
      <div class="row"><span class="name">${esc(s.name)}</span></div>
      <div class="stat">
        <span class="status ${cls}">${label}</span>
        ${s.count !== null && s.count !== undefined ? `<span>${tn('{n} elemento', '{n} elementos', s.count)}</span>` : ''}
        ${s.lastOk ? `<span>${t('leída {ago}', { ago: timeAgo(s.lastOk, now) })}</span>` : ''}
        ${s.sourceTime ? `<span>${t('dato {when}', { when: fmtDataTime(s.sourceTime, now) })}</span>` : ''}
        ${s.datasetUpdatedFrom ? `<span>${t('horarios actualizados entre el {from} y el {to}', { from: fmtDateTimeYear(s.datasetUpdatedFrom), to: fmtDateTimeYear(s.datasetUpdated) })}</span>`
          : s.datasetUpdated ? `<span>${t('horario actualizado el {date}', { date: fmtDateTimeYear(s.datasetUpdated) })}</span>` : ''}
        ${validity(s)}
        ${s.ms ? `<span>${fmtNum(s.ms)} ms</span>` : ''}
        <span>${t('cada {n} s', { n: Math.round(s.interval / 1000) })}</span>
      </div>
      ${s.reason ? `<div class="err">${esc(tx(s.reason))}</div>` : ''}
      ${s.error ? `<div class="err">${esc(tx(s.error))}</div>` : ''}
      ${s.license ? `<div class="stat"><span>${creditHtml(s.license)}</span></div>` : ''}
      ${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a>` : ''}
    </div>`;
  }).join('') + lines;
}

export const MODE_ITEMS = ['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'bus', 'otros'];
// Modos ocultos hasta que el usuario los active (los autobuses taparían los trenes).
export const MODES_OFF_BY_DEFAULT = ['bus'];
export const modeOn = (prefs, m) => prefs.modes[m] ?? !MODES_OFF_BY_DEFAULT.includes(m);
export const GROUPS_OFF_BY_DEFAULT = ['effis', 'trails'];
export const groupOn = (prefs, g) => prefs.groups[g] ?? !GROUPS_OFF_BY_DEFAULT.includes(g);
// [capa, nombre corto en la casilla, descripción completa (title y lectores de pantalla), apartado].
// Los nombres van cortos para que las casillas quepan de dos en dos en el móvil.
export const GROUP_ITEMS = [
  ['rail', t('Red ferroviaria'), t('Red ferroviaria'), t('Ferrocarril')],
  ['lines', t('Líneas urbanas'), t('Líneas de metro, tranvía y Cercanías'), t('Ferrocarril')],
  ['stations', t('Estaciones'), t('Estaciones de tren, metro y tranvía: aparecen al acercar el mapa; púlsalas para ver sus trenes'), t('Ferrocarril')],
  ['renfe-avisos', t('Avisos Renfe'), t('Avisos ferroviarios de Renfe y Rodalies'), t('Ferrocarril')],
  ['cancelaciones', t('Cancelaciones'), t('Trenes y autobuses cancelados o con paradas suprimidas que publican en su tiempo real Renfe (Cercanías, Rodalies, Alta Velocidad, Larga y Media Distancia), Euskotren, AMB, AUVASA y EMT Málaga: en su origen o en la primera parada suprimida. Las que dejan de publicarse siguen, desvaídas, hasta medianoche'), t('Ferrocarril')],
  ['sin-datos', t('Sin datos'), t('Trenes de Alta Velocidad, Larga y Media Distancia que según su horario deberían estar circulando y de los que Renfe no publica nada (ni posición, ni retraso, ni cancelación): en la última estación por la que deberían haber pasado. No se sabe si circulan'), t('Ferrocarril')],
  ['trails', t('Estelas'), t('Estelas de todos los trenes (últimos 15 min)'), t('Ferrocarril')],
  ['meteo', t('Meteo (AEMET)'), t('Avisos meteorológicos de AEMET'), t('Emergencias')],
  ['incendios', t('Focos de calor'), t('Focos de calor detectados por satélite'), t('Emergencias')],
  ['effis', t('Áreas quemadas'), t('Áreas quemadas en los últimos 30 días (EFFIS)'), t('Emergencias')],
  ['sismos', t('Terremotos'), t('Terremotos de los dos últimos días'), t('Emergencias')],
  ['gdacs', t('Catástrofes'), t('Alertas de catástrofes (GDACS)'), t('Emergencias')],
  ['emergencias', t('Avisos oficiales'), t('Cortes de luz y planes de emergencia activados que publican protección civil, los 112 y los gobiernos de Andalucía, Baleares, Canarias, Cantabria, Castilla-La Mancha, Castilla y León, Cataluña, Galicia, La Rioja, Madrid, Murcia y País Vasco. Sólo los que publican ellos: los cortes de barrio no salen'), t('Emergencias')],
  ['dgt', t('Tráfico'), t('Incidencias de tráfico (las leves aparecen al acercar el mapa)'), t('Carreteras')],
  ['obras', t('Obras'), t('Obras en carretera, hasta su fin previsto'), t('Carreteras')],
];

export function renderLayers(el, prefs, countsByMode) {
  // Cada casilla es una «pastilla» que se puede pulsar con el dedo; el input sigue ahí (oculto)
  // para que app.js y el teclado funcionen igual.
  const chip = (attr, label, title, on, extra = '') => `
    <label class="chip" title="${esc(title)}"><input type="checkbox" ${attr} ${on ? 'checked' : ''} aria-label="${esc(title)}">
      <span>${esc(label)}</span>${extra}</label>`;
  const modes = MODE_ITEMS.map((m) => chip(`data-mode="${m}"`, MODE_LABEL[m], MODE_LABEL[m], modeOn(prefs, m),
    `<span class="count" data-count="${m}">${fmtNum(countsByMode[m] ?? 0)}</span>`)).join('');
  const sections = [...new Set(GROUP_ITEMS.map((i) => i[3]))].map((section) => `<h5>${section}</h5><div class="chips">${
    GROUP_ITEMS.filter((i) => i[3] === section)
      .map(([g, label, title]) => chip(`data-group="${g}"`, label, title, g === 'obras' ? prefs.obras : groupOn(prefs, g))).join('')}</div>`).join('');
  const plate = (picto, color, estimated) => `<img class="plate" src="${vehicleIconUrl(picto, color, estimated)}" alt="">`;
  const legend = DELAY_CLASSES.slice(1).concat([DELAY_CLASSES[0]]).map(([color, label]) => `${plate('tren', color)}<span>${esc(label)}</span>`).join('');
  const types = [['av', t('Alta velocidad')], ['tren', t('Larga y media distancia, Cercanías')], ['metro', t('Metro')], ['tranvia', t('Tranvía')], ['bus', t('Autobús')]]
    .map(([picto, label]) => `${plate(picto, '#8b8b85')}<span>${label}</span>`).join('');
  const shape = (path, fill, stroke) => `<svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true"><path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/></svg>`;
  // Cabecera de sección con "Todas · Ninguna": marca o desmarca todas sus casillas (data-mode o data-group).
  const head = (title, kind) => `<div class="layers-head"><h4>${title}</h4><span class="bulk">
    <button type="button" class="link" data-bulk="${kind}" data-on="1" aria-label="${esc(t('Todas: activar todas las capas de {section}', { section: title }))}">${t('Todas')}</button> ·
    <button type="button" class="link" data-bulk="${kind}" data-on="0" aria-label="${esc(t('Ninguna: desactivar todas las capas de {section}', { section: title }))}">${t('Ninguna')}</button></span></div>`;
  // La leyenda va plegada: es para consultarla, no para tenerla delante tapando el mapa. Empieza
  // por lo que es cada capa, porque en el móvil no hay ratón para ver el title de las pastillas.
  const help = GROUP_ITEMS.filter(([, label, title]) => label !== title)
    .map(([, label, title]) => `<dt>${esc(label)}</dt><dd>${esc(title)}</dd>`).join('');
  el.innerHTML = `${head(t('Vehículos'), 'mode')}<div class="chips">${modes}</div>${head(t('Mapa y avisos'), 'group')}${sections}
    <p class="layers-note">${t('Las estaciones y el tráfico leve aparecen al acercar el mapa.')}</p>
    <details class="legend-box"><summary>${t('Qué es cada capa y qué significa cada símbolo')}</summary>
    <h4>${t('Capas')}</h4><dl class="layer-help">${help}</dl>
    <h4>${t('Tipo de vehículo')}</h4><div class="legend">${types}</div>
    <h4>${t('Retraso (color de la placa)')}</h4><div class="legend">${legend}
    ${plate('tren', '#fab219', true)}<span>${t('Posición <strong>estimada</strong> a partir del horario, no GPS (Ouigo, ALSA y los metros y tranvías sin GPS): placa hueca; el color indica el retraso si se conoce')}</span>
    <i style="background:transparent;border:2px solid #d03b3b"></i><span>${t('Tren con alerta activa')}</span>
    <i style="background:transparent;border:2.5px solid #6ea8fe"></i><span>${t('Tren seleccionado')}</span>
    <i style="height:0;border-radius:0;border-top:2.5px dashed #6ea8fe"></i><span>${t('Su recorrido en los últimos 45 min')}</span>
    <i style="height:3px;border-radius:0;background:#a9c9ff;box-shadow:0 0 0 1.5px #0d0d0d"></i><span>${t('Lo que le queda hasta su destino (Cercanías, metro y tranvía)')}</span>
    ${shape('M7 2L12 11L7 8.6L2 11Z', '#ffffff', '#0d0d0d')}<span>${t('Hacia dónde va: por su recorrido o, si no lo tiene, por sus últimas posiciones (al acercar el mapa)')}</span>
    <i style="height:0;border-radius:0;border-top:1.5px solid #9db4d8"></i><span>${t('Estela de cada tren (capa opcional, 15 min)')}</span></div>
    <h4>${t('Incidencias')}</h4><div class="legend">
    ${shape('M7 1.2L12.8 7L7 12.8L1.2 7Z', '#fab219', '#0d0d0d')}<span>${t('Tráfico (color = gravedad)')}</span>
    ${shape('M2.2 2.2H11.8V11.8H2.2Z', '#fab219', '#0d0d0d')}<span>${t('Obras en carretera (color = gravedad)')}</span>
    <i style="background:#f0efec;border:1.5px solid #0d0d0d"></i><span>${t('Estación de Renfe: púlsala para ver sus trenes')}</span>
    ${shape('M7 1.5L12.8 12.3L1.2 12.3Z', '#ec835a', '#f0efec')}<span>${t('Aviso Renfe en estación')}</span>
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.9" fill="#ec835a" stroke="#0d0d0d" stroke-width="1.2"/><path d="M4.6 4.6L9.4 9.4M9.4 4.6L4.6 9.4" stroke="#0d0d0d" stroke-width="1.7" stroke-linecap="round"/></svg><span>${t('Tren o autobús cancelado (en su origen) o con paradas suprimidas (en la primera); color = gravedad. Desvaído: su fuente ya no lo publica')}</span>
    <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5.9" fill="#b9b8b2" stroke="#0d0d0d" stroke-width="1.2"/><text x="7" y="10.2" text-anchor="middle" font-size="9" font-weight="bold" font-family="sans-serif" fill="#0d0d0d">?</text></svg><span>${t('Tren sin datos: según su horario debería estar circulando y Renfe no publica nada de él (en la última estación por la que debería haber pasado)')}</span>
    <i style="border-radius:2px;background:rgba(236,131,90,.25);border:1.2px solid #ec835a"></i><span>${t('Aviso meteorológico (amarillo, naranja o rojo)')}</span>
    <i style="background:radial-gradient(circle,#ffd27a 25%,#ff5a1f 60%,transparent 75%)"></i><span>${t('Foco de calor por satélite')}</span>
    <i style="background:rgba(180,140,255,.25);border:1.5px solid #b48cff"></i><span>${t('Terremoto (tamaño = magnitud)')}</span>
    <i style="background:transparent;border:2.5px solid #ec835a"></i><span>${t('Alerta GDACS (naranja o roja)')}</span>
    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true"><circle cx="9" cy="9" r="7.9" fill="#0d0d0d" stroke="#ffd23f" stroke-width="1.4"/><path d="M10.4 3.2L5.6 10H8.7L7.6 14.8L12.4 7.7H9.3Z" fill="#ffd23f"/></svg><span>${t('Corte de luz (aviso oficial de protección civil, del 112 o del gobierno de la comunidad), en el centro de su isla, municipio, provincia o comunidad. <a href="/incidencias-y-emergencias#cortes-de-luz" target="_blank" rel="noopener">Cuándo sale un corte</a>')}</span>
    <svg viewBox="0 0 18 18" width="14" height="14" aria-hidden="true"><path d="M9 1.4L15.6 3.9V8.6C15.6 12.6 12.8 15.4 9 16.7C5.2 15.4 2.4 12.6 2.4 8.6V3.9Z" fill="#ec835a" stroke="#0d0d0d" stroke-width="1.4" stroke-linejoin="round"/><rect x="8.05" y="4.6" width="1.9" height="6" rx="0.9" fill="#0d0d0d"/><circle cx="9" cy="12.7" r="1.1" fill="#0d0d0d"/></svg><span>${t('Plan de emergencias activado (aviso oficial). Color = nivel: amarillo prealerta, naranja alerta, rojo emergencia')}</span>
    <i style="border-radius:2px;background:linear-gradient(90deg,#e8261c 33%,#f39c12 33% 66%,#1f6fd1 66%)"></i><span>${t('Área quemada (EFFIS): rojo, último día; naranja, 7 días; azul, 30 días. Púlsala para ver su ficha')}</span></div>
    </details>`;
}

// Casilla de «Mapa y avisos» que enseña cada incidencia en el mapa.
const EVENT_GROUP = { ferroviario: 'renfe-avisos', cancelacion: 'cancelaciones', 'sin-datos': 'sin-datos', meteo: 'meteo', incendio: 'incendios', sismo: 'sismos', catastrofe: 'gdacs', emergencia: 'emergencias' };
export const groupForEvent = (e) => (e.category === 'carretera' ? (e.type === 'roadMaintenance' ? 'obras' : 'dgt') : EVENT_GROUP[e.category]);

/**
 * Marca las casillas según lo que se ve en el mapa, sin volver a pintar el panel. Las que sólo
 * están encendidas por lo seleccionado (`forced`, claves «mode:x» o «group:x») se distinguen.
 */
export function syncLayers(el, prefs, forced = new Set()) {
  for (const input of el.querySelectorAll('input[data-mode], input[data-group]')) {
    const { mode, group } = input.dataset;
    input.checked = mode ? modeOn(prefs, mode) : group === 'obras' ? prefs.obras : groupOn(prefs, group);
    const temporal = forced.has(mode ? `mode:${mode}` : `group:${group}`);
    const label = input.closest('label');
    label?.classList.toggle('temporal', temporal);
    label?.setAttribute('title', temporal ? t('Encendida por lo que tienes seleccionado; se apagará al quitar la selección') : input.getAttribute('aria-label'));
  }
}

export function updateModeCounts(el, countsByMode) {
  for (const m of MODE_ITEMS) {
    const c = el.querySelector(`[data-count="${m}"]`);
    if (c) c.textContent = fmtNum(countsByMode[m] ?? 0);
  }
}
