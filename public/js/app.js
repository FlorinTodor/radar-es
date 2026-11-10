import { createMap } from './map.js';
import { connect } from './stream.js';
import { delayClass, esc } from './format.js';
import * as P from './panels.js';
import { stationBoard } from './station-board.js';
import * as S from './siguiendo.js';
import { loadTelegram, telegramLink } from './avisar.js';

// ---------- Estado ----------
const state = {
  vehicles: new Map(), // fuente → vehículos (los autobuses con la clave bus:<fuente>)
  counts: new Map(),   // sourceId → { modo: número }: incluye los autobuses aunque no se hayan pedido
  events: new Map(),   // sourceId → incidencias
  metrics: {},
  alerts: [],
  resolved: [],
  kpis: null,
  health: [],
  lineSources: [],
  tab: 'alerts',
  search: '',
  selected: new Map(), // 'tipo|id' → { kind, id }: alertas, incidencias y trenes marcados; el mapa muestra sólo eso
  multi: false,         // interruptor "Varias a la vez"
  forced: new Set(),    // 'mode:x' / 'group:y': capas que ha encendido lo marcado; se apagan al quitar la selección
  stations: new Map(),  // código → estación de Renfe o de otra red (para su ficha)
  lines: [],            // trazados de las líneas (para saber qué líneas pasan por cada estación)
  following: new Map(), // clave → cómo está lo que se sigue (/api/live/siguiendo); { error: true } si no se pudo pedir
  followingAt: 0,       // cuándo se pidió por última vez
};

const PREFS_KEY = 'radar-es:prefs';
const EVENT_CATS = P.EVENT_CATEGORIES.map(([id]) => id);
const prefs = Object.assign({ modes: {}, groups: {}, obras: false, eventCats: [...EVENT_CATS] }, readPrefs());
// Las categorías nuevas desde la última visita se ven aunque haya preferencias guardadas de antes
// (las de quien ya las conocía y las quitó siguen quitadas).
const knownCats = Array.isArray(prefs.knownCats) ? prefs.knownCats : ['ferroviario', 'carretera', 'meteo', 'incendio', 'sismo', 'catastrofe'];
if (!Array.isArray(prefs.eventCats)) prefs.eventCats = [...EVENT_CATS];
for (const c of EVENT_CATS) if (!knownCats.includes(c) && !prefs.eventCats.includes(c)) prefs.eventCats.push(c);
prefs.knownCats = EVENT_CATS;

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch { /* almacenamiento no disponible */ }
}

const allVehicles = () => [...state.vehicles.values()].flat();
const allEvents = () => [...state.events.values()].flat();
const findVehicle = (id) => allVehicles().find((v) => v.id === id);
const findEvent = (id) => allEvents().find((e) => e.id === id);

// ---------- Mapa ----------
const map = createMap('map', {
  onVehicleClick: (id) => selectVehicle(id),
  onEventClick: (id, at) => {
    const e = findEvent(id);
    if (e) map.showEvent(e, at);
  },
  onStationClick: (code) => openStation(code),
});

const boardFor = (st) => stationBoard(st, { vehicles: allVehicles(), events: allEvents(), lines: state.lines });
// Si el servidor tiene bot de Telegram, las fichas y la lista de «Siguiendo» llevan su botón (avisar.js).
loadTelegram().then(() => renderFollowing());

// Con ?debug en la URL se expone el mapa para inspeccionarlo desde la consola o en pruebas.
if (new URLSearchParams(location.search).has('debug')) window.radarDebug = { map, prefs };

map.ready.then(async () => {
  applyLayerPrefs();
  render('vehicles', 'events');
  try {
    const stations = await (await fetch('/api/stations')).json();
    for (const s of stations) state.stations.set(s.code, s);
    map.setStations(stations);
    const select = document.getElementById('station-network');
    select.insertAdjacentHTML('beforeend', P.stationNetworks(stations).map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join(''));
  } catch { /* sin estaciones no pasa nada */ }
  loadLines();
});

// La primera vez el servidor tarda en construir los trazados: reintenta unas cuantas veces.
async function loadLines(attempt = 0) {
  try {
    const lines = await (await fetch('/api/lines')).json();
    if (lines.features?.length) {
      state.lines = lines.features;
      // De dónde sale cada trazado y su fecha, para la pestaña Fuentes.
      fetch('/api/lines/sources').then((r) => r.json()).then((list) => { state.lineSources = Array.isArray(list) ? list : []; render('health'); }).catch(() => {});
      return map.setLines(lines);
    }
  } catch { /* reintenta */ }
  if (attempt < 10) setTimeout(() => loadLines(attempt + 1), 15_000);
}

