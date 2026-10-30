import { createMap } from './map.js';
import { connect } from './stream.js';
import { delayClass } from './format.js';
import * as P from './panels.js';

// ---------- Estado ----------
const state = {
  vehicles: new Map(), // sourceId → vehículos
  events: new Map(),   // sourceId → incidencias
  metrics: {},
  alerts: [],
  resolved: [],
  kpis: null,
  health: [],
  tab: 'alerts',
  search: '',
  selected: new Map(), // 'tipo|id' → { kind, id }: alertas, incidencias y trenes marcados; el mapa muestra sólo eso
  multi: false,         // interruptor "Varias a la vez"
};

const PREFS_KEY = 'radar-es:prefs';
const prefs = Object.assign(
  { modes: {}, groups: {}, obras: false, eventCats: ['ferroviario', 'carretera', 'meteo', 'incendio', 'sismo', 'catastrofe'] },
  readPrefs(),
);

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
});

// Con ?debug en la URL se expone el mapa para inspeccionarlo desde la consola o en pruebas.
if (new URLSearchParams(location.search).has('debug')) window.radarDebug = { map, prefs };

map.ready.then(async () => {
  applyLayerPrefs();
  render('vehicles', 'events');
  try {
    map.setStations(await (await fetch('/api/stations')).json());
  } catch { /* sin estaciones no pasa nada */ }
  loadLines();
});

// La primera vez el servidor tarda en construir los trazados: reintenta unas cuantas veces.
async function loadLines(attempt = 0) {
  try {
    const lines = await (await fetch('/api/lines')).json();
    if (lines.features?.length) return map.setLines(lines);
  } catch { /* reintenta */ }
  if (attempt < 10) setTimeout(() => loadLines(attempt + 1), 15_000);
}

function applyLayerPrefs() {
  map.setModes(P.MODE_ITEMS.filter((m) => P.modeOn(prefs, m)));
  for (const [g] of P.GROUP_ITEMS) if (g !== 'obras') map.setGroupVisible(g, P.groupOn(prefs, g));
  map.setObras(prefs.obras);
  watchTrails(P.groupOn(prefs, 'trails'));
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
    const counts = {};
    for (const v of vehicles) counts[v.mode] = (counts[v.mode] ?? 0) + 1;
    P.updateModeCounts(document.getElementById('layers-body'), counts);
    if (state.tab === 'vehicles') renderVehiclesPanel(vehicles);
  }
  if (parts.has('events')) {
    const events = allEvents();
    map.setEvents(events);
    document.getElementById('b-events').textContent = P.filterEvents(events, prefs).length;
    if (state.tab === 'events') P.renderEvents(document.getElementById('events-list'), P.filterEvents(events, prefs), selection('event'));
  }
  if (parts.has('alerts')) {
    document.getElementById('b-alerts').textContent = state.alerts.length;
    if (state.tab === 'alerts') P.renderAlerts(document.getElementById('panel-alerts'), state.alerts, state.resolved, selection('alert'));
  }
  if (parts.has('kpis') || parts.has('alerts')) P.renderKpis(state.kpis, state.metrics, state.alerts.length);
  if (parts.has('health') && state.tab === 'sources') P.renderSources(document.getElementById('panel-sources'), state.health);
}

// La lista y el buscador no dependen de las capas activas: se puede buscar cualquier tren y, al
// pulsarlo, el mapa lo muestra aunque su capa esté apagada. Los autobuses, sólo con su capa activa.
function renderVehiclesPanel(all = allVehicles()) {
  const vehicles = all.filter((v) => v.mode !== 'bus' || P.modeOn(prefs, 'bus'));
  P.renderVehicles(document.getElementById('vehicles-list'), P.filterVehicles(vehicles, state.search), vehicles.length, selection('vehicle'));
}

// ---------- Datos en tiempo real ----------
const withClass = (list) => list.map((v) => ({ ...v, cls: delayClass(v) }));

connect({
  status(s) {
    const el = document.getElementById('live');
    el.dataset.state = s;
    el.querySelector('.txt').textContent = s === 'live' ? 'En directo' : s === 'error' ? 'Sin conexión' : 'Reconectando…';
  },
  snapshot(snap) {
    state.vehicles.clear();
    state.events.clear();
    for (const v of snap.vehicles) {
      if (!state.vehicles.has(v.source)) state.vehicles.set(v.source, []);
      state.vehicles.get(v.source).push({ ...v, cls: delayClass(v) });
    }
    for (const e of snap.events) {
      if (!state.events.has(e.source)) state.events.set(e.source, []);
      state.events.get(e.source).push(e);
    }
    Object.assign(state, { metrics: snap.metrics, alerts: snap.alerts, resolved: snap.resolved, health: snap.health, kpis: snap.kpis.current });
    render('vehicles', 'events', 'alerts', 'kpis', 'health');
  },
  source(p) {
    if (p.kind === 'vehicles') {
      state.vehicles.set(p.id, withClass(p.items));
      if (state.selected.size) applyFocus(); // quita lo marcado que ya no existe
      render('vehicles');
    } else if (p.kind === 'events') {
      state.events.set(p.id, p.items);
      if (state.selected.size) applyFocus();
      render('events');
    } else if (p.kind === 'metrics') {
      state.metrics[p.id] = p.metrics;
      render('kpis');
    }
  },
  health(h) {
    state.health = h;
    render('health');
  },
  alerts({ alerts, kpis, resolved }) {
    Object.assign(state, { alerts, kpis, resolved });
    if (state.selected.size) applyFocus(); // los trenes de una alerta pueden cambiar
    render('alerts', 'kpis');
  },
});

