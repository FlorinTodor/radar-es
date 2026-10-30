import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { DELAY_CLASSES, MODE_LABEL, SEVERITY_LABEL, STATUS, esc, fmtDateTime, fmtDelay, fmtLocalHour, timeAgo, vehicleTitle } from './format.js';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
const FONT = ['Noto Sans Regular'];
const ANIM_MS = 1500;
const MAX_ANIM_DEG = 0.2; // saltos mayores (cambio de servicio, GPS erróneo) no se animan

const EMPTY = { type: 'FeatureCollection', features: [] };
const SEV_COLORS = { 'muy alta': STATUS.critical, alta: STATUS.serious, media: STATUS.warning, baja: STATUS.none };
const IS_EST = ['==', ['get', 'est'], 1];
const NOT_EST = ['!=', ['get', 'est'], 1];
const VEHICLE_RADIUS = ['interpolate', ['linear'], ['zoom'],
  5, ['match', ['get', 'mode'], ['av', 'ld'], 3.5, 'md', 3, 2.6],
  10, ['match', ['get', 'mode'], ['av', 'ld'], 6.5, 'md', 6, 5],
  14, 9];

// Capas del mapa agrupadas por interruptor del panel "Capas".
export const LAYER_GROUPS = {
  rail: ['rail-network'],
  lines: ['net-lines'],
  stations: ['stations-dots', 'stations-labels'],
  meteo: ['meteo-fill', 'meteo-outline'],
  dgt: ['ev-road', 'ev-road-major'],
  incendios: ['ev-fire-glow', 'ev-fire-core'],
  sismos: ['ev-quake'],
  'renfe-avisos': ['ev-rail'],
};

const LEVEL_COLOR = ['match', ['get', 'level'], 'rojo', STATUS.critical, 'naranja', STATUS.serious, STATUS.warning];
const LEVEL_ORDER = { amarillo: 0, naranja: 1, rojo: 2 };