// Capas que se ven: las del usuario más las que ha encendido lo marcado.
function layerState() {
  const s = { ...prefs, modes: { ...prefs.modes }, groups: { ...prefs.groups } };
  for (const key of state.forced) {
    const [type, name] = key.split(':');
    if (type === 'mode') s.modes[name] = true;
    else if (name === 'obras') s.obras = true;
    else s.groups[name] = true;
  }
  return s;
}

function applyLayerPrefs() {
  const s = layerState();
  map.setModes(P.MODE_ITEMS.filter((m) => P.modeOn(s, m)));
  for (const [g] of P.GROUP_ITEMS) if (g !== 'obras') map.setGroupVisible(g, P.groupOn(s, g));
  map.setObras(s.obras);
  watchTrails(P.groupOn(s, 'trails'));
  P.syncLayers(document.getElementById('layers-body'), s, state.forced);
}

// Estelas de todos los trenes: sólo se piden mientras la capa está activa.
let trailsTimer = null;
function watchTrails(on) {
  if (!on) {
    clearInterval(trailsTimer);
    trailsTimer = null;
    return map.setTrails(null);
  }
  if (trailsTimer) return;
  const load = () => fetch('/api/trails?min=15').then((r) => r.json()).then((fc) => map.setTrails(fc)).catch(() => {});
  load();
  trailsTimer = setInterval(load, 60_000);
}

// ---------- Render (agrupado por frame) ----------
const dirty = new Set();
let frame = null;
function render(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (!frame) frame = requestAnimationFrame(flush);
}

function flush() {
  frame = null;
  const parts = new Set(dirty);
  dirty.clear();

  if (parts.has('vehicles') || parts.has('alerts')) {
    const alertIds = new Set(state.alerts.flatMap((a) => [a.vehicleId, ...(a.vehicleIds ?? [])]).filter(Boolean));
    const vehicles = allVehicles();
    map.setVehicles(vehicles, alertIds);
    const selected = map.selectedVehicleId() && findVehicle(map.selectedVehicleId());
    if (selected) map.refreshVehicle(selected);
    const code = map.selectedStationCode();
    const station = stationDetails.get(code) ?? state.stations.get(code);
    if (station) map.refreshStation(station, boardFor(station));
    // El recuento lo da el servidor (cuenta los autobuses aunque no se hayan pedido); si no lo
    // trae, se cuentan los vehículos recibidos.
    const counts = {};
    if (state.counts.size) for (const c of state.counts.values()) for (const [m, n] of Object.entries(c)) counts[m] = (counts[m] ?? 0) + n;
    else for (const v of vehicles) counts[v.mode] = (counts[v.mode] ?? 0) + 1;
    P.updateModeCounts(document.getElementById('layers-body'), counts);
    if (state.tab === 'vehicles') renderVehiclesPanel(vehicles);
  }
  if (parts.has('events')) {
    const events = allEvents();
    map.setEvents(events);
    // El número de la pestaña, sin las que su fuente ya no publica (se ven desvaídas hasta medianoche): con ellas,
    // un día de huelga parecía el doble. Cuántas son, al pasar por encima.
    const shownEvents = P.filterEvents(events, prefs);
    const gone = shownEvents.filter((e) => e.withdrawn).length;
    const badge = document.getElementById('b-events');
    badge.textContent = shownEvents.length - gone;
    badge.title = gone ? `Y ${gone} que su fuente ya no publica (se ven desvaídas hasta medianoche)` : '';
    if (state.tab === 'events') P.renderEvents(document.getElementById('events-list'), P.filterEvents(events, prefs), selection('event'));
  }
  if (parts.has('alerts')) {
    document.getElementById('b-alerts').textContent = state.alerts.length;
    if (state.tab === 'alerts') P.renderAlerts(document.getElementById('panel-alerts'), state.alerts, state.resolved, selection('alert'));
  }
  if (parts.has('following') || parts.has('health')) renderFollowing();
  if (parts.has('kpis') || parts.has('alerts')) P.renderKpis(state.kpis, state.metrics, state.alerts.length);
  if (parts.has('health') && state.tab === 'sources') P.renderSources(document.getElementById('panel-sources'), state.health, state.lineSources);
  if (state.tab === 'stations' && (parts.has('stations') || parts.has('vehicles'))) renderStationsPanel();
}

// Buscador de estaciones: el número de cada una son los trenes parados en ella o que van hacia ella.
function renderStationsPanel() {
  const trainsByName = new Map();
  for (const v of allVehicles()) {
    const at = v.stopped ? v.current : v.next;
    if (at) trainsByName.set(P.stationKey(at), (trainsByName.get(P.stationKey(at)) ?? 0) + 1);
  }
  const query = document.getElementById('station-search').value;
  const network = document.getElementById('station-network').value;
  P.renderStations(document.getElementById('stations-list'), P.filterStations([...state.stations.values()], query, network), query, trainsByName, network);
}

