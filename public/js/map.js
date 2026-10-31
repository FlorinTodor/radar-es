import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { DELAY_CLASSES, MODE_LABEL, SEVERITY_LABEL, STATUS, esc, fmtDateTime, fmtDelay, fmtLocalHour, safeUrl, timeAgo, vehicleTitle } from './format.js';
import { PICTOS, pictoFor, vehicleImage } from './icons.js';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const FONT = ['Noto Sans Regular'];
const ANIM_MS = 1500;
const MAX_ANIM_DEG = 0.2; // saltos mayores (cambio de servicio, GPS erróneo) no se animan

const EMPTY = { type: 'FeatureCollection', features: [] };
const SEV_COLORS = { 'muy alta': STATUS.critical, alta: STATUS.serious, media: STATUS.warning, baja: STATUS.none };
const IS_EST = ['==', ['get', 'est'], 1];
const NOT_EST = ['!=', ['get', 'est'], 1];
// Las placas miden 32 px a tamaño 1: ~13 px a escala de país y ~27 px de cerca (autobuses, algo menos).
const ICON_SIZE = ['interpolate', ['linear'], ['zoom'],
  5, ['match', ['get', 'mode'], 'bus', 0.32, 0.42],
  8, ['match', ['get', 'mode'], 'bus', 0.48, 0.6],
  12, 0.85,
  15, 1];
// Anillos (alerta, selección) un poco más grandes que la placa.
const RING_RADIUS = ['interpolate', ['linear'], ['zoom'], 5, 10, 8, 14, 12, 18, 15, 21];
const UNKNOWN_DELAY_RING = '#c3c2b7';

// Capas del mapa agrupadas por interruptor del panel "Capas".
export const LAYER_GROUPS = {
  rail: ['rail-network'],
  lines: ['net-lines'],
  trails: ['trails-line'],
  stations: ['stations-dots', 'stations-labels'],
  meteo: ['meteo-fill', 'meteo-outline'],
  dgt: ['ev-road', 'ev-road-major'],
  incendios: ['ev-fire-glow', 'ev-fire-core'],
  sismos: ['ev-quake'],
  'renfe-avisos': ['ev-rail'],
  gdacs: ['ev-gdacs'],
  effis: ['effis-burnt', 'burnt-sel-line'],
};

// Las teselas de IGN y EFFIS salen de nuestro servidor (/tiles), que las guarda y deja que Cloudflare
// las sirva: con mucha gente, sus servicios reciben cada tesela una vez y no una por visitante.
const RAIL_TILES = `${location.origin}/tiles/ign-rail/{z}/{x}/{y}.png`;
// Al invertir sus colores la capa es obra derivada: fórmula de la licencia del IGN con el producto y
// año de la tabla de productos del SCNE (scne.es/tablaProductos.php).
const RAIL_ATTRIBUTION = 'Red ferroviaria: Obra derivada de IGR-RT 2026 CC-BY 4.0 <a href="https://www.scne.es" target="_blank" rel="noopener">scne.es</a>';

// Áreas quemadas de los últimos 30 días (Copernicus EFFIS, WMS con CORS abierto).
const EFFIS_TILES = `${location.origin}/tiles/effis/{z}/{x}/{y}.png`;
const EFFIS_ATTRIBUTION = '© European Union, 1995-2025 · <a href="https://forest-fire.emergency.copernicus.eu/about-effis/data-license" '
  + 'target="_blank" rel="noopener">EFFIS – Copernicus Emergency Management Service</a> · CC BY 4.0';

const LEVEL_COLOR = ['match', ['get', 'level'], 'rojo', STATUS.critical, 'naranja', STATUS.serious, STATUS.warning];
const LEVEL_ORDER = { amarillo: 0, naranja: 1, rojo: 2 };