export function createMap(container, { onVehicleClick, onEventClick }) {
  const map = new maplibregl.Map({
    container,
    style: STYLE,
    center: [-3.7, 40.0],
    zoom: 5.4,
    minZoom: 3,
    maxPitch: 0,
    attributionControl: { compact: true, customAttribution: 'Datos: Renfe · FGC · NAP · DGT · SCT · Euskadi · IGN · AEMET · NASA FIRMS · REE' },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  let anims = new Map(); // id → { from, to, t0, props }
  let raf = null;
  let popup = null;
  let popupVehicleId = null;
  let loaded = false;
  let modeFilter = null;
  let showObras = false;

  const ready = new Promise((resolve) => map.on('load', resolve)).then(() => {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;

    // La red ferroviaria del estilo base sólo aparece de cerca; la realzamos desde zoom 5.
    map.addLayer({
      id: 'rail-network', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 5,
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']]],
      paint: {
        'line-color': '#3d4b66',
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.6, 9, 1.1, 14, 2.2],
      },
    }, firstSymbol);

    for (const id of ['lines', 'areas', 'stations', 'events', 'track', 'vehicles']) map.addSource(id, { type: 'geojson', data: EMPTY });

    // Avisos meteorológicos debajo de todo lo demás, para no tapar trenes ni incidencias.
    map.addLayer({ id: 'meteo-fill', type: 'fill', source: 'areas', paint: { 'fill-color': LEVEL_COLOR, 'fill-opacity': 0.13 } }, firstSymbol);
    map.addLayer({ id: 'meteo-outline', type: 'line', source: 'areas', paint: { 'line-color': LEVEL_COLOR, 'line-width': 1.2, 'line-opacity': 0.75 } }, firstSymbol);
    // Líneas de metro, tranvía y Cercanías con su color oficial, atenuado para que destaquen los trenes.
    map.addLayer({
      id: 'net-lines', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.8, 10, 2, 14, 3.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 6, 0.35, 11, 0.6],
      },
    });

    // Las incidencias usan forma propia (rombo DGT, triángulo Renfe) para no confundirse
    // con los trenes, que son círculos con la misma paleta de estado.
    for (const [sev, color] of Object.entries(SEV_COLORS)) {
      map.addImage(`diamond-${sev}`, icon('diamond', color, '#0d0d0d'), { pixelRatio: 2 });
      map.addImage(`triangle-${sev}`, icon('triangle', color, '#f0efec'), { pixelRatio: 2 });
    }

    map.addLayer({
      id: 'stations-dots', type: 'circle', source: 'stations', minzoom: 8,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.8, 13, 4], 'circle-color': '#6b6b66', 'circle-stroke-color': '#0d0d0d', 'circle-stroke-width': 1 },
    });
    map.addLayer({
      id: 'stations-labels', type: 'symbol', source: 'stations', minzoom: 11,
      layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': '#898781', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.2 },
    });
    map.addLayer({
      id: 'track-line', type: 'line', source: 'track',
      paint: { 'line-color': '#6ea8fe', 'line-width': 2, 'line-dasharray': [2, 1.5], 'line-opacity': 0.85 },
    });
    // A escala de país sólo las incidencias graves o cortes; el resto aparece al acercarse.
    const roadLayout = {
      'icon-image': ['concat', 'diamond-', ['get', 'severity']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.7, 10, 1],
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    };
    map.addLayer({ id: 'ev-road', type: 'symbol', source: 'events', minzoom: 8, filter: roadFilter(false), layout: roadLayout });
    map.addLayer({ id: 'ev-road-major', type: 'symbol', source: 'events', filter: roadFilter(true), layout: roadLayout });
    // Focos de calor: halo difuminado + núcleo, para distinguirlos de los trenes (círculos nítidos).
    const isFire = ['==', ['get', 'category'], 'incendio'];
    map.addLayer({
      id: 'ev-fire-glow', type: 'circle', source: 'events', filter: isFire,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'frp'], 0, 5, 10, 8, 50, 13, 200, 20],
        'circle-color': '#ff5a1f', 'circle-blur': 0.9, 'circle-opacity': 0.55,
      },
    });
    map.addLayer({
      id: 'ev-fire-core', type: 'circle', source: 'events', filter: isFire,
      paint: { 'circle-radius': 2, 'circle-color': '#ffd27a' },
    });
    map.addLayer({
      id: 'ev-quake', type: 'circle', source: 'events', filter: ['==', ['get', 'category'], 'sismo'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['get', 'magnitude'], 1, 3, 3, 7, 5, 18, 7, 34],
        'circle-color': '#b48cff', 'circle-opacity': 0.25, 'circle-stroke-color': '#b48cff', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'ev-rail', type: 'symbol', source: 'events', filter: ['==', ['get', 'category'], 'ferroviario'],
      layout: {
        'icon-image': ['concat', 'triangle-', ['get', 'severity']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 1.4],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    map.addLayer({
      id: 'veh-halo', type: 'circle', source: 'vehicles', filter: vehicleFilter(['==', ['get', 'alert'], 1]),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 8, 10, 13, 14, 16],
        'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': STATUS.critical, 'circle-stroke-width': 2, 'circle-stroke-opacity': 0.9,
      },
    });
    // Posición estimada por horario: anillo hueco, para que nunca se confunda con un GPS real.
    map.addLayer({
      id: 'veh-est', type: 'circle', source: 'vehicles', filter: vehicleFilter(IS_EST),
      paint: { 'circle-radius': VEHICLE_RADIUS, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#c3c2b7', 'circle-stroke-width': 1.8 },
    });
    map.addLayer({
      id: 'vehicles', type: 'circle', source: 'vehicles', filter: vehicleFilter(NOT_EST),
      paint: {
        'circle-radius': VEHICLE_RADIUS,
        'circle-color': ['match', ['get', 'cls'], ...DELAY_CLASSES.flatMap(([color], i) => (i ? [i, color] : [])), DELAY_CLASSES[0][0]],
        'circle-stroke-color': '#0d0d0d', 'circle-stroke-width': 1.5,
      },
    });
    map.addLayer({
      id: 'veh-labels', type: 'symbol', source: 'vehicles', minzoom: 10, filter: vehicleFilter(),
      layout: { 'text-field': ['get', 'line'], 'text-font': FONT, 'text-size': 11, 'text-offset': [0, -1.3], 'text-optional': true },
      paint: { 'text-color': '#f0efec', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.5 },
    });

    const clickable = ['vehicles', 'veh-est', 'ev-rail', 'ev-quake', 'ev-road', 'ev-road-major', 'ev-fire-glow', 'meteo-fill'];
    for (const id of clickable) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e) => {
      const f = map.queryRenderedFeatures(e.point, { layers: clickable })[0];
      if (!f) return;
      if (f.layer.id === 'vehicles' || f.layer.id === 'veh-est') onVehicleClick(f.properties.id);
      else onEventClick(f.properties.id, e.lngLat);
    });

    loaded = true;
    kick();
  });

  function vehicleFilter(extra) {
    const parts = ['all'];
    if (modeFilter) parts.push(['in', ['get', 'mode'], ['literal', modeFilter]]);
    if (extra) parts.push(extra);
    return parts.length > 1 ? parts : ['all', true];
  }

  function roadFilter(major) {
    const isMajor = ['any', ['in', ['get', 'severity'], ['literal', ['alta', 'muy alta']]], ['==', ['get', 'closed'], true]];
    return ['all',
      ['==', ['get', 'category'], 'carretera'],
      showObras ? true : ['!=', ['get', 'type'], 'roadMaintenance'],
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
    if (popup && popupVehicleId && anims.has(popupVehicleId)) popup.setLngLat(position(anims.get(popupVehicleId), now));
    if (moving) raf = requestAnimationFrame(frame);
  }

  const kick = () => { if (!raf) raf = requestAnimationFrame(frame); };

  function openPopup(lngLat, html, vehicleId = null) {
    popup?.remove();
    popupVehicleId = vehicleId;
    popup = new maplibregl.Popup({ maxWidth: '320px', focusAfterOpen: false }).setLngLat(lngLat).setHTML(html).addTo(map);
    popup.on('close', () => {
      if (popupVehicleId === vehicleId) {
        popupVehicleId = null;
        map.getSource('track')?.setData(EMPTY);
      }
    });
  }

  return {
    ready,

    /** @param {object[]} list vehículos  @param {Set<string>} alertIds */
    setVehicles(list, alertIds) {
      const now = performance.now();
      const next = new Map();
      for (const v of list) {
        const to = [v.lon, v.lat];
        const prev = anims.get(v.id);
        const props = { id: v.id, mode: v.mode, cls: v.cls, line: v.line ?? '', alert: alertIds.has(v.id) ? 1 : 0, est: v.estimated ? 1 : 0 };
        if (prev && prev.to[0] === to[0] && prev.to[1] === to[1]) {
          next.set(v.id, { ...prev, props });
          continue;
        }
        const from = prev ? position(prev, now) : to;
        const jump = Math.abs(from[0] - to[0]) > MAX_ANIM_DEG || Math.abs(from[1] - to[1]) > MAX_ANIM_DEG;
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
      if (!loaded) return;
      map.setFilter('vehicles', vehicleFilter(NOT_EST));
      map.setFilter('veh-est', vehicleFilter(IS_EST));
      map.setFilter('veh-labels', vehicleFilter());
      map.setFilter('veh-halo', vehicleFilter(['==', ['get', 'alert'], 1]));
    },

    setObras(on) {
      showObras = on;
      if (!loaded) return;
      map.setFilter('ev-road', roadFilter(false));
      map.setFilter('ev-road-major', roadFilter(true));
    },

    setGroupVisible(group, visible) {
      if (!loaded) return;
      for (const id of LAYER_GROUPS[group] ?? []) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    },

    flyTo(lon, lat, zoom = 11) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), speed: 1.6 });
    },

    showVehicle(v) {
      const a = anims.get(v.id);
      openPopup(a ? position(a, performance.now()) : [v.lon, v.lat], vehiclePopup(v), v.id);
      fetch(`/api/tracks/${encodeURIComponent(v.id)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((track) => {
          if (popupVehicleId !== v.id || track.length < 2) return;
          map.getSource('track').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) }, properties: {} });
        })
        .catch(() => {});
    },

    /** @param {object} e  @param {{lng: number, lat: number}} [at] punto del clic (para zonas) */
    showEvent(e, at) {
      if (!at && (e.lat === null || e.lat === undefined)) return;
      openPopup(at ? [at.lng, at.lat] : [e.lon, e.lat], eventPopup(e));
    },
  };
}

/** Icono rasterizado para MapLibre (rombo o triángulo de 14 px a doble resolución). */
export function icon(shape, fill, stroke) {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(2, 2);
  g.beginPath();
  if (shape === 'diamond') {
    g.moveTo(7, 1.2); g.lineTo(12.8, 7); g.lineTo(7, 12.8); g.lineTo(1.2, 7);
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

function vehiclePopup(v) {
  const rows = [
    ['Tipo', MODE_LABEL[v.mode] ?? v.mode],
    ['Recorrido', `${v.origin ?? '?'} → ${v.destination ?? '?'}`],
    ['Retraso', fmtDelay(v)],
    v.current && ['Última estación', v.current],
    v.next && ['Próxima', `${v.next}${v.nextEta ? ` (${fmtLocalHour(v.nextEta)})` : v.nextInMinutes !== undefined && v.nextInMinutes !== null ? ` (en ${v.nextInMinutes} min)` : ''}`],
    v.platform && ['Vía', v.platform],
    v.area && ['Núcleo', v.area],
    v.rollingStock && ['Material', v.rollingStock],
    v.fixTime && ['GPS', timeAgo(v.fixTime)],
    ['Fuente', v.source],
  ].filter(Boolean);
  const note = v.estimated
    ? '<strong>Posición estimada</strong> a partir del horario publicado: no es GPS y no refleja retrasos.'
    : 'La línea discontinua es su recorrido en los últimos 45 min.';
  return `<div class="pop"><h3>${esc(vehicleTitle(v))}</h3><dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>
    <div class="note">${note}</div></div>`;
}

function eventPopup(e) {
  const rows = [
    ['Gravedad', SEVERITY_LABEL[e.severity] ?? e.severity],
    e.start && ['Inicio', fmtDateTime(e.start)],
    e.end && ['Fin previsto', fmtDateTime(e.end)],
    ['Fuente', e.source],
  ].filter(Boolean);
  const link = e.url ? `<div class="note"><a href="${esc(e.url)}" target="_blank" rel="noopener">Ficha oficial</a></div>` : '';
  return `<div class="pop"><h3>${esc(e.title)}</h3>${e.description ? `<p>${esc(e.description)}</p>` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join('')}</dl>${link}</div>`;
}