/**
 * Abre la ficha de una estación; desde la lista, además lleva el mapa hasta ella. La lista sólo trae
 * lo básico: la ficha completa (foto, enlaces…) se pide al abrirla y se repinta cuando llega.
 */
const stationDetails = new Map();
async function openStation(code, fly = false) {
  const st = state.stations.get(code);
  if (!st) return;
  // Como con los trenes de las listas: si la capa de estaciones está apagada, se enciende (y se marca
  // en Capas) para que se vea la estación; vuelve a como estaba al marcar otra cosa o al tocar la casilla.
  if (!onInPrefs('group:stations') && !state.forced.has('group:stations')) {
    state.forced.add('group:stations');
    applyLayerPrefs();
  }
  map.showStation(stationDetails.get(code) ?? st, boardFor(st));
  if (fly) map.flyTo(st.lon, st.lat, 14);
  if (stationDetails.has(code)) return;
  try {
    const res = await fetch(`/api/stations/${encodeURIComponent(code)}`);
    if (!res.ok) return;
    stationDetails.set(code, await res.json());
    map.refreshStation(stationDetails.get(code), boardFor(st));
  } catch { /* sin detalle: se queda la ficha básica */ }
}

// La lista y el buscador no dependen de las capas activas: se puede buscar cualquier tren y, al
// pulsarlo, el mapa lo muestra y enciende su capa si estaba apagada. Los autobuses, sólo con su capa activa.
function renderVehiclesPanel(all = allVehicles()) {
  const vehicles = all.filter((v) => v.mode !== 'bus' || P.modeOn(prefs, 'bus'));
  P.renderVehicles(document.getElementById('vehicles-list'), P.filterVehicles(vehicles, state.search), vehicles.length, selection('vehicle'));
}

// ---------- Datos en tiempo real ----------
// Vehículos por fuente; los autobuses con la clave `bus:<fuente>`, porque llegan en otra consulta.
const bySource = (list, prefix = '') => {
  const out = new Map();
  for (const v of list) {
    const key = prefix + v.source;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ ...v, cls: delayClass(v) });
  }
  return out;
};
const replaceVehicles = (isBus, fresh) => {
  for (const key of [...state.vehicles.keys()]) if (key.startsWith('bus:') === isBus) state.vehicles.delete(key);
  for (const [key, list] of fresh) state.vehicles.set(key, list);
};

const stream = connect({
  status(s, ageMs) {
    const el = document.getElementById('live');
    el.dataset.state = s;
    el.querySelector('.txt').textContent = s === 'live' ? 'En directo'
      : s === 'stale' ? `Datos de hace ${Math.round(ageMs / 60_000)} min`
        : s === 'updating' ? 'Actualizando…'
          : s === 'error' ? 'Sin conexión' : 'Reconectando…';
    // Una actualización del servidor (unos segundos): que nadie se asuste, vuelve solo.
    document.getElementById('updating').hidden = s !== 'updating';
  },
  live(d) {
    replaceVehicles(false, bySource(d.vehicles));
    state.counts = new Map(Object.entries(d.counts ?? {}));
    Object.assign(state, { metrics: d.metrics, alerts: d.alerts, resolved: d.resolved, kpis: d.kpis });
    if (state.selected.size) applyFocus(); // quita lo marcado que ya no existe
    render('vehicles', 'alerts', 'kpis');
    tryPendingFollow();
  },
  events(d) {
    state.events.clear();
    for (const e of d.events) {
      if (!state.events.has(e.source)) state.events.set(e.source, []);
      state.events.get(e.source).push(e);
    }
    if (state.selected.size) applyFocus();
    render('events');
  },
  buses(d) {
    replaceVehicles(true, d ? bySource(d.vehicles, 'bus:') : new Map());
    if (state.selected.size) applyFocus();
    render('vehicles');
    tryPendingFollow();
  },
  health(h) {
    state.health = h;
    map.setSources(h);
    render('health');
  },
}, { buses: P.modeOn(prefs, 'bus') });

// ---------- Interacción ----------
function selectVehicle(id) {
  const v = findVehicle(id);
  if (!v) return;
  map.showVehicle(v); // primero la ficha, para que el encuadre le deje hueco
  map.flyTo(v.lon, v.lat, 10);
}

function selectEvent(id) {
  const e = findEvent(id);
  if (!e) return;
  // La ficha también sin ubicación (una cancelación sin horario, un aviso que no nombra estación): lo que se sabe.
  map.showEvent(e);
  // Una cancelación o un tren sin datos: todo su viaje en el encuadre.
  const trip = e.category === 'cancelacion' || e.category === 'sin-datos';
  const stops = trip ? (e.trip?.stops ?? []).filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat)) : [];
  if (stops.length > 1) return map.fitTo(stops.map((s) => [s.lon, s.lat]));
  if (e.lat === null || e.lat === undefined) return;
  map.flyTo(e.lon, e.lat, e.category === 'sismo' || e.category === 'meteo' ? 7 : 10);
}