const today = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short' }).format(new Date());
// Textos que exigen las licencias (el resto de atribuciones están en /legal#fuentes).
const ATTRIBUTION = [
  '<a href="/legal#fuentes">Fuentes y licencias</a>',
  'Powered by <a href="https://www.transportes.gob.es/" target="_blank" rel="noopener">MITRAMS</a>',
  'Powered by <a href="https://www.crtm.es/" target="_blank" rel="noopener">CRTM</a>',
  'Powered by <a href="https://www.tram.cat/" target="_blank" rel="noopener">TRAM Barcelona</a>',
  'Origen de los datos: Renfe Operadora',
  `Obra derivada de Catálogo de terremotos IGN ${today} · CC-BY 4.0 <a href="https://www.ign.es" target="_blank" rel="noopener">ign.es</a>`,
  '© AEMET',
  'Fuente: DGT',
  '<a href="https://www.gdacs.org" target="_blank" rel="noopener">GDACS</a>',
  'NASA FIRMS',
];

export function createMap(container, { onVehicleClick, onEventClick }) {
  const map = new maplibregl.Map({
    container,
    style: STYLE,
    center: [-3.7, 40.0],
    zoom: 5.4,
    minZoom: 3,
    maxPitch: 0,
    // Desplegada en pantallas anchas. En el móvil (≤ 640 px) MapLibre la muestra al cargar y la
    // pliega en un botón (i) al mover el mapa, como permiten las normas de atribución de OSM;
    // además todas las atribuciones están en /legal.
    attributionControl: { customAttribution: ATTRIBUTION },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  let anims = new Map(); // id → { from, to, t0, props }
  let raf = null;
  let selectedId = null;  // tren seleccionado: lleva anillo y su recorrido reciente
  let clicks = 0;         // contador de clics en el mapa, para descartar respuestas tardías de EFFIS
  let trackFetchedAt = 0;
  const card = createDetailCard(map.getContainer().parentElement);
  let loaded = false;
  let modeFilter = null;
  let showObras = false;
  let focus = null; // { vehicleIds, eventIds } mientras hay alertas seleccionadas

  // Filtro base de cada capa de trenes y de sucesos. El modo foco le añade "y sólo estos ids"
  // y hace visibles las capas, aunque el usuario las tuviera apagadas.
  const category = (c) => ['==', ['get', 'category'], c];
  const VEHICLE_FILTERS = {
    'veh-halo': ['==', ['get', 'alert'], 1],
    'veh-est': IS_EST,
    vehicles: NOT_EST,
    'veh-labels': null,
  };
  const EVENT_FILTERS = {
    'ev-road': () => roadFilter(false),
    'ev-road-major': () => roadFilter(true),
    'ev-works': ['all', category('carretera'), ['==', ['get', 'type'], 'roadMaintenance']],
    'ev-gdacs': category('catastrofe'),
    'ev-fire-glow': category('incendio'),
    'ev-fire-core': category('incendio'),
    'ev-quake': category('sismo'),
    'ev-rail': category('ferroviario'),
    'meteo-fill': null,
    'meteo-outline': null,
  };

  function applyFilters() {
    if (!loaded) return;
    const only = (ids, base) => ['all', base ?? true, ['in', ['get', 'id'], ['literal', ids]]];
    for (const [id, base] of Object.entries(VEHICLE_FILTERS)) {
      map.setFilter(id, focus ? only(focus.vehicleIds, base) : vehicleFilter(base));
    }
    for (const [id, entry] of Object.entries(EVENT_FILTERS)) {
      const base = typeof entry === 'function' ? entry() : entry;
      map.setFilter(id, focus ? only(focus.eventIds, base) : base);
      if (focus) map.setLayoutProperty(id, 'visibility', 'visible');
    }
  }

  const ready = new Promise((resolve) => map.on('load', resolve)).then(() => {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

    // Red ferroviaria del IGN: se ve entera a cualquier zoom (las vías de OpenStreetMap del mapa
    // base sólo aparecen muy de cerca). Viene en gris oscuro: se invierte para que destaque.
    map.addSource('rail-ign', { type: 'raster', tiles: [RAIL_TILES], tileSize: 256, attribution: RAIL_ATTRIBUTION });
    map.addLayer({
      id: 'rail-network', type: 'raster', source: 'rail-ign',
      paint: {
        'raster-brightness-min': 1, 'raster-brightness-max': 0, 'raster-saturation': -1,
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 9, 0.5, 13, 0.6],
      },
    }, firstSymbol);

    for (const id of ['lines', 'areas', 'stations', 'events', 'trails', 'track', 'vehicles']) map.addSource(id, { type: 'geojson', data: EMPTY });

    // Avisos meteorológicos debajo de todo lo demás, para no tapar trenes ni incidencias.
    map.addLayer({ id: 'meteo-fill', type: 'fill', source: 'areas', paint: { 'fill-color': LEVEL_COLOR, 'fill-opacity': 0.13 } }, firstSymbol);
    map.addLayer({ id: 'meteo-outline', type: 'line', source: 'areas', paint: { 'line-color': LEVEL_COLOR, 'line-width': 1.2, 'line-opacity': 0.75 } }, firstSymbol);
    // Líneas de metro, tranvía y Cercanías con su color oficial, atenuado para que destaquen los trenes.
    map.addLayer({
      id: 'net-lines', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.1, 10, 2.2, 14, 3.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 11, 0.75],
      },
    });
    map.addSource('effis', { type: 'raster', tiles: [EFFIS_TILES], tileSize: 256, attribution: EFFIS_ATTRIBUTION });
    map.addLayer({ id: 'effis-burnt', type: 'raster', source: 'effis', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.75 } });
    // Contorno del área quemada que se ha pulsado (la capa de EFFIS es una imagen y no se puede resaltar).
    map.addSource('burnt-sel', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'burnt-sel-line', type: 'line', source: 'burnt-sel', layout: { visibility: 'none' }, paint: { 'line-color': '#f0efec', 'line-width': 2.5 } });

    // Las incidencias usan forma propia (rombo DGT, triángulo Renfe) para no confundirse
    // con los trenes, que son círculos con la misma paleta de estado.
    for (const [sev, color] of Object.entries(SEV_COLORS)) {
      map.addImage(`diamond-${sev}`, icon('diamond', color, '#0d0d0d'), { pixelRatio: 2 });
      map.addImage(`triangle-${sev}`, icon('triangle', color, '#f0efec'), { pixelRatio: 2 });
      map.addImage(`square-${sev}`, icon('square', color, '#0d0d0d'), { pixelRatio: 2 });
    }

    map.addLayer({
      id: 'stations-dots', type: 'circle', source: 'stations', minzoom: 6.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6.5, 1.8, 9, 2.8, 13, 4.5],
        'circle-color': '#b5b4ad', 'circle-stroke-color': '#0d0d0d', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6.5, 0.5, 9, 1],
      },
    });
    map.addLayer({
      id: 'stations-labels', type: 'symbol', source: 'stations', minzoom: 10,
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#898781', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.2 },
    });
    // Estelas de todos los trenes (capa opcional) y recorrido del tren seleccionado, más visible.
    map.addLayer({
      id: 'trails-line', type: 'line', source: 'trails', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#9db4d8', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 11, 1.6], 'line-opacity': 0.45 },
    });
    map.addLayer({
      id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round' },
      paint: { 'line-color': '#6ea8fe', 'line-width': 3, 'line-dasharray': [1.6, 1.2], 'line-opacity': 0.95 },
    });
    // A escala de país sólo las incidencias graves o cortes; el resto aparece al acercarse.
    const roadLayout = {
      'icon-image': ['concat', 'diamond-', ['get', 'severity']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 7, 0.75, 10, 1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    };
    map.addLayer({ id: 'ev-road', type: 'symbol', source: 'events', minzoom: 6.5, layout: roadLayout });
    map.addLayer({ id: 'ev-road-major', type: 'symbol', source: 'events', layout: roadLayout });
    // Obras: capa propia (cuadrado), independiente de la de tráfico y, si se activa, a cualquier zoom.
    map.addLayer({
      id: 'ev-works', type: 'symbol', source: 'events',
      layout: {
        visibility: showObras ? 'visible' : 'none',
        'icon-image': ['concat', 'square-', ['get', 'severity']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 8, 0.7, 11, 0.95],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: 'ev-gdacs', type: 'circle', source: 'events',
      paint: {
        'circle-radius': 11, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 3,
        'circle-stroke-color': ['match', ['get', 'severity'], 'muy alta', STATUS.critical, 'alta', STATUS.serious, '#6b6b66'],
      },
    });
    // Focos de calor: halo difuminado + núcleo, para distinguirlos de los trenes (círculos nítidos).
    map.addLayer({
      id: 'ev-fire-glow', type: 'circle', source: 'events',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'frp'], 0, 5, 10, 8, 50, 13, 200, 20],
        'circle-color': '#ff5a1f', 'circle-blur': 0.9, 'circle-opacity': 0.55,
      },
    });
    map.addLayer({
      id: 'ev-fire-core', type: 'circle', source: 'events',
      paint: { 'circle-radius': 2, 'circle-color': '#ffd27a' },
    });
    map.addLayer({
      id: 'ev-quake', type: 'circle', source: 'events',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'magnitude'], 1, 3, 3, 7, 5, 18, 7, 34],
        'circle-color': '#b48cff', 'circle-opacity': 0.25, 'circle-stroke-color': '#b48cff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'ev-rail', type: 'symbol', source: 'events',
      layout: {
        'icon-image': ['concat', 'triangle-', ['get', 'severity']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 1.4],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: 'veh-halo', type: 'circle', source: 'vehicles',
      paint: {
        'circle-radius': RING_RADIUS,
        'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': STATUS.critical, 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9,
      },
    });
    // Placa con el pictograma del vehículo (tren, AV, metro, tranvía, autobús), del color de su
    // retraso. Las posiciones estimadas por horario usan la placa hueca, para que nunca se
    // confundan con un GPS real. Las de más retraso se dibujan encima.
    DELAY_CLASSES.forEach(([color], cls) => {
      for (const picto of PICTOS) {
        map.addImage(`v-${picto}-${cls}`, vehicleImage(picto, color), { pixelRatio: 2 });
        // Si el operador publica el retraso real (Euskotren), la placa hueca lleva su color; si no, gris.
        map.addImage(`ve-${picto}-${cls}`, vehicleImage(picto, cls ? color : UNKNOWN_DELAY_RING, true), { pixelRatio: 2 });
      }
    });
    const vehicleLayout = (prefix) => ({
      'icon-image': ['concat', prefix, ['get', 'picto'], '-', ['to-string', ['get', 'cls']]],
      'icon-size': ICON_SIZE,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['get', 'cls'],
    });
    map.addLayer({ id: 'veh-est', type: 'symbol', source: 'vehicles', layout: vehicleLayout('ve-') });
    map.addLayer({ id: 'vehicles', type: 'symbol', source: 'vehicles', layout: vehicleLayout('v-') });
    map.addLayer({
      id: 'veh-selected', type: 'circle', source: 'vehicles', filter: ['==', ['get', 'id'], ''],
      paint: {
        'circle-radius': RING_RADIUS,
        'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#6ea8fe', 'circle-stroke-width': 3,
      },
    });
    map.addLayer({
      id: 'veh-labels', type: 'symbol', source: 'vehicles', minzoom: 9,
      // Las posiciones estimadas lo dicen también en la etiqueta, no sólo con la placa hueca.
      layout: {
        'text-field': ['case', IS_EST, ['concat', ['get', 'line'], ' · estimada'], ['get', 'line']],
        'text-font': FONT, 'text-size': 11, 'text-offset': [0, -1.9], 'text-optional': true,
      },
      paint: { 'text-color': '#f0efec', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.5 },
    });

    const clickable = ['vehicles', 'veh-est', 'ev-rail', 'ev-quake', 'ev-gdacs', 'ev-road', 'ev-road-major', 'ev-works', 'ev-fire-glow', 'meteo-fill'];
    for (const id of clickable) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e) => {
      clicks++;
      const f = map.queryRenderedFeatures(e.point, { layers: clickable })[0];
      if (!f) {
        clearSelection(); // clic en una zona vacía: se quita la selección…
        // …pero las áreas quemadas son una imagen (WMS): se pregunta a EFFIS si hay una en ese punto.
        if (map.getLayoutProperty('effis-burnt', 'visibility') === 'visible') showBurntAreaAt(e.point);
        return;
      }
      if (['vehicles', 'veh-est'].includes(f.layer.id)) onVehicleClick(f.properties.id);
      else onEventClick(f.properties.id, e.lngLat);
    });

    loaded = true;
    applyFilters();
    kick();
  });

  function vehicleFilter(extra) {
    const parts = ['all'];
    if (modeFilter) parts.push(['in', ['get', 'mode'], ['literal', modeFilter]]);
    if (extra) parts.push(extra);
    return parts.length > 1 ? parts : ['all', true];
  }

  // Incidencias de tráfico sin obras (las obras tienen su propia capa, 'ev-works').
  function roadFilter(major) {
    const isMajor = ['any', ['in', ['get', 'severity'], ['literal', ['alta', 'muy alta']]], ['==', ['get', 'closed'], true]];
    return ['all',
      ['==', ['get', 'category'], 'carretera'],
      ['!=', ['get', 'type'], 'roadMaintenance'],
      major ? isMajor : ['!', isMajor],
    ];
  }

  function position(a, now) {
    const k = Math.min(1, (now - a.t0) / ANIM_MS);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    return [a.from[0] + (a.to[0] - a.from[0]) * e, a.from[1] + (a.to[1] - a.from[1]) * e];
  }

  function frame() {
    raf = null;
    if (!loaded) return;
    const now = performance.now();
    let moving = false;
    const features = [];
    for (const a of anims.values()) {
      if (now - a.t0 < ANIM_MS) moving = true;
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: position(a, now) }, properties: a.props });
    }
    map.getSource('vehicles').setData({ type: 'FeatureCollection', features });
    if (moving) raf = requestAnimationFrame(frame);
  }

  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  function setSelected(id) {
    selectedId = id;
    if (loaded) map.setFilter('veh-selected', ['==', ['get', 'id'], id ?? '']);
    if (!id) map.getSource('track')?.setData(EMPTY);
    map.getSource('burnt-sel')?.setData(EMPTY);
  }

  /** Pregunta a EFFIS por el área quemada bajo un punto de la pantalla y, si hay, muestra su ficha. */
  async function showBurntAreaAt(point) {
    const click = clicks; // si se pulsa otra cosa antes de que EFFIS responda, gana el último clic
    const at = map.unproject(point);
    const sw = map.unproject([point.x - 4, point.y + 4]);
    const ne = map.unproject([point.x + 4, point.y - 4]);
    try {
      const res = await fetch(`/api/burnt-areas?bbox=${sw.lng},${sw.lat},${ne.lng},${ne.lat}`);
      const { features = [] } = res.ok ? await res.json() : {};
      if (click !== clicks) return;
      const areas = features.map((f) => lonLatFeature(f, at));
      const hit = areas.find((a) => containsPoint(a.geometry, [at.lng, at.lat])) ?? areas[0];
      if (!hit) return;
      map.getSource('burnt-sel').setData(hit);
      card.show(burntAreaDetail(hit.properties));
    } catch { /* EFFIS no responde: no se muestra nada */ }
  }

  function clearSelection() {
    setSelected(null);
    card.hide();
  }

  function loadTrack(id) {
    trackFetchedAt = Date.now();
    fetch(`/api/tracks/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((track) => {
        if (selectedId !== id) return;
        map.getSource('track').setData(track.length < 2 ? EMPTY
          : { type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {} });
      })
      .catch(() => {});
  }

  // La ficha ocupa la derecha del mapa (abajo en el móvil, junto al aviso de selección): se
  // encuadra dejando ese hueco libre. El corte coincide con el de la vista móvil del CSS.
  const narrow = window.matchMedia('(max-width: 860px)');
  const bottomOverlays = () => {
    const box = map.getContainer().getBoundingClientRect();
    let top = box.bottom;
    for (const el of map.getContainer().parentElement.querySelectorAll('.detail, .focus-banner')) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > box.top + box.height / 2) top = Math.min(top, r.top); // sólo lo que está abajo
    }
    return box.bottom - top;
  };
  const sidePadding = () => (narrow.matches
    ? { top: 60, bottom: 40 + bottomOverlays(), left: 30, right: 30 }
    : { top: 70, bottom: 50, left: 260, right: card.open ? 360 : 70 });
  // Para centrar un punto se usa un desplazamiento y no `padding`: en MapLibre el padding de
  // flyTo se queda guardado en el mapa y se sumaría al de encuadres posteriores (fitBounds).
  const centerOffset = () => {
    const p = sidePadding();
    return [(p.left - p.right) / 2, (p.top - p.bottom) / 2];
  };

  return {
    ready,
    raw: map, // acceso directo para depuración (?debug) y pruebas automáticas

    /** @param {object[]} list vehículos  @param {Set<string>} alertIds */
    setVehicles(list, alertIds) {
      const now = performance.now();
      const next = new Map();
      for (const v of list) {
        const to = [v.lon, v.lat];
        const prev = anims.get(v.id);
        const props = { id: v.id, mode: v.mode, cls: v.cls, line: v.line ?? '', alert: alertIds.has(v.id) ? 1 : 0, est: v.estimated ? 1 : 0, picto: pictoFor(v.mode) };
        if (prev && prev.to[0] === to[0] && prev.to[1] === to[1]) {
          next.set(v.id, { ...prev, props });
          continue;
        }
        const from = prev ? position(prev, now) : to;
        // Las posiciones estimadas cambian a saltos de una lectura a otra (a veces cientos de metros por
        // la calle): deslizarlas en línea recta las haría cruzar manzanas, así que saltan.
        const jump = v.estimated || Math.abs(from[0] - to[0]) > MAX_ANIM_DEG || Math.abs(from[1] - to[1]) > MAX_ANIM_DEG;
        next.set(v.id, { from: jump ? to : from, to, t0: now, props });
      }
      anims = next;
      kick();
    },

    setEvents(list) {
      if (!loaded) return;
      const areas = list.filter((e) => e.geometry);
      map.getSource('areas').setData({
        type: 'FeatureCollection',
        // Los rojos al final para que se dibujen por encima de los amarillos.
        features: areas.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]).map((e) => ({
          type: 'Feature', geometry: e.geometry, properties: { id: e.id, level: e.level },
        })),
      });
      map.getSource('events').setData({
        type: 'FeatureCollection',
        features: list.filter((e) => !e.geometry && e.lat !== null && e.lon !== null && e.lat !== undefined).map((e) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
          properties: { id: e.id, category: e.category, type: e.type, severity: e.severity, closed: !!e.closed, magnitude: e.magnitude ?? 0, frp: e.frp ?? 0 },
        })),
      });
    },

    setLines(collection) {
      if (loaded) map.getSource('lines').setData(collection);
    },

    setStations(list) {
      if (!loaded) return;
      map.getSource('stations').setData({
        type: 'FeatureCollection',
        features: list.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: { name: s.name } })),
      });
    },

    setModes(modes) {
      modeFilter = modes;
      applyFilters();
    },

    /**
     * Muestra sólo los trenes y sucesos indicados (alertas seleccionadas), aunque sus capas
     * estuvieran apagadas. Con null se vuelve a los filtros normales; quien llama debe
     * restaurar después la visibilidad de las capas según las preferencias del usuario.
     * @param {{ vehicleIds: string[], eventIds: string[] } | null} f
     */
    setFocus(f) {
      focus = f;
      applyFilters();
    },

    /** Encuadra una lista de puntos [lon, lat]. */
    fitTo(points) {
      if (!points.length) return;
      if (points.length === 1) return map.flyTo({ center: points[0], zoom: Math.max(map.getZoom(), 10), speed: 1.6, offset: centerOffset() });
      const lons = points.map((p) => p[0]);
      const lats = points.map((p) => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: sidePadding(), maxZoom: 11, duration: 900 });
    },

    setObras(on) {
      showObras = on;
      if (loaded) map.setLayoutProperty('ev-works', 'visibility', on ? 'visible' : 'none');
    },

    setGroupVisible(group, visible) {
      if (!loaded) return;
      for (const id of LAYER_GROUPS[group] ?? []) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    },

    /** Centra un punto dejando libre el hueco de la ficha y del panel de capas. */
    flyTo(lon, lat, zoom = 11) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), speed: 1.6, offset: centerOffset() });
    },

    /** Selecciona un tren: anillo, recorrido reciente y ficha. La × de la ficha sólo la cierra. */
    showVehicle(v) {
      setSelected(v.id);
      card.show(vehicleDetail(v));
      loadTrack(v.id);
    },

    /** Actualiza la ficha y, cada 15 s, el recorrido del tren seleccionado cuando llegan datos. */
    refreshVehicle(v) {
      if (selectedId !== v.id) return;
      if (card.open) card.show(vehicleDetail(v));
      if (Date.now() - trackFetchedAt > 15_000) loadTrack(v.id);
    },

    selectedVehicleId: () => selectedId,

    showEvent(e) {
      setSelected(null);
      card.show(eventDetail(e));
    },

    setTrails(collection) {
      if (loaded) map.getSource('trails').setData(collection ?? EMPTY);
    },
  };
}

/** Icono rasterizado para MapLibre (rombo, cuadrado o triángulo de 14 px a doble resolución). */
export function icon(shape, fill, stroke) {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(2, 2);
  g.beginPath();
  if (shape === 'diamond') {
    g.moveTo(7, 1.2); g.lineTo(12.8, 7); g.lineTo(7, 12.8); g.lineTo(1.2, 7);
  } else if (shape === 'square') {
    g.rect(2.2, 2.2, 9.6, 9.6);
  } else {
    g.moveTo(7, 1.5); g.lineTo(12.8, 12.3); g.lineTo(1.2, 12.3);
  }
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.4;
  g.strokeStyle = stroke;
  g.stroke();
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

/** Ficha fija sobre el mapa (sustituye a las ventanas emergentes, que tapaban el recorrido). */
function createDetailCard(host) {
  const el = document.createElement('div');
  el.className = 'card detail';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Detalle del elemento seleccionado');
  el.innerHTML = '<button type="button" class="detail-close" aria-label="Cerrar ficha">×</button><div class="detail-body"></div>';
  el.querySelector('.detail-close').addEventListener('click', () => { el.hidden = true; });
  host.appendChild(el);
  return {
    show(html) {
      el.querySelector('.detail-body').innerHTML = html;
      el.hidden = false;
    },
    hide() { el.hidden = true; },
    get open() { return !el.hidden; },
  };
}

function vehicleDetail(v) {
  // La vía es la de una estación (en la que está parado o a la que llega), nunca la del trayecto:
  // va pegada a esa estación para que no se lea como la vía por la que circula.
  const via = v.platform ? ` · vía ${v.platform}` : '';
  const rows = [
    ['Tipo', MODE_LABEL[v.mode] ?? v.mode],
    (v.origin || v.destination) && ['Recorrido', `${v.origin ?? '?'} → ${v.destination ?? '?'}`],
    ['Retraso', fmtDelay(v)],
    v.current && [v.stopped ? 'Parado en' : v.mode === 'bus' ? 'Última parada' : 'Última estación', `${v.current}${v.stopped ? via : ''}`],
    v.next && ['Próxima', `${v.next}${v.nextEta ? ` (${fmtLocalHour(v.nextEta)})` : v.nextInMinutes !== undefined && v.nextInMinutes !== null ? ` (en ${v.nextInMinutes} min)` : ''}${v.stopped ? '' : via}`],
    v.area && ['Núcleo', v.area],
    v.rollingStock && ['Material', v.rollingStock],
    v.fixTime && ['GPS', timeAgo(v.fixTime)],
    ['Fuente', v.source],
  ].filter(Boolean);
  const note = !v.estimated
    ? 'La <strong>línea azul discontinua</strong> es el recorrido de este tren en los últimos 45 min (desde que el radar lo sigue). '
      + 'La × sólo cierra esta ficha; pulsa en una zona vacía del mapa para quitar la selección.'
    : (v.delay !== null && v.delay !== undefined
      ? '<strong>Posición estimada</strong> a partir del horario y del retraso real que publica el operador: no es GPS. '
      : '<strong>Posición estimada</strong> a partir del horario publicado: no es GPS y no refleja retrasos. ')
      + (v.atLastStop
        ? 'El operador no publica el recorrido entre paradas, así que se muestra en la última parada por la que ha pasado.'
        : 'Se mueve a saltos, en cada actualización. Si su ruta tiene trazado publicado, la <strong>línea azul discontinua</strong> '
          + 'es el tramo que habría recorrido en los últimos 45 min según el horario.');
  const badge = v.estimated ? '<div class="est-badge">Posición estimada · no es GPS</div>' : '';
  return `<div class="pop"><h3>${esc(vehicleTitle(v))}</h3>${badge}<dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
    <div class="note">${note}</div></div>`;
}


/**
 * EFFIS devuelve las coordenadas en orden [lat, lon] aunque GeoJSON pide [lon, lat]. Como se pide
 * el área que hay bajo el clic, su primer vértice tiene que estar cerca de él: se mira qué orden
 * encaja y sólo se dan la vuelta si hace falta (así no se rompe si un día EFFIS lo corrige).
 */
function lonLatFeature(f, near) {
  const g = f.geometry;
  const rings = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const [a, b] = rings[0]?.[0]?.[0] ?? [near.lng, near.lat];
  const swapped = Math.abs(b - near.lng) + Math.abs(a - near.lat) < Math.abs(a - near.lng) + Math.abs(b - near.lat);
  if (!swapped) return f;
  const flip = (poly) => poly.map((ring) => ring.map(([x, y]) => [y, x]));
  return { ...f, geometry: { type: g.type, coordinates: g.type === 'Polygon' ? flip(g.coordinates) : g.coordinates.map(flip) } };
}

/** ¿Está el punto [lon, lat] dentro del (Multi)Polygon? Regla par-impar, con los huecos incluidos. */
function containsPoint(g, [x, y]) {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.some((poly) => poly.reduce((inside, ring) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }, false));
}

// Cubierta del suelo de EFFIS (clases de CORINE Land Cover), en % del área quemada.
const LAND_COVER = [
  ['BROADLEA', 'Bosque de frondosas'], ['CONIFER', 'Bosque de coníferas'], ['MIXED', 'Bosque mixto'],
  ['SCLEROPH', 'Vegetación esclerófila'], ['TRANSIT', 'Matorral boscoso de transición'],
  ['OTHERNATLC', 'Otros espacios naturales'], ['AGRIAREAS', 'Zonas agrícolas'],
  ['ARTIFSURF', 'Superficies artificiales'], ['OTHERLC', 'Otros usos'],
];

function burntAreaDetail(p) {
  const pct = (v) => `${Math.round(Number(v))}\u00a0%`; // espacio duro: que el % no salte de línea
  const date = (s) => (s ? s.slice(0, 10).split('-').reverse().join('/') : null);
  const cover = LAND_COVER.filter(([k]) => Number(p[k]) >= 1).sort(([a], [b]) => p[b] - p[a])
    .map(([k, label]) => `${label} ${pct(p[k])}`).join(' · ');
  const place = [p.COMMUNE, p.PROVINCE].filter(Boolean).join(', ');
  const rows = [
    ['Fecha del incendio', date(p.FIREDATE)],
    ['Superficie', p.AREA_HA ? `${fmtArea(p.AREA_HA)} ha` : null],
    cover && ['Qué ha ardido', cover],
    Number(p.PERCNA2K) >= 1 && ['En Red Natura 2000', pct(p.PERCNA2K)],
    ['Actualizado', date(p.LASTUPDATE)],
    ['Fuente', 'Copernicus EFFIS'],
  ].filter((r) => r && r[1]);
  return `<div class="pop"><h3>Área quemada${place ? ` en ${esc(place)}` : ''}</h3>
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
    <div class="note">Perímetro estimado por satélite por el sistema europeo de incendios forestales (EFFIS), no es un
    dato oficial de extinción. <a href="https://forest-fire.emergency.copernicus.eu/apps/effis.csv/" target="_blank" rel="noopener">Ver en EFFIS</a></div></div>`;
}

const fmtArea = (ha) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Number(ha));

function eventDetail(e) {
  const rows = [
    ['Gravedad', SEVERITY_LABEL[e.severity] ?? e.severity],
    e.issued && ['Emitido', fmtDateTime(e.issued)],
    e.start && ['Inicio', fmtDateTime(e.start)],
    e.end && ['Fin previsto', fmtDateTime(e.end)],
    ['Fuente', e.source],
  ].filter(Boolean);
  const url = safeUrl(e.url);
  const link = url ? `<div class="note"><a href="${esc(url)}" target="_blank" rel="noopener">Ficha oficial</a></div>` : '';
  return `<div class="pop"><h3>${esc(e.title)}</h3>${e.description ? `<p>${esc(e.description)}</p>` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>${link}</div>`;
}