// ---------- Interacción ----------
function selectVehicle(id) {
  const v = findVehicle(id);
  if (!v) return;
  map.showVehicle(v); // primero la ficha, para que el encuadre le deje hueco
  map.flyTo(v.lon, v.lat, 10);
}

function selectEvent(id) {
  const e = findEvent(id);
  if (!e || e.lat === null || e.lat === undefined) return;
  map.showEvent(e);
  map.flyTo(e.lon, e.lat, e.category === 'sismo' || e.category === 'meteo' ? 7 : 10);
}

// ---------- Selección (Alertas, Incidencias y Trenes) ----------
// Clic en un elemento de cualquier lista: el mapa muestra sólo eso, aunque su capa estuviera
// apagada; clic en otro lo sustituye y en el mismo vuelve a tus capas. Con "Varias a la vez"
// cada clic suma o quita, y se pueden mezclar alertas, incidencias y trenes. Todo con clics.
const KIND_LABEL = { alert: ['alerta', 'alertas'], event: ['incidencia', 'incidencias'], vehicle: ['tren', 'trenes'] };

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
  applyFocus({ fit: true });
}

function clearFocus() {
  state.selected.clear();
  applyFocus();
}

function applyFocus({ fit = false } = {}) {
  const alertsById = new Map(state.alerts.map((a) => [a.id, a]));
  const exists = { alert: (id) => alertsById.has(id), event: (id) => !!findEvent(id), vehicle: (id) => !!findVehicle(id) };
  for (const [key, { kind, id }] of state.selected) if (!exists[kind](id)) state.selected.delete(key); // ya no existe
  const items = [...state.selected.values()];

  if (!items.length) {
    map.setFocus(null);
    applyLayerPrefs();
  } else {
    const vehicleIds = new Set();
    const eventIds = new Set();
    for (const { kind, id } of items) {
      if (kind === 'vehicle') vehicleIds.add(id);
      else if (kind === 'event') eventIds.add(id);
      else {
        const a = alertsById.get(id);
        [a.vehicleId, ...(a.vehicleIds ?? [])].filter(Boolean).forEach((v) => vehicleIds.add(v));
        (a.eventIds ?? []).forEach((e) => eventIds.add(e));
      }
    }
    map.setFocus({ vehicleIds: [...vehicleIds], eventIds: [...eventIds] });
    if (fit) fitSelection(items, alertsById, vehicleIds, eventIds);
  }

  const counts = {};
  for (const { kind } of items) counts[kind] = (counts[kind] ?? 0) + 1;
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${KIND_LABEL[k][n === 1 ? 0 : 1]}`).join(', ');
  const banner = document.getElementById('focus-banner');
  banner.hidden = !items.length;
  banner.querySelector('.txt').textContent = `Mostrando sólo: ${summary}`;
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
  const item = ev.target.closest('[data-kind]');
  if (item) selectItem(item.dataset.kind, item.dataset.id);
});
document.querySelector('.sidebar').addEventListener('change', (ev) => {
  if (ev.target.dataset.action !== 'multi') return;
  state.multi = ev.target.checked;
  render('alerts', 'events', 'vehicles');
});
document.getElementById('focus-banner').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action=clear-focus]')) clearFocus();
});

document.querySelector('.tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-tab]');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b === btn));
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `panel-${state.tab}`;
  render(state.tab === 'sources' ? 'health' : state.tab);
});

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
    map.setObras(prefs.obras);
    const box = document.querySelector('[data-group="obras"]');
    if (box) box.checked = prefs.obras;
  } else {
    prefs.eventCats = prefs.eventCats.includes(cat) ? prefs.eventCats.filter((c) => c !== cat) : [...prefs.eventCats, cat];
  }
  savePrefs();
  P.renderEventFilters(filtersEl, prefs);
  render('events');
});

const layersBody = document.getElementById('layers-body');
P.renderLayers(layersBody, prefs, {});
layersBody.addEventListener('change', (ev) => {
  const input = ev.target;
  if (state.selected.size) {
    state.selected.clear();
    map.setFocus(null);
    document.getElementById('focus-banner').hidden = true;
    render('alerts', 'events', 'vehicles');
  }
  if (input.dataset.mode) prefs.modes[input.dataset.mode] = input.checked;
  if (input.dataset.group === 'obras') {
    prefs.obras = input.checked;
    P.renderEventFilters(filtersEl, prefs);
    render('events');
  } else if (input.dataset.group) {
    prefs.groups[input.dataset.group] = input.checked;
  }
  savePrefs();
  applyLayerPrefs();
  if (input.dataset.mode && state.tab === 'vehicles') renderVehiclesPanel();
});

const layersToggle = document.getElementById('layers-toggle');
layersToggle.addEventListener('click', () => {
  const open = layersToggle.getAttribute('aria-expanded') !== 'true';
  layersToggle.setAttribute('aria-expanded', String(open));
  layersBody.hidden = !open;
});
if (window.matchMedia('(max-width: 860px)').matches) layersToggle.click();

// Aviso de datos que faltan: se muestra al entrar hasta que se acepta. Si cambia el texto,
// sube NOTICE_VERSION para que vuelva a aparecer a todo el mundo.
const NOTICE_KEY = 'radar-es:aviso-cobertura';
const NOTICE_VERSION = '2026-10-30b';
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

// Refresca los "hace X min" aunque no lleguen datos nuevos.
setInterval(() => render('alerts', state.tab === 'sources' ? 'health' : 'kpis'), 15_000);