// ---------- Selección (Alertas, Incidencias y Vehículos) ----------
// Clic en un elemento de cualquier lista: el mapa muestra sólo eso y enciende (y marca en Capas)
// las capas que necesita; clic en otro lo sustituye y en el mismo vuelve a tus capas. Lo que se
// cambie en Capas mientras tanto se aplica sin perder la selección y se guarda. Con "Varias a la
// vez" cada clic suma o quita, y se pueden mezclar alertas, incidencias y trenes. Todo con clics.
const KIND_LABEL = { alert: ['alerta', 'alertas'], event: ['incidencia', 'incidencias'], vehicle: ['vehículo', 'vehículos'], bus: ['autobús', 'autobuses'] };

function selection(kind) {
  const ids = new Set([...state.selected.values()].filter((x) => x.kind === kind).map((x) => x.id));
  return { ids, total: state.selected.size, multi: state.multi };
}

function selectItem(kind, id) {
  const key = `${kind}|${id}`;
  const sel = state.selected;
  if (state.multi) {
    if (sel.has(key)) sel.delete(key);
    else sel.set(key, { kind, id });
  } else if (sel.size === 1 && sel.has(key)) {
    sel.clear();
  } else {
    state.selected = new Map([[key, { kind, id }]]);
  }
  // Se encienden las capas de lo recién marcado; las que sólo hacían falta para lo que se ha
  // quitado vuelven a como estaban. Si el usuario ha apagado una, no se le vuelve a encender.
  const alertsById = new Map(state.alerts.map((a) => [a.id, a]));
  const needed = layersFor(focusIds([...state.selected.values()], alertsById));
  for (const k of state.forced) if (!needed.has(k)) state.forced.delete(k);
  // Sólo cuentan como temporales las que estaban apagadas: las que ya tenías encendidas siguen igual.
  if (state.selected.has(key)) {
    for (const k of layersFor(focusIds([{ kind, id }], alertsById))) if (!onInPrefs(k)) state.forced.add(k);
  }
  applyLayerPrefs();
  applyFocus({ fit: true });
}

/** ¿Está encendida en tus preferencias la casilla «mode:x» o «group:x»? */
function onInPrefs(key) {
  const [type, name] = key.split(':');
  return type === 'mode' ? P.modeOn(prefs, name) : name === 'obras' ? prefs.obras : P.groupOn(prefs, name);
}

// Trenes e incidencias que muestra lo marcado (una alerta trae los suyos).
function focusIds(items, alertsById) {
  const vehicleIds = new Set();
  const eventIds = new Set();
  for (const { kind, id } of items) {
    if (kind === 'vehicle') vehicleIds.add(id);
    else if (kind === 'event') eventIds.add(id);
    else {
      const a = alertsById.get(id);
      if (!a) continue;
      [a.vehicleId, ...(a.vehicleIds ?? [])].filter(Boolean).forEach((v) => vehicleIds.add(v));
      (a.eventIds ?? []).forEach((e) => eventIds.add(e));
    }
  }
  return { vehicleIds, eventIds };
}

// Casillas de Capas que hacen falta para verlos.
function layersFor({ vehicleIds, eventIds }) {
  const keys = new Set();
  for (const id of vehicleIds) {
    const v = findVehicle(id);
    if (v && P.MODE_ITEMS.includes(v.mode)) keys.add(`mode:${v.mode}`);
  }
  for (const id of eventIds) {
    const group = findEvent(id) && P.groupForEvent(findEvent(id));
    if (group) keys.add(`group:${group}`);
  }
  return keys;
}

function clearFocus() {
  state.selected.clear();
  applyFocus();
}

