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
  selected: new Set(), // alertas seleccionadas: el mapa muestra sólo lo suyo
  multi: false,         // interruptor "Varias a la vez"
};

const PREFS_KEY = 'radar-es:prefs';
const prefs = Object.assign(
  { modes: {}, groups: {}, obras: false, eventCats: ['ferroviario', 'carretera', 'meteo', 'incendio', 'sismo', 'catastrofe', 'internet'] },
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
    const counts = {};
    for (const v of vehicles) counts[v.mode] = (counts[v.mode] ?? 0) + 1;
    P.updateModeCounts(document.getElementById('layers-body'), counts);
    if (state.tab === 'vehicles') renderVehiclesPanel(vehicles);
  }
  if (parts.has('events')) {
    const events = allEvents();
    map.setEvents(events);
    document.getElementById('b-events').textContent = P.filterEvents(events, prefs).length;
    if (state.tab === 'events') P.renderEvents(document.getElementById('events-list'), P.filterEvents(events, prefs));
  }
  if (parts.has('alerts')) {
    document.getElementById('b-alerts').textContent = state.alerts.length;
    if (state.tab === 'alerts') P.renderAlerts(document.getElementById('panel-alerts'), state.alerts, state.resolved, state.selected, state.multi);
  }
  if (parts.has('kpis') || parts.has('alerts')) P.renderKpis(state.kpis, state.metrics, state.alerts.length);
  if (parts.has('health') && state.tab === 'sources') P.renderSources(document.getElementById('panel-sources'), state.health);
}

function renderVehiclesPanel(all = allVehicles()) {
  const vehicles = all.filter((v) => P.modeOn(prefs, v.mode));
  P.renderVehicles(document.getElementById('vehicles-list'), P.filterVehicles(vehicles, state.search), vehicles.length);
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
      render('vehicles');
    } else if (p.kind === 'events') {
      state.events.set(p.id, p.items);
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
  map.flyTo(v.lon, v.lat, 10);
  map.showVehicle(v);
}

function selectEvent(id) {
  const e = findEvent(id);
  if (!e || e.lat === null || e.lat === undefined) return;
  map.flyTo(e.lon, e.lat, e.category === 'sismo' || e.category === 'meteo' ? 7 : 10);
  map.showEvent(e);
}

// ---------- Selección de alertas ----------
// Clic: el mapa muestra sólo lo de esa alerta (otro clic en la misma vuelve a tus capas).
// Con el interruptor "Varias a la vez", cada clic suma o quita la alerta de la selección.
// Todo con clics: funciona igual con ratón y en el móvil.
function selectAlert(id) {
  const sel = state.selected;
  if (state.multi) {
    if (sel.has(id)) sel.delete(id);
    else sel.add(id);
  } else if (sel.size === 1 && sel.has(id)) {
    sel.clear();
  } else {
    state.selected = new Set([id]);
  }
  applyFocus({ fit: true });
}

function clearFocus() {
  state.selected.clear();
  applyFocus();
}

function applyFocus({ fit = false } = {}) {
  const active = new Map(state.alerts.map((a) => [a.id, a]));
  for (const id of state.selected) if (!active.has(id)) state.selected.delete(id); // ya resueltas
  const alerts = [...state.selected].map((id) => active.get(id));

  if (!alerts.length) {
    map.setFocus(null);
    applyLayerPrefs();
  } else {
    const vehicleIds = [...new Set(alerts.flatMap((a) => [a.vehicleId, ...(a.vehicleIds ?? [])]).filter(Boolean))];
    const eventIds = [...new Set(alerts.flatMap((a) => a.eventIds ?? []))];
    map.setFocus({ vehicleIds, eventIds });
    if (fit) {
      const only = alerts.length === 1 ? alerts[0] : null;
      if (only?.vehicleId && findVehicle(only.vehicleId)) {
        selectVehicle(only.vehicleId);
      } else {
        const points = [
          ...alerts.filter((a) => a.lon !== undefined && a.lat !== undefined).map((a) => [a.lon, a.lat]),
          ...vehicleIds.map(findVehicle).filter(Boolean).map((v) => [v.lon, v.lat]),
          ...eventIds.map(findEvent).filter((e) => e?.lat !== null && e?.lat !== undefined).map((e) => [e.lon, e.lat]),
        ];
        map.fitTo(points);
      }
    }
  }
  const banner = document.getElementById('focus-banner');
  banner.hidden = !alerts.length;
  banner.querySelector('.txt').textContent = alerts.length === 1 ? 'Mostrando sólo 1 alerta' : `Mostrando sólo ${alerts.length} alertas`;
  render('alerts');
}

document.querySelector('.sidebar').addEventListener('click', (ev) => {
  if (ev.target.closest('[data-action=clear-focus]')) return clearFocus();
  const item = ev.target.closest('[data-kind]');
  if (!item) return;
  ({ alert: selectAlert, event: selectEvent, vehicle: selectVehicle })[item.dataset.kind]?.(item.dataset.id);
});
document.getElementById('panel-alerts').addEventListener('change', (ev) => {
  if (ev.target.dataset.action !== 'multi') return;
  state.multi = ev.target.checked;
  render('alerts');
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
    render('alerts');
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