function applyFocus({ fit = false } = {}) {
  const alertsById = new Map(state.alerts.map((a) => [a.id, a]));
  const exists = { alert: (id) => alertsById.has(id), event: (id) => !!findEvent(id), vehicle: (id) => !!findVehicle(id) };
  let gone = false;
  for (const [key, { kind, id }] of state.selected) {
    if (!exists[kind](id)) { state.selected.delete(key); gone = true; } // ya no existe
  }
  const items = [...state.selected.values()];
  // Si algo marcado ha desaparecido, las capas que sólo encendía él vuelven a como estaban.
  if (gone && items.length) {
    const needed = layersFor(focusIds(items, alertsById));
    const before = state.forced.size;
    for (const k of state.forced) if (!needed.has(k)) state.forced.delete(k);
    if (state.forced.size !== before) applyLayerPrefs();
  }

  // El aviso va antes del encuadre: en el móvil está abajo y el encuadre le deja hueco.
  const counts = {};
  for (const { kind, id } of items) {
    const k = kind === 'vehicle' && findVehicle(id)?.mode === 'bus' ? 'bus' : kind;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${KIND_LABEL[k][n === 1 ? 0 : 1]}`).join(', ');
  const banner = document.getElementById('focus-banner');
  banner.hidden = !items.length;
  banner.querySelector('.txt').textContent = `Mostrando sólo: ${summary}`;

  if (!items.length) {
    state.forced.clear();
    map.setFocus(null);
    applyLayerPrefs();
  } else {
    const { vehicleIds, eventIds } = focusIds(items, alertsById);
    map.setFocus({ vehicleIds: [...vehicleIds], eventIds: [...eventIds] });
    if (fit) fitSelection(items, alertsById, vehicleIds, eventIds);
  }
  render('alerts', 'events', 'vehicles');
}

function fitSelection(items, alertsById, vehicleIds, eventIds) {
  if (items.length === 1) {
    const { kind, id } = items[0];
    if (kind === 'vehicle') return selectVehicle(id);
    if (kind === 'event') return selectEvent(id);
    const a = alertsById.get(id);
    if (a.vehicleId && findVehicle(a.vehicleId)) return selectVehicle(a.vehicleId);
  }
  const points = [
    ...items.filter((x) => x.kind === 'alert').map((x) => alertsById.get(x.id)).filter((a) => a.lon !== undefined && a.lat !== undefined).map((a) => [a.lon, a.lat]),
    ...[...vehicleIds].map(findVehicle).filter(Boolean).map((v) => [v.lon, v.lat]),
    ...[...eventIds].map(findEvent).filter((e) => e?.lat !== null && e?.lat !== undefined).map((e) => [e.lon, e.lat]),
  ];
  map.fitTo(points);
}

document.querySelector('.sidebar').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action=clear-focus]')) return clearFocus();
  const unfollow = ev.target.closest('[data-follow-remove]');
  if (unfollow) return setFollowed({ key: unfollow.dataset.followRemove }, false);
  const followed = ev.target.closest('[data-follow-open]');
  if (followed) {
    openFollowed(followed.dataset.followOpen);
    if (mobile.matches) setSheet('peek');
    return;
  }
  const station = ev.target.closest('[data-station]');
  if (station) {
    openStation(station.dataset.station, true);
    if (mobile.matches) setSheet('peek');
    return;
  }
  const item = ev.target.closest('[data-kind]');
  if (!item) return;
  selectItem(item.dataset.kind, item.dataset.id);
  // En el móvil la hoja tapa el mapa: se baja para ver lo elegido (salvo eligiendo varias).
  if (mobile.matches && !state.multi && state.selected.size) setSheet('peek');
});
document.querySelector('.sidebar').addEventListener('change', (ev) => {
  if (ev.target.dataset.action !== 'multi') return;
  state.multi = ev.target.checked;
  render('alerts', 'events', 'vehicles');
});
document.getElementById('focus-banner').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action=clear-focus]')) clearFocus();
});

// Si las pestañas no caben, la fila se desliza: el borde derecho se desvanece mientras quedan más a la
// derecha, y la rueda del ratón (vertical) también la desliza.
const tabsEl = document.querySelector('.tabs');
const markMoreTabs = () => tabsEl.classList.toggle('more', tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 2);
tabsEl.addEventListener('scroll', markMoreTabs, { passive: true });
window.addEventListener('resize', markMoreTabs);
tabsEl.addEventListener('wheel', (ev) => {
  if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX) || tabsEl.scrollWidth <= tabsEl.clientWidth) return;
  tabsEl.scrollLeft += ev.deltaY;
  ev.preventDefault();
}, { passive: false });

function showTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    if (b.dataset.tab === tab) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  markMoreTabs();
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${tab}`;
  render(tab === 'sources' ? 'health' : tab);
  if (tab === 'following') refreshFollowing();
}
document.querySelector('.tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-tab]');
  if (!btn) return;
  showTab(btn.dataset.tab);
  if (mobile.matches && sidebar.dataset.sheet === 'peek') setSheet('half');
});

// ---------- Móvil: el panel es una hoja que sube desde abajo ----------
// Tres alturas: sólo las pestañas, media pantalla y pantalla completa. Se cambia tocando el asa
// o una pestaña, o arrastrando el asa; en el escritorio no hace nada (el CSS la ignora).
const mobile = window.matchMedia('(max-width: 860px)');
const sidebar = document.querySelector('.sidebar');
const sheetHandle = document.getElementById('sheet-handle');
const SHEET_HALF = 0.55; // fracción de la zona bajo la barra superior; igual que en el CSS

function setSheet(stop) {
  sidebar.dataset.sheet = stop;
  sheetHandle.setAttribute('aria-expanded', String(stop !== 'peek'));
  sheetHandle.setAttribute('aria-label', stop === 'peek' ? 'Abrir el panel' : 'Bajar el panel');
}
setSheet('peek');

let sheetDrag = null;
let sheetDragEnd = 0;
sheetHandle.addEventListener('pointerdown', (ev) => {
  if (!mobile.matches) return;
  sheetDrag = { y: ev.clientY, h: sidebar.offsetHeight, moved: false };
  sheetHandle.setPointerCapture(ev.pointerId);
});
sheetHandle.addEventListener('pointermove', (ev) => {
  if (!sheetDrag) return;
  const dy = sheetDrag.y - ev.clientY;
  if (!sheetDrag.moved && Math.abs(dy) < 6) return;
  sheetDrag.moved = true;
  sidebar.classList.add('dragging');
  sidebar.style.height = `${Math.min(sidebar.parentElement.clientHeight, Math.max(0, sheetDrag.h + dy))}px`;
});
const endSheetDrag = () => {
  if (!sheetDrag) return;
  const { moved } = sheetDrag;
  sheetDrag = null;
  if (!moved) return; // ha sido un toque: lo resuelve el evento click
  const h = sidebar.offsetHeight;
  const max = sidebar.parentElement.clientHeight;
  const stops = { peek: parseFloat(getComputedStyle(sidebar).minHeight) || 0, half: max * SHEET_HALF, full: max };
  const nearest = Object.keys(stops).reduce((a, b) => (Math.abs(stops[b] - h) < Math.abs(stops[a] - h) ? b : a));
  sidebar.classList.remove('dragging');
  sidebar.style.height = '';
  setSheet(nearest);
  sheetDragEnd = Date.now();
};
sheetHandle.addEventListener('pointerup', endSheetDrag);
sheetHandle.addEventListener('pointercancel', endSheetDrag);
sheetHandle.addEventListener('click', () => {
  if (Date.now() - sheetDragEnd < 400) return; // el click que sigue a soltar un arrastre
  setSheet(sidebar.dataset.sheet === 'peek' ? 'half' : 'peek');
});
// Al escribir en un buscador el teclado tapa media pantalla: se sube la hoja entera.
for (const id of ['vehicle-search', 'station-search']) {
  document.getElementById(id).addEventListener('focus', () => {
    if (mobile.matches) setSheet('full');
  });
}
let stationTimer = null;
document.getElementById('station-search').addEventListener('input', () => {
  clearTimeout(stationTimer);
  stationTimer = setTimeout(renderStationsPanel, 150);
});
document.getElementById('station-network').addEventListener('change', renderStationsPanel);

let searchTimer = null;
document.getElementById('vehicle-search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = ev.target.value;
    renderVehiclesPanel();
  }, 150);
});

const filtersEl = document.getElementById('event-filters');
P.renderEventFilters(filtersEl, prefs);
filtersEl.addEventListener('click', (ev) => {
  const chip = ev.target.closest('[data-cat]');
  if (!chip) return;
  const cat = chip.dataset.cat;
  if (cat === 'obras') {
    prefs.obras = !prefs.obras;
    state.forced.delete('group:obras');
    applyLayerPrefs();
  } else {
    prefs.eventCats = prefs.eventCats.includes(cat) ? prefs.eventCats.filter((c) => c !== cat) : [...prefs.eventCats, cat];
  }
  savePrefs();
  P.renderEventFilters(filtersEl, prefs);
  render('events');
});

const layersBody = document.getElementById('layers-body');
P.renderLayers(layersBody, prefs, {});
// Lo marcado en Alertas, Incidencias o Vehículos se mantiene: la casilla decide si se ve su capa,
// y pasa a ser una preferencia del usuario (ya no se apaga al quitar la selección).
function layersChanged(inputs) {
  for (const input of inputs) {
    state.forced.delete(layerKey(input));
    if (input.dataset.mode) prefs.modes[input.dataset.mode] = input.checked;
    if (input.dataset.mode === 'bus') stream.setBuses(input.checked);
    if (input.dataset.group === 'obras') {
      prefs.obras = input.checked;
      P.renderEventFilters(filtersEl, prefs);
      render('events');
    } else if (input.dataset.group) {
      prefs.groups[input.dataset.group] = input.checked;
    }
  }
  savePrefs();
  applyLayerPrefs();
  if (inputs.some((i) => i.dataset.mode) && state.tab === 'vehicles') renderVehiclesPanel();
}
layersBody.addEventListener('change', (ev) => layersChanged([ev.target]));
// "Todas · Ninguna" de cada sección: cambia las casillas que no estaban ya así y también las que
// sólo estaban encendidas por lo seleccionado, para que queden guardadas como preferencia.
const layerKey = (input) => (input.dataset.mode ? `mode:${input.dataset.mode}` : `group:${input.dataset.group}`);
layersBody.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-bulk]');
  if (!btn) return;
  const on = btn.dataset.on === '1';
  const inputs = [...layersBody.querySelectorAll(`input[data-${btn.dataset.bulk}]`)]
    .filter((i) => i.checked !== on || state.forced.has(layerKey(i)));
  for (const input of inputs) input.checked = on;
  if (inputs.length) layersChanged(inputs);
});

const layersToggle = document.getElementById('layers-toggle');
layersToggle.addEventListener('click', () => {
  const open = layersToggle.getAttribute('aria-expanded') !== 'true';
  layersToggle.setAttribute('aria-expanded', String(open));
  layersBody.hidden = !open;
  document.getElementById('layers').classList.toggle('collapsed', !open);
});
if (window.matchMedia('(max-width: 860px)').matches) layersToggle.click();

// Aviso de datos que faltan: se muestra al entrar hasta que se acepta. Si cambia el texto,
// sube NOTICE_VERSION para que vuelva a aparecer a todo el mundo.
const NOTICE_KEY = 'radar-es:aviso-cobertura';
const NOTICE_VERSION = '2026-11-02';
const notice = document.getElementById('notice');
document.getElementById('open-notice').addEventListener('click', () => notice.showModal());
notice.addEventListener('close', () => {
  try {
    localStorage.setItem(NOTICE_KEY, NOTICE_VERSION);
  } catch { /* almacenamiento no disponible: volverá a salir la próxima vez */ }
});
let noticeSeen = null;
try {
  noticeSeen = localStorage.getItem(NOTICE_KEY);
} catch { /* almacenamiento no disponible */ }
if (noticeSeen !== NOTICE_VERSION) notice.showModal();

// ---------- Siguiendo (lo que cada cual marca con la estrella; ver siguiendo.js) ----------
// El estado de cada cosa se pide por su clave a /api/live/siguiendo: así se sabe también el de una línea de
// autobuses con su capa apagada sin descargarlos todos. Mientras se mira la lista, cada medio minuto; si no,
// cada dos (para el aviso de la pestaña). Cloudflare guarda cada respuesta unos segundos para todos.
const FOLLOW_REFRESH_MS = 30_000;
const FOLLOW_IDLE_MS = 120_000;
const FOLLOW_PARALLEL = 4;
const followedVehicles = (key) => allVehicles().filter((v) => v.follow?.includes(key));

function renderFollowing() {
  const items = S.follows.list();
  const badge = document.getElementById('b-following');
  const attention = S.followAttention(items, state.following);
  badge.textContent = items.length;
  badge.classList.toggle('warn', attention > 0);
  markMoreTabs(); // el número cambia el ancho de la pestaña
  badge.title = attention ? `${attention} con cancelaciones o sin datos` : '';
  if (state.tab !== 'following') return;
  document.getElementById('panel-following').innerHTML = S.followingHtml(items, state.following, {
    sourceCredit: (id, operator) => {
      const s = state.health.find((h) => h.id === id);
      return s ? (s.operatorLicenses?.[operator] ?? s.license ?? s.name) : null;
    },
    // Sus vehículos no han llegado al navegador porque su capa va aparte y está apagada (los autobuses).
    needsLayer: (item, status) => {
      const mode = status?.mode ?? item.mode;
      if (!status?.vehicles?.total || !mode || followedVehicles(item.key).length || P.modeOn(prefs, mode)) return null;
      return S.modeInfo(mode)?.label ?? null;
    },
    telegram: (item) => telegramLink(item.key, item.name),
  });
}

// Una consulta a la vez (al cargar, abrir la pestaña y el arranque la pedían dos veces): si llega otra forzada
// mientras tanto (se acaba de seguir algo), se repite al terminar.
let followingBusy = null;
let followingAgain = false;
const FOLLOW_MIN_MS = 15_000; // entrar y salir de la pestaña no lo vuelve a pedir todo cada vez

function refreshFollowing({ force = false } = {}) {
  if (followingBusy) {
    if (force) followingAgain = true;
    return followingBusy;
  }
  if (document.hidden && !force) return;
  if (!force && Date.now() - state.followingAt < (state.tab === 'following' ? FOLLOW_MIN_MS : FOLLOW_IDLE_MS)) return;
  followingBusy = fetchFollowing().finally(() => {
    followingBusy = null;
    if (followingAgain) {
      followingAgain = false;
      refreshFollowing({ force: true });
    }
  });
  return followingBusy;
}

async function fetchFollowing() {
  state.followingAt = Date.now();
  const keys = S.follows.list().filter((i) => i.kind !== 'parada').map((i) => i.key);
  for (const key of [...state.following.keys()]) if (!keys.includes(key)) state.following.delete(key);
  const queue = [...keys];
  const worker = async () => {
    while (queue.length) {
      const key = queue.shift();
      try {
        const res = await fetch(`/api/live/siguiendo?clave=${encodeURIComponent(key)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        state.following.set(key, await res.json());
      } catch {
        // Se queda lo de la vez anterior; si no había nada, se dice que no se pudo.
        if (!state.following.has(key)) state.following.set(key, { error: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FOLLOW_PARALLEL, keys.length) }, worker));
  render('following');
}
setInterval(() => refreshFollowing(), FOLLOW_REFRESH_MS);

/** Sigue o deja de seguir algo y pone igual todos sus botones (en la ficha abierta y en la lista). */
function setFollowed(item, on) {
  if (on) S.follows.add(item);
  else S.follows.remove(item.key);
  const now = S.follows.has(item.key);
  for (const b of document.querySelectorAll('[data-follow]')) {
    if (b.dataset.follow !== item.key) continue;
    b.setAttribute('aria-pressed', String(now));
    b.innerHTML = S.followButtonText(b.dataset.followWhat, now);
    b.title = on && !now && S.follows.full ? `Ya sigues ${S.FOLLOW_MAX} cosas: deja de seguir alguna para añadir otra` : b.dataset.followName;
    // En el móvil no hay `title`: el aviso del tope, también escrito debajo de los botones.
    const group = b.closest('.follow');
    if (group && on && !now && S.follows.full && !group.querySelector('.follow-full')) {
      group.insertAdjacentHTML('beforeend', `<p class="follow-full" role="status">Ya sigues ${S.FOLLOW_MAX} cosas: deja de seguir alguna en «★ Siguiendo» para añadir otra.</p>`);
    }
  }
  if (!now) state.following.delete(item.key);
  render('following');
  if (now) refreshFollowing({ force: true });
}
// Los botones de las fichas del mapa (fuera del panel lateral).
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-follow]');
  if (!btn) return;
  setFollowed({ key: btn.dataset.follow, name: btn.dataset.followName, mode: btn.dataset.followMode || null }, !S.follows.has(btn.dataset.follow));
});
// Otra pestaña del mismo navegador ha cambiado lo que se sigue.
window.addEventListener('storage', (ev) => {
  if (ev.key !== S.FOLLOW_STORE_KEY) return;
  S.follows.reload();
  render('following');
  refreshFollowing({ force: true });
});

/** El mapa enseña sólo esto (como al pulsarlo en una lista), con sus capas encendidas y encuadrado. */
function focusOn(items) {
  state.selected = new Map(items.map((x) => [`${x.kind}|${x.id}`, x]));
  const alertsById = new Map(state.alerts.map((a) => [a.id, a]));
  const needed = layersFor(focusIds(items, alertsById));
  for (const k of state.forced) if (!needed.has(k)) state.forced.delete(k);
  for (const k of needed) if (!onInPrefs(k)) state.forced.add(k);
  applyLayerPrefs();
  applyFocus({ fit: true });
}

// Lo seguido cuyos vehículos aún no han llegado (se acaba de encender su capa): se enseña cuando lleguen.
let pendingFollow = null;
function tryPendingFollow() {
  if (!pendingFollow) return;
  if (Date.now() > pendingFollow.until) {
    pendingFollow = null;
    return;
  }
  const mine = followedVehicles(pendingFollow.key);
  if (!mine.length) return;
  pendingFollow = null;
  focusOn(mine.map((v) => ({ kind: 'vehicle', id: v.id })));
}

/** Enciende la capa de un tipo de vehículo como si se marcara su casilla (y así llegan sus vehículos). */
function turnOnLayer(mode) {
  const input = layersBody.querySelector(`input[data-mode="${CSS.escape(mode)}"]`);
  if (!input) return false;
  if (!input.checked) {
    input.checked = true;
    layersChanged([input]);
  }
  return true;
}

/** Pulsar algo de la lista: sus vehículos en el mapa; si no se ve ninguno, sus cancelaciones; una estación, su ficha. */
function openFollowed(key) {
  const item = S.follows.list().find((i) => i.key === key);
  if (!item) return;
  if (item.kind === 'parada') return openStation(S.stopCode(key), true);
  const mine = followedVehicles(key);
  if (mine.length) return focusOn(mine.map((v) => ({ kind: 'vehicle', id: v.id })));
  const status = state.following.get(key);
  const mode = status?.mode ?? item.mode;
  if (status?.vehicles?.total && mode && !P.modeOn(prefs, mode) && turnOnLayer(mode)) {
    pendingFollow = { key, until: Date.now() + 60_000 };
    return;
  }
  const events = (status?.events?.list ?? []).filter((e) => !e.withdrawn && findEvent(e.id));
  if (events.length) focusOn(events.map((e) => ({ kind: 'event', id: e.id })));
}

// Quien ya sigue algo entra directamente en su lista.
if (S.follows.size) showTab('following');
else render('following');
refreshFollowing({ force: true });

// Refresca los "hace X min" aunque no lleguen datos nuevos.
setInterval(() => render('alerts', state.tab === 'sources' ? 'health' : 'kpis'), 15_000);
