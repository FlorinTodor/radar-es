import * as maplibregl from '/vendor/maplibre/maplibre-gl.mjs';
import { DELAY_CLASSES, MODE_LABEL, SEVERITY_LABEL, STATUS, esc, fmtDataTime, fmtDate, fmtDateTime, fmtDelay, fmtLocalHour, fmtTime, creditHtml, photoTitleOf, safeUrl, timeAgo, vehicleTitle } from './format.js';
import { PICTOS, pictoFor, vehicleImage } from './icons.js';
import { headingAlong, matchTrack, pathBetween } from './track-match.js';
import { STOP_SPACE_PX, stopLabelLayout, stopSpaceLayout, stopTipHtml, stopsCollection, stopsListHtml, tripFramePoints } from './trip-stops.js';
import { telegramFollow } from './avisar.js';

const STYLE = 'https://tiles.openfreemap.org/styles/dark';
// Iconos que el estilo pide y su sprite no tiene (ver styleimagemissing en createMap). Sólo esos: uno de los
// nuestros que faltara es un error de verdad y tiene que verse.
const BASEMAP_IMAGE = /^(circle-11|wood-pattern)$/;
const FONT = ['Noto Sans Regular'];
const ANIM_MS = 1500;
const MAX_ANIM_DEG = 0.2; // saltos mayores (cambio de servicio, GPS erróneo) no se animan

const EMPTY = { type: 'FeatureCollection', features: [] };
// Fuentes cuyos vehículos traen su trazado (`shape`) y el final de su viaje (`end`) → red del catálogo de trazados.
const ROUTE_NETWORK = { 'renfe-cercanias': 'Cercanías Renfe', 'metro-bilbao': 'Metro Bilbao' };
// Fuentes que no dicen el trazado de su viaje, pero sí su línea y dónde acaba: vale el trazado de su
// línea que pase por el tren y por su final (en FGC, las líneas con ramales tienen varios).
const LINE_NETWORK = { fgc: 'FGC' };
// Posiciones reales cuya licencia pide no alterar el contenido (Open Data Euskadi): su recorrido reciente
// se dibuja con las posiciones tal y como llegan, sin llevarlas al trazado.
const AS_PUBLISHED = new Set(['metro-bilbao']);
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
// Al encuadrar el viaje del vehículo seleccionado, margen de más para que quepan los nombres de las
// paradas de los extremos: van centrados debajo de su punto (a los lados, la mitad de un nombre largo).
const STOP_LABEL_MARGIN = { left: 80, right: 80, top: 20, bottom: 30 };

// Capas del mapa agrupadas por interruptor del panel "Capas".
export const LAYER_GROUPS = {
  rail: ['rail-network'],
  lines: ['net-lines'],
  trails: ['trails-line'],
  stations: ['stations-hit', 'stations-dots', 'stations-sel', 'stations-labels', 'netst-hit', 'netst-dots', 'netst-labels'],
  meteo: ['meteo-fill', 'meteo-outline'],
  dgt: ['ev-road', 'ev-road-major'],
  incendios: ['ev-fire-glow', 'ev-fire-core'],
  sismos: ['ev-quake'],
  'renfe-avisos': ['ev-rail'],
  cancelaciones: ['ev-cancel'],
  'sin-datos': ['ev-sin-datos'],
  gdacs: ['ev-gdacs'],
  emergencias: ['ev-emerg'],
  effis: ['effis-burnt', 'burnt-sel-line'],
};

// Las teselas de IGN y EFFIS salen de nuestro servidor (/tiles), que las guarda y deja que Cloudflare
// las sirva: con mucha gente, sus servicios reciben cada tesela una vez y no una por visitante.
// El servidor sólo sirve las que tocan España y hasta un zoom por capa (server/domain/tiles.js):
// con los mismos `bounds` y `maxzoom` el mapa no pide otras y, más cerca, amplía la última.
const TILES_BOUNDS = [-18.5, 27.4, 4.6, 44.0];
const RAIL_TILES = `${location.origin}/tiles/ign-rail/{z}/{x}/{y}.png`;

// Áreas quemadas de los últimos 30 días (Copernicus EFFIS): sus teselas también salen de /tiles.
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
  'Fuente: TMB',
  'Fuente: AUVASA',
  'Origen de los datos: Renfe Operadora',
  '© Administrador de infraestructuras ferroviarias',
  `Obra derivada de Catálogo de terremotos IGN ${today} · CC-BY 4.0 <a href="https://www.ign.es" target="_blank" rel="noopener">ign.es</a>`,
  // Los terremotos pequeños (menos de magnitud 2,6), que el RSS del IGN no trae.
  'Credit: <a href="https://www.seismicportal.eu" target="_blank" rel="noopener">EMSC-CSEM SeismicPortal</a>',
  // Los avisos oficiales que sólo nombran un municipio se sitúan con CartoCiudad (licencia del IGN).
  'Obra derivada de CartoCiudad 2026 CC-BY 4.0 <a href="https://www.scne.es" target="_blank" rel="noopener">scne.es</a>',
  // Las vías del IGN: la capa «Red ferroviaria» (con sus colores invertidos) y los tramos de las líneas y de
  // los vehículos según horario que se rehacen por ellas. Siempre a la vista: las líneas se ven sin la capa.
  // Fórmula de la licencia con el producto y año de la tabla de productos del SCNE (scne.es/tablaProductos.php).
  'Red ferroviaria y trazados por la vía: Obra derivada de IGR-RT 2026 CC-BY 4.0 <a href="https://www.scne.es" target="_blank" rel="noopener">scne.es</a>',
  '© AEMET',
  'Fuente: DGT',
  '<a href="https://www.gdacs.org" target="_blank" rel="noopener">GDACS</a>',
  // La licencia del portal de la Junta pide esta fórmula «en un lugar visible».
  'Información obtenida del Portal de la Junta de Andalucía',
  'NASA FIRMS',
];

// El estilo de OpenFreeMap rotula en inglés (name_en: «Spain», «Castile and León»). Sus teselas traen
// el nombre en español (name:es); si un lugar no lo tiene, el nombre en alfabeto latino y, si no, el local.
const NAME_ES = ['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']];

export function spanishLabels(map) {
  for (const layer of map.getStyle().layers) {
    const field = layer.type === 'symbol' && layer.layout?.['text-field'];
    if (field && JSON.stringify(field).includes('name_en')) map.setLayoutProperty(layer.id, 'text-field', NAME_ES);
  }
}

export function createMap(container, { onVehicleClick, onEventClick, onStationClick }) {
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
  // El estilo de OpenFreeMap pide iconos que su sprite no trae («circle-11», el punto de los pueblos y
  // ciudades, que en su sprite se llama «circle_11», y «wood-pattern», la trama de los bosques) y MapLibre
  // avisa en la consola de cada uno. Nunca se han dibujado: se ponen transparentes para que el mapa se vea
  // igual y sin avisos. MapLibre pregunta aquí antes de darlos por perdidos (el evento styleimagemissing
  // llega tarde para los iconos). Los nuestros se añaden al cargar, antes que sus capas: no se tocan.
  map.setMissingStyleImageResolver((id) => {
    if (BASEMAP_IMAGE.test(id) && !map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });

  let anims = new Map(); // id → { from, to, t0, props }
  let raf = null;
  let selectedId = null;  // tren seleccionado: lleva anillo y su recorrido reciente
  let selectedVehicle = null; // sus últimos datos, para repintar la ficha al llegar sus paradas
  let tripStops = null;   // paradas de su viaje (/api/stops), si se saben
  // Vehículo cuyo viaje ya se ha encuadrado en esta selección: se encuadra al llegar sus paradas tras
  // cada selección (en el mapa, en la lista o desde una alerta), no en las recargas de cada 15 s.
  let stopsFramedFor = null;
  let selectedStation = null; // código de la estación cuya ficha está abierta
  let clicks = 0;         // contador de clics en el mapa, para descartar respuestas tardías de EFFIS
  let trackFetchedAt = 0;
  let lastRoute = null; // lo que le queda, si se dibuja aquí (drawRoute)
  let eventList = [];     // últimos sucesos: la ficha de un aviso oficial lista los demás del mismo sitio
  let lineFeatures = [];  // trazados de las líneas: el recorrido del tren seleccionado se pega a la suya
  let byShape = new Map(); // «red|shape_id» → trazado, para lo que le queda y la flecha de cada tren
  let byNetwork = new Map(); // red → sus trazados de línea (LineString), para LINE_NETWORK
  const lineShapes = new Map(); // id del vehículo → { key, shape }: el trazado elegido, hasta que se mueva
  const shapeOf = (v) => (ROUTE_NETWORK[v.source] && v.shape && v.end ? byShape.get(`${ROUTE_NETWORK[v.source]}|${v.shape}`) : undefined);
  const routeShapeOf = (v) => {
    const trip = shapeOf(v);
    // Una línea que no es un texto (la de FGC sale tal cual de su API) no tiene trazado: con ella,
    // v.line.startsWith lanzaría y dejaría sin pintar los vehículos de todas las fuentes.
    if (trip || !LINE_NETWORK[v.source] || typeof v.line !== 'string' || !v.line || !v.end) return trip;
    // Se elige otra vez sólo cuando el tren se mueve o cambia su final: la flecha lo pide en cada lectura.
    const key = `${v.lon},${v.lat},${v.end},${v.line}`;
    const memo = lineShapes.get(v.id);
    if (memo?.key === key) return memo.shape;
    const network = byNetwork.get(LINE_NETWORK[v.source]) ?? [];
    const fits = (f) => pathBetween(f.geometry.coordinates, [v.lon, v.lat], v.end);
    // Su línea; si no, la línea de la que es refuerzo (R5R → R5); si no, cualquiera de su red que pase
    // por el tren y por su final (la cremallera de Montserrat sale en las posiciones como M1/M2 y su
    // trazado es MM). Entre el tren y su final, todas las que pasan por los dos van por la misma vía.
    const shape = network.find((f) => f.properties.line === v.line && fits(f))
      ?? network.find((f) => v.line.startsWith(f.properties.line) && fits(f))
      ?? network.find(fits);
    lineShapes.set(v.id, { key, shape });
    return shape;
  };
  /** Lo que le queda hasta el final de su viaje, por su vía; null si no se sabe. */
  const routeAhead = (v) => {
    const shape = routeShapeOf(v);
    return shape ? pathBetween(shape.geometry.coordinates, [v.lon, v.lat], v.end) : null;
  };
  const card = createDetailCard(map.getContainer().parentElement, (id) => onVehicleClick(id), (id) => {
    const e = eventList.find((x) => x.id === id);
    if (!e) return;
    setStation(null); // desde la ficha de una estación: que su repintado no tape la del suceso
    showEventCard(e);
  });
  /** Ficha de un suceso; si es una cancelación o un tren sin datos, con las paradas de su viaje en el mapa (las
   * suprimidas, o las que ya debería haber pasado, en gris). */
  function showEventCard(e) {
    const stops = e.category === 'cancelacion' || e.category === 'sin-datos' ? e.trip?.stops : null;
    setTripStops(stops?.length > 1 ? { stops: stops.map((s) => ({ ...s, lon: s.lon ?? null, lat: s.lat ?? null, eta: null })), cancelled: e.type === 'cancelado' } : null);
    card.show(eventDetail(e, samePlace(e)));
  }
  // Otros avisos oficiales del mismo sitio (en el mapa quedan unos encima de otros).
  const samePlace = (e) => (e.category === 'emergencia' && e.area
    ? eventList.filter((x) => x.category === 'emergencia' && x.id !== e.id && x.area === e.area) : []);
  let loaded = false;
  let modeFilter = null;
  let showObras = false;
  let focus = null; // { vehicleIds, eventIds } mientras hay alertas seleccionadas

  // Filtro base de cada capa de trenes y de sucesos. El modo foco le añade "y sólo estos ids";
  // qué capas se ven lo siguen decidiendo las casillas del panel.
  const category = (c) => ['==', ['get', 'category'], c];
  const VEHICLE_FILTERS = {
    'veh-halo': ['==', ['get', 'alert'], 1],
    'veh-heading': ['has', 'heading'],
    'veh-est': IS_EST,
    vehicles: NOT_EST,
    'veh-labels': null,
  };
  const EVENT_FILTERS = {
    'ev-road': () => roadFilter(false),
    'ev-road-major': () => roadFilter(true),
    'ev-works': ['all', category('carretera'), ['==', ['get', 'type'], 'roadMaintenance']],
    'ev-gdacs': category('catastrofe'),
    'ev-emerg': category('emergencia'),
    'ev-fire-glow': category('incendio'),
    'ev-fire-core': category('incendio'),
    'ev-quake': category('sismo'),
    'ev-rail': category('ferroviario'),
    'ev-cancel': category('cancelacion'),
    'ev-sin-datos': category('sin-datos'),
    'meteo-fill': null,
    'meteo-outline': null,
  };

  function applyFilters() {
    if (!loaded) return;
    const only = (ids, base) => ['all', base ?? true, ['in', ['get', 'id'], ['literal', ids]]];
    for (const [id, base] of Object.entries(VEHICLE_FILTERS)) {
      map.setFilter(id, focus ? only(focus.vehicleIds, vehicleFilter(base)) : vehicleFilter(base));
    }
    for (const [id, entry] of Object.entries(EVENT_FILTERS)) {
      const base = typeof entry === 'function' ? entry() : entry;
      map.setFilter(id, focus ? only(focus.eventIds, base) : base);
    }
  }

  const ready = new Promise((resolve) => map.on('load', resolve)).then(() => {
    const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
    spanishLabels(map);

    // Red ferroviaria del IGN: se ve entera a cualquier zoom (las vías de OpenStreetMap del mapa
    // base sólo aparecen muy de cerca). Viene en gris oscuro: se invierte para que destaque.
    map.addSource('rail-ign', {
      type: 'raster', tiles: [RAIL_TILES], tileSize: 256, bounds: TILES_BOUNDS, minzoom: 4, maxzoom: 14,
    });
    map.addLayer({
      id: 'rail-network', type: 'raster', source: 'rail-ign',
      paint: {
        'raster-brightness-min': 1, 'raster-brightness-max': 0, 'raster-saturation': -1,
        'raster-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.4, 9, 0.5, 13, 0.6],
      },
    }, firstSymbol);

    for (const id of ['lines', 'areas', 'stations', 'events', 'trails', 'route', 'track', 'stops', 'vehicles']) map.addSource(id, { type: 'geojson', data: EMPTY });

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
    map.addSource('effis', {
      type: 'raster', tiles: [EFFIS_TILES], tileSize: 256, bounds: TILES_BOUNDS, minzoom: 4, maxzoom: 12, attribution: EFFIS_ATTRIBUTION,
    });
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
      map.addImage(`emerg-plan-${sev}`, emergencyIcon('plan', color), { pixelRatio: 2 });
      map.addImage(`cancel-${sev}`, cancelIcon(color), { pixelRatio: 2 });
    }
    map.addImage('cancel-retirada', cancelIcon(SEV_COLORS.baja, { faded: true }), { pixelRatio: 2 });
    map.addImage('sin-datos', missingIcon(), { pixelRatio: 2 });
    map.addImage('emerg-luz', emergencyIcon('luz'), { pixelRatio: 2 });

    // Estaciones: punto blanco con borde oscuro, como en los planos de transporte, más grande al
    // acercar. Debajo, un círculo invisible más grande para poder pulsarlas con el dedo; de lejos,
    // más pequeño, para no tapar lo que hay alrededor.
    map.addLayer({
      id: 'stations-hit', type: 'circle', source: 'stations', minzoom: 6.5, filter: ['!', ['has', 'net']],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6.5, 7, 9, 12, 12, 14], 'circle-color': 'rgba(0, 0, 0, 0)' },
    });
    map.addLayer({
      id: 'stations-dots', type: 'circle', source: 'stations', minzoom: 5.5, filter: ['!', ['has', 'net']],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5.5, 1.5, 7, 2.3, 9, 3.2, 12, 5, 15, 7],
        'circle-color': '#f0efec', 'circle-stroke-color': '#0d0d0d',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 5.5, 0.5, 9, 1.2, 13, 2],
      },
    });
    map.addLayer({
      id: 'stations-sel', type: 'circle', source: 'stations', filter: ['==', ['get', 'code'], ''],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 6.5, 6, 12, 10, 15, 13],
        'circle-color': 'transparent', 'circle-stroke-color': '#6ea8fe', 'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      // Desde 8,5 el mapa sólo pone los nombres que caben sin montarse; al acercar salen todos.
      id: 'stations-labels', type: 'symbol', source: 'stations', minzoom: 8.5, filter: ['!', ['has', 'net']],
      layout: {
        'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 8.5, 10, 15, 13],
        'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#c3c2b7', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.4 },
    });
    // Estaciones de metro, tranvía y las demás redes: cientos en pocas ciudades, así que sólo salen
    // al acercar a una ciudad y algo más pequeñas que las de Renfe; sus nombres, más cerca todavía.
    map.addLayer({
      id: 'netst-hit', type: 'circle', source: 'stations', minzoom: 11, filter: ['has', 'net'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 7, 15, 13], 'circle-color': 'rgba(0, 0, 0, 0)' },
    });
    map.addLayer({
      id: 'netst-dots', type: 'circle', source: 'stations', minzoom: 11, filter: ['has', 'net'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 13, 3.5, 15, 5.5],
        'circle-color': '#f0efec', 'circle-stroke-color': '#0d0d0d',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.8, 15, 1.6],
      },
    });
    map.addLayer({
      id: 'netst-labels', type: 'symbol', source: 'stations', minzoom: 13, filter: ['has', 'net'],
      layout: {
        'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12],
        'text-offset': [0, 1], 'text-anchor': 'top', 'text-optional': true,
      },
      paint: { 'text-color': '#a9a89e', 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.3 },
    });
    // Estelas de todos los trenes (capa opcional) y recorrido del tren seleccionado, más visible.
    map.addLayer({
      id: 'trails-line', type: 'line', source: 'trails', layout: { visibility: 'none', 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#9db4d8', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 11, 1.6], 'line-opacity': 0.45 },
    });
    // Lo que le queda al tren seleccionado hasta su destino, por su trazado: continua, frente a su
    // recorrido ya hecho (discontinuo). Con un borde oscuro, para que se vea encima del color de
    // su propia línea.
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#0d0d0d', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 4, 12, 7], 'line-opacity': 0.8 },
    });
    map.addLayer({
      id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#a9c9ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 12, 3.5] },
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
    // Avisos oficiales (protección civil, 112): los cortes de luz, un rayo amarillo sobre fondo oscuro;
    // los planes activados, un escudo con «!» del color de su nivel. Van al centro de su isla,
    // municipio, provincia o comunidad: si en un mismo sitio hay corte de luz y plan, el rayo va a la
    // izquierda y el escudo a la derecha, y entre varios planes queda encima el de más nivel.
    const isPowerCut = ['==', ['get', 'type'], 'apagon'];
    map.addLayer({
      id: 'ev-emerg', type: 'symbol', source: 'events',
      layout: {
        'icon-image': ['case', isPowerCut, 'emerg-luz', ['concat', 'emerg-plan-', ['get', 'severity']]],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 9, 1, 13, 1.2],
        'icon-offset': ['case', isPowerCut, ['literal', [-9, 0]], ['literal', [9, 0]]],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'symbol-sort-key': ['case', isPowerCut, 10, ['match', ['get', 'severity'], 'muy alta', 3, 'alta', 2, 1]],
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
    // Trenes y autobuses cancelados (en su origen) o con paradas suprimidas (en la primera): un círculo
    // con un aspa, del color de su gravedad; los que su fuente ya no publica (hasta medianoche), desvaídos.
    map.addLayer({
      id: 'ev-cancel', type: 'symbol', source: 'events',
      layout: {
        'icon-image': ['case', ['has', 'withdrawn'], 'cancel-retirada', ['concat', 'cancel-', ['get', 'severity']]],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 1.4],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'symbol-sort-key': ['case', ['has', 'withdrawn'], 0, 1], // las vigentes, encima
      },
    });
    // Trenes que según su horario deberían estar circulando y de los que su operador no publica nada: un
    // círculo gris con una interrogación, en la última estación por la que deberían haber pasado.
    map.addLayer({
      id: 'ev-sin-datos', type: 'symbol', source: 'events',
      layout: {
        'icon-image': 'sin-datos',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.85, 10, 1.25],
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
    });
    // Paradas del viaje del vehículo seleccionado, todas, de la primera a la última y con su nombre: blancas
    // con borde azul las que le quedan, grises las que ya ha pasado; el origen, el destino y la próxima (o
    // en la que está parado), más grandes. Debajo de los vehículos, para no tapar ninguno.
    const END = ['==', ['get', 'end'], 1];
    const PASSED = ['==', ['get', 'passed'], 1];
    const NOW = ['any', ['==', ['get', 'next'], 1], ['==', ['get', 'here'], 1]]; // la próxima o en la que está
    const KEY = ['any', END, NOW];
    map.addLayer({
      id: 'stops-dot', type: 'circle', source: 'stops',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['case', KEY, 5.5, 4], 8, ['case', KEY, 7, 5], 12, ['case', KEY, 8.5, 6.5]],
        'circle-color': ['case', PASSED, '#b4b8be', '#ffffff'],
        'circle-stroke-color': ['case', PASSED, '#3a3e45', '#3d7fe0'],
        'circle-stroke-width': ['case', KEY, 3.5, 2.5],
      },
    });
    // Nombres con borde oscuro: se leen sobre el mapa, las líneas y las placas. Por debajo de la placa y su
    // anillo: si el vehículo está en la parada, su nombre no lo tapa.
    const stopLabelPaint = { 'text-color': ['case', PASSED, '#c3c6cb', '#ffffff'], 'text-halo-color': '#0d0d0d', 'text-halo-width': 1.8 };
    // Las demás, a cualquier escala: MapLibre oculta las que chocan con otras.
    map.addLayer({
      id: 'stops-label', type: 'symbol', source: 'stops', filter: ['!', KEY],
      layout: stopLabelLayout({ key: false, font: FONT }), paint: stopLabelPaint,
    });
    // Origen, destino y la próxima (o en la que está parado): siempre. Va encima de la anterior para que
    // MapLibre las coloque primero (ver trip-stops.js): así no pisan los nombres de las demás.
    map.addLayer({
      id: 'stops-label-key', type: 'symbol', source: 'stops', filter: KEY,
      layout: stopLabelLayout({ key: true, font: FONT }), paint: stopLabelPaint,
    });
    // Encima de los nombres, el hueco (invisible) del punto de cada parada: se coloca antes que ellos y así
    // ningún nombre cae sobre el punto de otra parada.
    if (!map.hasImage('stop-space')) {
      map.addImage('stop-space', { width: STOP_SPACE_PX, height: STOP_SPACE_PX, data: new Uint8Array(STOP_SPACE_PX * STOP_SPACE_PX * 4) });
    }
    map.addLayer({ id: 'stops-space', type: 'symbol', source: 'stops', layout: stopSpaceLayout(KEY) });
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
    // Flecha de hacia dónde va, pegada a la placa: el desplazamiento «hacia arriba» gira con ella.
    // Debajo de las placas, para que no tape ninguna; de cerca, donde se distingue.
    // Blanca con borde oscuro: destaca sobre la línea azul de «lo que le queda» y sobre los colores de retraso.
    map.addImage('heading-arrow', icon('arrow', '#ffffff', '#0d0d0d'), { pixelRatio: 2 });
    map.addLayer({
      id: 'veh-heading', type: 'symbol', source: 'vehicles', minzoom: 9,
      layout: {
        // Separada de la placa, por fuera del anillo de selección, para que se distinga bien.
        'icon-image': 'heading-arrow', 'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 1.15, 12, 1.5, 15, 1.7], 'icon-offset': [0, -25],
        'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true, 'icon-ignore-placement': true,
      },
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

    // Por orden de prioridad: si un tren está encima de su estación, se pulsa el tren.
    const clickable = ['vehicles', 'veh-est', 'stops-dot', 'ev-rail', 'ev-cancel', 'ev-sin-datos', 'ev-quake', 'ev-emerg', 'ev-gdacs', 'ev-road', 'ev-road-major', 'ev-works', 'stations-hit', 'netst-hit', 'ev-fire-glow', 'meteo-fill'];
    for (const id of clickable) {
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', (e) => {
      clicks++;
      const hits = map.queryRenderedFeatures(e.point, { layers: clickable });
      const f = clickable.map((id) => hits.find((h) => h.layer.id === id)).find(Boolean);
      if (!f) {
        clearSelection(); // clic en una zona vacía: se quitan el anillo, el recorrido y la ficha…
        // …pero las áreas quemadas son una imagen (WMS): se pregunta a EFFIS si hay una en ese punto.
        if (map.getLayoutProperty('effis-burnt', 'visibility') === 'visible') showBurntAreaAt(e.point);
        return;
      }
      if (['vehicles', 'veh-est'].includes(f.layer.id)) onVehicleClick(f.properties.id);
      else if (f.layer.id === 'stops-dot') showStopTip(f); // su nombre y su hora; el vehículo sigue seleccionado
      else if (['stations-hit', 'netst-hit'].includes(f.layer.id)) onStationClick?.(f.properties.code);
      else onEventClick(f.properties.id, e.lngLat);
    });

    // El nombre y la hora de cada parada al pasar el ratón por encima; con el dedo, al tocarla (clic).
    map.on('mousemove', 'stops-dot', (e) => { if (e.features?.[0]) showStopTip(e.features[0]); });
    map.on('mouseleave', 'stops-dot', () => stopTip.remove());

    loaded = true;
    applyFilters();
    kick();
  });

  const stopTip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'stop-tip', maxWidth: '240px' });
  function showStopTip(f) {
    stopTip.setLngLat(f.geometry.coordinates).setHTML(stopTipHtml(f.properties, tripStops?.stops?.length ?? 0)).addTo(map);
  }
  /** Paradas del vehículo seleccionado en el mapa (null las quita). */
  function setTripStops(data) {
    tripStops = data;
    map.getSource('stops')?.setData(data ? stopsCollection(data) : EMPTY);
    if (!data) stopTip.remove();
  }

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
    if (id !== selectedId) { // otro vehículo o ninguno: las paradas del anterior se quitan
      setTripStops(null);
      selectedVehicle = null;
      stopsFramedFor = null;
    }
    selectedId = id;
    if (id) setStation(null);
    if (loaded) map.setFilter('veh-selected', ['==', ['get', 'id'], id ?? '']);
    if (!id) {
      map.getSource('track')?.setData(EMPTY);
      map.getSource('route')?.setData(EMPTY);
    }
    map.getSource('burnt-sel')?.setData(EMPTY);
  }

  /** Pregunta a EFFIS por el área quemada bajo un punto de la pantalla y, si hay, muestra su ficha. */
  async function showBurntAreaAt(point) {
    const click = clicks; // si se pulsa otra cosa antes de que EFFIS responda, gana el último clic
    const at = map.unproject(point);
    const sw = map.unproject([point.x - 4, point.y + 4]);
    const ne = map.unproject([point.x + 4, point.y - 4]);
    // Ampliada a la rejilla de 0,05° del servidor (BURNT_GRID_DEG en server/domain/tiles.js): los clics
    // cercanos piden la misma caja y Cloudflare la sirve de su copia sin preguntar a EFFIS.
    const grid = (v, round) => Math.round(round(v / 0.05) * 5) / 100;
    const box = [grid(sw.lng, Math.floor), grid(sw.lat, Math.floor), grid(ne.lng, Math.ceil), grid(ne.lat, Math.ceil)];
    try {
      const res = await fetch(`/api/burnt-areas?bbox=${box.join(',')}`);
      const { features = [] } = res.ok ? await res.json() : {};
      if (click !== clicks) return;
      const areas = features.map((f) => lonLatFeature(f, at));
      const hit = areas.find((a) => containsPoint(a.geometry, [at.lng, at.lat])) ?? areas[0];
      if (!hit) return;
      map.getSource('burnt-sel').setData(hit);
      card.show(burntAreaDetail(hit.properties));
    } catch { /* EFFIS no responde: no se muestra nada */ }
  }

  function setStation(code) {
    selectedStation = code;
    if (loaded) map.setFilter('stations-sel', ['==', ['get', 'code'], code ?? '']);
  }

  function clearSelection() {
    setSelected(null);
    setStation(null);
    setTripStops(null); // las de una cancelación (las de un vehículo ya las quita setSelected)
    card.hide();
  }

  /**
   * Recorrido que le queda hasta el final de su viaje. Metro Bilbao y FGC: el trazado de su viaje o de
   * su línea entre donde está y donde acaba, aquí mismo. Cercanías de Renfe (pasando por sus paradas,
   * porque su trazado no siempre es el de su viaje) y posiciones estimadas (con su horario): lo
   * calcula el servidor.
   */
  const setRoute = (coords) => map.getSource('route')?.setData(coords?.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} } : EMPTY);
  /** Dibuja lo que le queda si se calcula aquí, y lo devuelve (null si no se sabe o lo calcula el servidor). */
  function drawRoute(v) {
    if (v.estimated || v.ahead) return null; // lo calcula el servidor: llega con loadTrack
    const route = routeAhead(v);
    setRoute(route);
    return route;
  }

  /**
   * Recorrido o lo que le queda de un vehículo. Si el servidor tiene demasiados cálculos a la vez (503),
   * lo vuelve a pedir pasado el tiempo que indica (Retry-After), mientras el vehículo siga seleccionado.
   */
  async function fetchTrain(url, id, tries = 3) {
    const r = await fetch(url);
    if (r.status === 503 && tries > 1 && selectedId === id) {
      const wait = Math.min(Number(r.headers.get('Retry-After')) || 2, 10) * 1000 * (1 + Math.random() / 2);
      await new Promise((resolve) => setTimeout(resolve, wait));
      return selectedId === id ? fetchTrain(url, id, tries - 1) : null;
    }
    return r.ok ? r.json() : null;
  }

  function loadTrack(v) {
    trackFetchedAt = Date.now();
    if (v.stops) {
      fetchTrain(`/api/stops/${encodeURIComponent(v.id)}`, v.id)
        .then((data) => {
          if (selectedId !== v.id) return;
          setTripStops(data?.stops?.length > 1 ? data : null);
          // Tras seleccionarlo, el mapa encuadra todo su viaje, del origen al destino, con el vehículo. Llega
          // después del vuelo hasta el vehículo de app.js (selectVehicle) y lo sustituye.
          if (tripStops && stopsFramedFor !== v.id) {
            stopsFramedFor = v.id;
            fitPoints(tripFramePoints(tripStops, v), STOP_LABEL_MARGIN);
          }
          if (card.open && selectedVehicle) card.show(vehicleDetail(selectedVehicle, !!lastRoute, tripStops));
        })
        .catch(() => {});
    } else setTripStops(null);
    if (v.ahead) {
      fetchTrain(`/api/ahead/${encodeURIComponent(v.id)}`, v.id)
        .then((ahead) => { if (selectedId === v.id) setRoute(ahead); })
        .catch(() => {});
    }
    fetchTrain(`/api/tracks/${encodeURIComponent(v.id)}`, v.id)
      .then((track) => {
        if (selectedId !== v.id) return;
        track ??= [];
        // Los trazados de su línea y el de su propio viaje, salvo si su licencia pide no alterar el contenido.
        const asPublished = AS_PUBLISHED.has(v.source);
        const own = v.line && !asPublished ? lineFeatures.filter((f) => f.properties.line === v.line && f.properties.mode === v.mode) : [];
        const trip = asPublished ? null : routeShapeOf(v);
        if (trip && !own.includes(trip)) own.push(trip);
        const parts = matchTrack(trackParts(track), own).filter((part) => part.length > 1);
        map.getSource('track').setData(parts.length ? { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: parts }, properties: {} } : EMPTY);
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

  /**
   * Encuadra una lista de puntos [lon, lat], dejando libre el hueco de la ficha y del panel de capas y, con
   * `margin`, unos píxeles más por cada lado (el nombre de las paradas de los extremos).
   * @param {number[][]} points  @param {{ left: number, right: number, top: number, bottom: number }} [margin]
   */
  function fitPoints(points, margin = null) {
    if (!points.length) return;
    if (points.length === 1) return map.flyTo({ center: points[0], zoom: Math.max(map.getZoom(), 10), speed: 1.6, offset: centerOffset() });
    const lons = points.map((p) => p[0]);
    const lats = points.map((p) => p[1]);
    const pad = sidePadding();
    const padding = margin ? Object.fromEntries(Object.entries(pad).map(([k, v]) => [k, v + (margin[k] ?? 0)])) : pad;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding, maxZoom: 11, duration: 900 });
  }

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
        // Con su trazado, la flecha va por la vía hacia donde acaba; si no, la del servidor (su movimiento).
        // Si lo que le queda lo calcula el servidor (Cercanías, con sus paradas), su flecha también.
        const shape = v.ahead ? null : routeShapeOf(v);
        const heading = (shape && headingAlong(shape.geometry.coordinates, to, v.end)) ?? v.heading;
        const props = {
          id: v.id, mode: v.mode, cls: v.cls, line: v.line ?? '', alert: alertIds.has(v.id) ? 1 : 0, est: v.estimated ? 1 : 0, picto: pictoFor(v.mode),
          ...(Number.isFinite(heading) ? { heading } : {}),
        };
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
      for (const id of lineShapes.keys()) if (!next.has(id)) lineShapes.delete(id); // trenes que ya no están
      kick();
    },

    setEvents(list) {
      eventList = list;
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
      lineFeatures = collection.features ?? [];
      byShape = new Map();
      byNetwork = new Map();
      lineShapes.clear();
      for (const f of lineFeatures) {
        for (const id of f.properties.shapes ?? []) byShape.set(`${f.properties.network}|${id}`, f);
        if (f.geometry?.type !== 'LineString') continue;
        if (!byNetwork.has(f.properties.network)) byNetwork.set(f.properties.network, []);
        byNetwork.get(f.properties.network).push(f);
      }
      if (loaded) map.getSource('lines').setData(collection);
    },

    setStations(list) {
      if (!loaded) return;
      map.getSource('stations').setData({
        type: 'FeatureCollection',
        features: list.map((s) => ({
          type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: { code: s.code, name: s.name, ...(s.networkId ? { net: s.networkId } : {}) },
        })),
      });
    },

    setModes(modes) {
      modeFilter = modes;
      applyFilters();
    },

    /**
     * Muestra sólo los trenes y sucesos indicados (alertas seleccionadas) de las capas que estén
     * encendidas; quien llama enciende antes las que hagan falta. Con null se vuelve a los
     * filtros normales.
     * @param {{ vehicleIds: string[], eventIds: string[] } | null} f
     */
    setFocus(f) {
      focus = f;
      applyFilters();
    },

    /** Encuadra una lista de puntos [lon, lat]. */
    fitTo: (points) => fitPoints(points),

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

    /** Selecciona un tren: anillo, recorrido reciente, sus paradas y ficha. La × de la ficha sólo la cierra. */
    showVehicle(v) {
      setSelected(v.id);
      stopsFramedFor = null; // también si ya estaba seleccionado: se vuelve a encuadrar su viaje
      selectedVehicle = v;
      const route = drawRoute(v);
      lastRoute = route;
      card.show(vehicleDetail(v, !!route, tripStops));
      loadTrack(v);
    },

    /** Actualiza la ficha y, cada 15 s, el recorrido del tren seleccionado cuando llegan datos. */
    refreshVehicle(v) {
      if (selectedId !== v.id) return;
      selectedVehicle = v;
      const route = drawRoute(v);
      lastRoute = route;
      if (card.open) card.show(vehicleDetail(v, !!route, tripStops));
      if (Date.now() - trackFetchedAt > 15_000) loadTrack(v);
    },

    selectedVehicleId: () => selectedId,

    showEvent(e) {
      setSelected(null);
      setStation(null);
      showEventCard(e);
    },

    /** Ficha de una estación con sus trenes (ver station-board.js); se repinta al llegar datos. */
    showStation(station, board) {
      setSelected(null);
      setTripStops(null); // las de una cancelación abierta antes
      setStation(station.code);
      card.show(stationDetail(station, board));
    },

    refreshStation(station, board) {
      if (selectedStation === station.code && card.open) card.show(stationDetail(station, board));
    },

    selectedStationCode: () => selectedStation,

    /** Estado de las fuentes (/api/health): de ahí salen la atribución y la fecha de cada ficha. */
    setSources(health) {
      sourcesById = new Map(health.map((s) => [s.id, s]));
    },

    setTrails(collection) {
      if (loaded) map.getSource('trails').setData(collection ?? EMPTY);
    },
  };
}

// Más de esto entre dos posiciones seguidas es un rato largo sin datos: el camino real no se conoce
// y una recta cruzaría el mapa por donde no hay vía. Los huecos más cortos se unen: suelen ser
// túneles (el más largo de España, Guadarrama, tiene 28 km), y por dentro la recta se parece a la vía.
const TRACK_GAP_KM = 30;

/** Recorrido [{lat, lon}] → tramos [[lon, lat], …] partidos donde faltan datos. */
export function trackParts(track) {
  const parts = [];
  let part = [];
  for (const [i, p] of track.entries()) {
    const prev = track[i - 1];
    if (prev) {
      const km = Math.hypot((p.lat - prev.lat) * 111.2, (p.lon - prev.lon) * 111.2 * Math.cos((p.lat * Math.PI) / 180));
      if (km > TRACK_GAP_KM) {
        parts.push(part);
        part = [];
      }
    }
    part.push([p.lon, p.lat]);
  }
  if (part.length) parts.push(part);
  return parts;
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
  } else if (shape === 'arrow') {
    g.moveTo(7, 2); g.lineTo(12, 11); g.lineTo(7, 8.6); g.lineTo(2, 11);
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

/** Icono de las cancelaciones: un círculo del color de su gravedad con un aspa oscura (`faded`: desvaído,
 * las que su fuente ya no publica). */
export function cancelIcon(fill, { faded = false } = {}) {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(2, 2);
  if (faded) g.globalAlpha = 0.5;
  g.beginPath();
  g.arc(7, 7, 5.9, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  g.lineWidth = 1.2;
  g.strokeStyle = '#0d0d0d';
  g.stroke();
  g.beginPath();
  g.moveTo(4.6, 4.6); g.lineTo(9.4, 9.4); g.moveTo(9.4, 4.6); g.lineTo(4.6, 9.4);
  g.lineWidth = 1.7;
  g.lineCap = 'round';
  g.stroke();
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

/** Icono de los trenes sin datos: un círculo gris claro con una interrogación oscura. */
export function missingIcon() {
  const size = 28;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(2, 2);
  g.beginPath();
  g.arc(7, 7, 5.9, 0, Math.PI * 2);
  g.fillStyle = '#b9b8b2';
  g.fill();
  g.lineWidth = 1.2;
  g.strokeStyle = '#0d0d0d';
  g.stroke();
  g.fillStyle = '#0d0d0d';
  g.font = 'bold 9px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('?', 7, 7.6);
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

/**
 * Iconos de los avisos oficiales: 'luz' (corte de luz), un rayo amarillo sobre un círculo oscuro;
 * 'plan' (plan de emergencias), un escudo con «!» del color de su nivel.
 */
export function emergencyIcon(kind, color = '#ec835a') {
  const size = 36;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.scale(2, 2);
  g.lineJoin = 'round';
  if (kind === 'luz') {
    g.beginPath(); g.arc(9, 9, 7.9, 0, Math.PI * 2);
    g.fillStyle = '#0d0d0d'; g.fill();
    g.lineWidth = 1.4; g.strokeStyle = '#ffd23f'; g.stroke();
    g.beginPath();
    g.moveTo(10.4, 3.2); g.lineTo(5.6, 10); g.lineTo(8.7, 10); g.lineTo(7.6, 14.8); g.lineTo(12.4, 7.7); g.lineTo(9.3, 7.7);
    g.closePath(); g.fillStyle = '#ffd23f'; g.fill();
  } else {
    g.beginPath();
    g.moveTo(9, 1.4); g.lineTo(15.6, 3.9); g.lineTo(15.6, 8.6);
    g.bezierCurveTo(15.6, 12.6, 12.8, 15.4, 9, 16.7); g.bezierCurveTo(5.2, 15.4, 2.4, 12.6, 2.4, 8.6);
    g.lineTo(2.4, 3.9); g.closePath();
    g.fillStyle = color; g.fill();
    g.lineWidth = 1.4; g.strokeStyle = '#0d0d0d'; g.stroke();
    g.fillStyle = '#0d0d0d';
    g.beginPath(); g.roundRect(8.05, 4.6, 1.9, 6, 0.9); g.fill();
    g.beginPath(); g.arc(9, 12.7, 1.1, 0, Math.PI * 2); g.fill();
  }
  return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
}

/** Ficha fija sobre el mapa (sustituye a las ventanas emergentes, que tapaban el recorrido). */
function createDetailCard(host, onVehicle, onEvent) {
  const el = document.createElement('div');
  el.className = 'card detail';
  el.hidden = true;
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', 'Detalle del elemento seleccionado');
  el.innerHTML = '<button type="button" class="detail-close" aria-label="Cerrar ficha">×</button><div class="detail-body"></div>';
  el.querySelector('.detail-close').addEventListener('click', () => { el.hidden = true; });
  // Si se abre o se cierra la lista de paradas, se queda así al repintar la ficha ('toggle' no sube: captura).
  el.addEventListener('toggle', (ev) => {
    if (ev.target.dataset?.keep === 'stops') stopsListOpen = ev.target.open;
  }, true);
  // Los trenes de la ficha de una estación abren la del tren.
  el.addEventListener('click', (ev) => {
    const train = ev.target.closest('[data-vehicle]');
    if (train) onVehicle(train.dataset.vehicle);
    const other = ev.target.closest('[data-event]');
    if (other) onEvent?.(other.dataset.event);
  });
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


function stationDetail(st, { stopped, arriving, notices, lines, connections = [], cancellations = [], missing = [] }) {
  const train = (v, when) => `<li><button type="button" class="link" data-vehicle="${esc(v.id)}">${esc(vehicleTitle(v))}</button>
    ${v.destination ? ` → ${esc(v.destination)}` : ''}${v.platform ? ` · vía ${esc(v.platform)}` : ''}${when ? ` · ${esc(when)}` : ''}
    <span class="st-delay">${esc(fmtDelay(v))}</span></li>`;
  const when = (v) => (v.nextEta ? fmtLocalHour(v.nextEta) : Number.isFinite(v.nextInMinutes) ? `en ${v.nextInMinutes} min` : '');
  const list = (items, empty) => (items.length ? `<ul class="st-list">${items.join('')}</ul>` : `<p class="st-empty">${empty}</p>`);
  const chips = (ls) => `<div class="st-lines">${ls.map((l) => `<span class="st-line" style="--line:${esc(l.color ?? '#898781')}" title="${esc(l.network ?? '')}">${esc(l.line)}</span>`).join('')}</div>`;
  const link = (url, label) => (safeUrl(url) ? `<a href="${esc(safeUrl(url))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '');
  const meta = [st.network, st.place, st.province && st.province !== st.place ? st.province : null, st.cercanias ? 'Cercanías / Rodalies' : null].filter(Boolean);
  const address = [st.address, [st.postalCode, st.place].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const accessible = { true: 'Sí', false: 'No', partial: 'En parte' }[st.accessible] ?? 'Sin datos';
  const rows = [
    address && ['Dirección', address],
    ['Accesible en silla de ruedas', st.accessibleSource ? `${accessible} (según ${st.accessibleSource})` : accessible],
    st.opened && ['Inaugurada', String(st.opened)],
    st.tracks && ['Vías', String(st.tracks)],
    st.metricGauge && ['Ancho de vía', 'Métrico (antigua FEVE)'],
    !st.networkId && ['Código', st.code],
  ].filter(Boolean);
  // Las de otras redes salen del GTFS de su operador en el NAP: su atribución y la fecha de sus datos.
  // «Powered by MITRAMS», «Powered by CRTM» y «Powered by TRAM Barcelona» van con su enlace, como pide
  // su licencia (igual que en el pie del mapa).
  // Las de Renfe, de sus datos abiertos: «Origen de los datos: Renfe Operadora» y el día en que se descargaron.
  const day = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso ?? '') ? iso.slice(0, 10).split('-').reverse().join('/') : null);
  const updated = day(st.source?.updated);
  const downloaded = day(st.source?.downloaded);
  const creditText = st.source?.credit ?? (st.networkId ? null : 'Origen de los datos: Renfe Operadora');
  const source = creditText ? `<p class="st-source">Datos de la estación: ${creditHtml(creditText)}${updated ? ` · actualizados el ${esc(updated)}`
    : downloaded ? ` · descargados el ${esc(downloaded)}` : ''}</p>` : '';
  // La foto viene de Wikimedia Commons: su licencia pide citar título, autor y licencia junto a ella.
  // El título es el nombre del fichero, que enlaza a su página en Commons.
  const photoTitle = st.photo ? photoTitleOf(st.photo.page) : null;
  const photo = st.photo && safeUrl(st.photo.url) ? `<figure class="st-photo"><img src="${esc(safeUrl(st.photo.url))}" alt="Estación de ${esc(st.name)}" loading="lazy">
    <figcaption>Foto: ${photoTitle ? `${link(st.photo.page, photoTitle)}, de ` : ''}${esc(st.photo.author)} · ${st.photo.licenseUrl ? link(st.photo.licenseUrl, st.photo.license) : esc(st.photo.license)} · ${photoTitle ? 'Wikimedia Commons' : link(st.photo.page, 'Wikimedia Commons')}</figcaption></figure>` : '';
  // Sólo enlaces: no se carga nada de esas webs hasta que se pulsan. El de Google Maps usa su
  // formato público de enlaces (Maps URLs): en el móvil abre la app con la ruta hasta la estación.
  const links = [
    link(`https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lon}`, 'Cómo llegar (Google Maps)'),
    link(st.wikipedia, 'Wikipedia'),
    link(st.sheet, 'Ficha técnica de Renfe (PDF, 2019)'),
    link(`https://www.openstreetmap.org/?mlat=${st.lat}&mlon=${st.lon}#map=17/${st.lat}/${st.lon}`, 'OpenStreetMap'),
  ].filter(Boolean);
  return `<div class="pop">${photo}<h3>${esc(st.name)}</h3>${meta.length ? `<p class="st-meta">${esc(meta.join(' · '))}</p>` : ''}
    ${lines.length ? chips(lines) : ''}
    <h4>En la estación ahora</h4>${list(stopped.map((v) => train(v)), 'Ningún tren parado ahora mismo.')}
    <h4>Próximos trenes</h4>${list(arriving.map((v) => train(v, when(v))), 'Ningún tren en camino con datos en directo.')}
    ${notices.length ? `<h4>Avisos de Renfe</h4><ul class="st-list">${notices.map((e) => `<li>${esc(e.description ?? e.title)}</li>`).join('')}</ul>` : ''}
    ${cancellations.length ? `<h4>Cancelaciones que pasan por aquí</h4><ul class="st-list">${cancellations.map((c) => `<li><button type="button" class="link" data-event="${esc(c.id)}">${esc(c.title)}</button>${c.time ? ` · ${c.first ? 'salía' : c.last ? 'llegaba' : 'pasaba'} a las ${esc(c.time)}` : ''}${c.skipped ? ' · <strong>no para aquí</strong>' : ''}${c.withdrawn ? ' · ya no se publica' : ''}</li>`).join('')}</ul>` : ''}
    ${missing.length ? `<h4>Trenes sin datos que pasan por aquí</h4><ul class="st-list">${missing.map((c) => `<li><button type="button" class="link" data-event="${esc(c.id)}">${esc(c.title)}</button>${c.time ? ` · ${c.passed ? (c.first ? 'salía' : 'pasaba') : c.first ? 'sale' : c.last ? 'llega' : 'pasa'} a las ${esc(c.time)} según su horario` : ''}</li>`).join('')}</ul>` : ''}
    ${connections.length ? `<h4>Conexiones a pie</h4>${chips(connections)}` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>
    <p class="st-links">${links.join(' · ')}</p>${source}${telegramFollow(st.follow)}
    <div class="note">${st.networkId ? 'Salen los trenes con posición en directo o estimada a partir del horario' : 'Sólo salen los trenes que publican su posición en directo'}; los horarios completos están en la web del operador.
      Pulsa un tren para ver su ficha.</div></div>`;
}

// Fuentes por id, de /api/health. Las licencias (TMB, AMB, TRAM, Renfe…) piden citar la fuente y la
// fecha de actualización donde se ven sus datos: en la ficha de cada tren y de cada suceso.
let sourcesById = new Map();

/**
 * Filas «Atribución» y «Actualizado» de una ficha: el texto que pide la licencia (en un grupo de
 * operadores, la del suyo) y la fecha del horario o la hora del dato según la fuente. Si aún no se
 * conoce, la hora a la que se leyó.
 */
function sourceRows(id, operator) {
  const s = sourcesById.get(id);
  if (!s) return [['Fuente', id]]; // todavía sin el estado de las fuentes
  const schedule = s.datasetUpdatedBy?.[operator] ?? s.datasetUpdated;
  const dates = [
    schedule && `horario del ${fmtDate(schedule)}`,
    s.sourceTime ? `datos ${fmtDataTime(s.sourceTime)}` : !schedule && s.lastOk && `leídos ${fmtDataTime(s.lastOk)}`,
  ].filter(Boolean);
  // «Atribución» y no «Fuente»: muchas ya empiezan por «Fuente: …» u «Origen de los datos: …».
  // La atribución va como HTML: las que lo piden llevan su enlace (ver creditHtml).
  return [['Atribución', { html: creditHtml(s.operatorLicenses?.[operator] ?? s.license ?? s.name) }], dates.length && ['Actualizado', dates.join(' · ')]];
}

/**
 * Ficha de una cancelación: qué tren, de dónde a dónde y a qué hora, qué paradas se suprimen, quién lo
 * publica, en qué fichero y desde cuándo lo ve el radar (las fuentes no dicen cuándo lo publicaron).
 */
export function cancellationDetail(e, now = Date.now()) {
  const t = e.trip;
  const bus = t.mode === 'bus';
  const was = e.type === 'cancelado' ? 'Cancelado: no circula'
    : t.endsAt ? `Circula, pero termina en ${t.endsAt}`
      : t.startsAt ? `Circula, pero empieza en ${t.startsAt}`
        : `Circula sin parar en ${t.skipped.length === 1 ? t.skipped[0] : `${t.skipped.length} ${bus ? 'paradas' : 'estaciones'}`}`;
  // Una que su fuente ya no publica: lo que decía y cuándo lo retiró.
  const state = e.withdrawn
    ? `Ya no lo publica (desde las ${fmtTime(e.withdrawn)}). Lo que decía: ${was.charAt(0).toLowerCase()}${was.slice(1)}`
    : was;
  const link = (n) => {
    const url = safeUrl(n.url && !/^https?:/i.test(n.url) ? `https://${n.url}` : n.url);
    return { html: `${esc(n.text)}${url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">Más información</a>` : ''}` };
  };
  const who = [t.service, t.line, t.number].filter((x, i, all) => x && all.indexOf(x) === i).join(' ');
  const feedLink = (name, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${esc(safe)}" target="_blank" rel="noopener">${esc(name)}</a>` : esc(name);
  };
  // El mismo tren en otro feed del operador (los regionales de Rodalies también van en el de AV/LD/MD).
  const also = (t.alsoIn ?? []).map((o) => ` y en su ${feedLink(o.feed, o.feedUrl)} (como ${esc(o.as)}${o.withdrawn ? `; ahí dejó de publicarlo a las ${fmtTime(o.withdrawn)}` : ''})`).join('');
  const published = { html: `${esc(t.publisher)}, en su ${feedLink(t.feed, t.feedUrl)}${also}` };
  const today = fmtDate(e.seen) === fmtDate(now);
  const at = `${today ? '' : `el ${fmtDate(e.seen)} `}a las ${fmtTime(e.seen)}`;
  const seen = e.seen ? `${t.publisher} no dice cuándo lo publicó. El radar lo vio por primera vez ${at} (${timeAgo(e.seen, now)})`
    + (e.seenAtStart ? '; ya estaba publicado cuando el radar empezó a leer esta fuente, así que pudo publicarse antes' : '') : null;
  const rows = [
    ['Estado', state],
    ['Gravedad', SEVERITY_LABEL[e.severity] ?? e.severity],
    [bus ? 'Línea' : 'Tren', who || null],
    ['Operador', t.operator],
    t.origin && t.destination && ['Recorrido', `${t.origin} → ${t.destination}`],
    t.departure && ['Salida según el horario', `${t.departure}, de ${t.origin}`],
    t.arrival && ['Llegada según el horario', `${t.arrival}, a ${t.destination}`],
    ['Día', t.date ? fmtDate(Date.parse(`${t.date}T12:00:00Z`)) : `${t.publisher} no lo dice en su tiempo real`],
    t.trips > 1 && ['Expediciones afectadas', String(t.trips)],
    t.skipped?.length && ['Paradas suprimidas', t.skipped.join('; ')],
    t.reason && ['Motivo', t.reason],
    t.notice && [`Aviso de ${t.publisher}`, link(t.notice)],
    ...(t.lineNotices ?? []).map((n, i) => [i === 0 ? (t.line ? `Avisos de la ${t.line}` : 'Avisos de la línea') : '', link(n)]),
    ['Lo publica', published],
    seen && ['Desde cuándo', seen],
    e.withdrawn && ['Hasta cuándo', `${t.publisher} dejó de publicarlo a las ${fmtTime(e.withdrawn)}${t.withdrawnAfterArrival === true
      ? ', después de su hora de llegada: lo normal con los viajes que ya han pasado'
      : t.withdrawnAfterArrival === false ? ', antes de su hora de llegada: puede que al final circule' : ''}. Se ve aquí hasta medianoche`],
    t.cancelled && t.running && ['Ojo', `${t.publisher} lo da a la vez como cancelado y en servicio (con su retraso, su posición o paradas suprimidas)`],
    // La atribución de su tiempo real (la de la fuente puede hablar de la posición estimada: Euskotren, AMB).
    ...sourceRows(e.source).map((r) => (r && r[0] === 'Atribución' && e.credit ? ['Atribución', { html: creditHtml(e.credit) }] : r)),
  ].filter((r) => r && r[1]);
  const list = t.stops?.length > 1 ? cancelledStopsHtml(t.stops, e.type === 'cancelado') : '';
  return `<div class="pop"><h3>${esc(e.title)}</h3>${e.description ? `<p>${esc(e.description)}</p>` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>${telegramFollow(t.follow, t.mode)}${list}
    <div class="note">Las horas son las del horario del operador. Si el operador deja de publicarlo, sigue aquí hasta medianoche
    como «ya no lo publica»; si su fuente deja de responder, se muestra como mucho una hora más.</div></div>`;
}

/**
 * Ficha de un tren sin datos: según su horario debería estar circulando y su operador no publica nada de él.
 * No es una cancelación: no se sabe si circula.
 */
export function missingTrainDetail(e, now = Date.now()) {
  const t = e.trip;
  const who = [t.service, t.number].filter(Boolean).join(' ');
  const feed = safeUrl(t.feedUrl);
  const looked = feed ? { html: `<a href="${esc(feed)}" target="_blank" rel="noopener">${esc(t.feed)}</a> de ${esc(t.publisher)}` } : `${t.feed} de ${t.publisher}`;
  const today = fmtDate(e.seen) === fmtDate(now);
  const rows = [
    ['Estado', `Sin datos: ${t.publisher} no publica nada de este tren. No se sabe si circula`],
    ['Tren', who || null],
    ['Operador', t.operator],
    t.origin && t.destination && ['Recorrido', `${t.origin} → ${t.destination}`],
    t.departure && ['Salida según el horario', `${t.departure}, de ${t.origin}`],
    t.arrival && ['Llegada según el horario', `${t.arrival}, a ${t.destination}`],
    t.between && ['Ahora iría', `entre ${t.between[0]} y ${t.between[1]}, según su horario`],
    t.date && ['Día', fmtDate(Date.parse(`${t.date}T12:00:00Z`))],
    ['Qué se ha mirado', looked],
    ['Qué falta', 'Su posición, su retraso y su cancelación: no sale en ninguno de los dos ficheros'],
    e.seen && ['Desde cuándo', `El radar lo echa en falta desde las ${today ? '' : `${fmtDate(e.seen)} `}${fmtTime(e.seen)} (${timeAgo(e.seen, now)})`],
    ...sourceRows(e.source).map((r) => (r && r[0] === 'Atribución' && e.credit ? ['Atribución', { html: creditHtml(e.credit) }] : r)),
  ].filter((r) => r && r[1]);
  const list = t.stops?.length > 1 ? missingStopsHtml(t.stops) : '';
  return `<div class="pop"><h3>${esc(e.title)}</h3>${e.description ? `<p>${esc(e.description)}</p>` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>${telegramFollow(t.follow, t.mode)}${list}
    <div class="note">Sale si, según el horario publicado, debería llevar más de 10 minutos circulando y le quedan más de 5 para llegar,
    y su operador no publica ni su posición ni su retraso ni su cancelación. Puede circular sin que se publique, o no circular sin que se
    haya publicado su cancelación.</div></div>`;
}

/** Paradas del tren sin datos, con su hora del horario; en gris, las que ya debería haber pasado. */
function missingStopsHtml(stops) {
  const items = stops.map((s, i) => {
    const cls = [s.passed && 'passed', (i === 0 || i === stops.length - 1) && 'end'].filter(Boolean).join(' ');
    return `<li${cls ? ` class="${cls}"` : ''}><span class="ts-name">${esc(s.name)}</span>${s.time ? `<span class="ts-time">${esc(s.time)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="trip-stops" open><summary>Paradas según su horario · ${stops.length}</summary><ol>${items}</ol></details>`;
}

/** Paradas del viaje cancelado, con su hora del horario y las suprimidas tachadas. */
function cancelledStopsHtml(stops, whole) {
  const skipped = stops.filter((s) => s.skipped).length;
  const summary = whole ? `Paradas del viaje cancelado · ${stops.length}` : `Paradas · ${skipped} suprimida${skipped === 1 ? '' : 's'} de ${stops.length}`;
  const items = stops.map((s, i) => {
    const cls = [s.skipped && 'skipped', (i === 0 || i === stops.length - 1) && 'end'].filter(Boolean).join(' ');
    const when = [s.time, s.skipped && 'suprimida'].filter(Boolean).join(' · ');
    return `<li${cls ? ` class="${cls}"` : ''}><span class="ts-name">${esc(s.name)}</span>${when ? `<span class="ts-time">${esc(when)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="trip-stops cancelled-stops" open><summary>${summary}</summary><ol>${items}</ol></details>`;
}

// La lista de paradas de la ficha se queda abierta o cerrada como la deje cada uno (la ficha se repinta
// con cada lectura); hasta entonces, abierta en pantallas anchas y cerrada en el móvil.
let stopsListOpen = null;

/**
 * @param {object} v  @param {boolean} [onRoute] se dibuja lo que le queda hasta su final
 * @param {import('./trip-stops.js').TripStops|null} [stops] paradas de su viaje
 */
function vehicleDetail(v, onRoute = false, stops = null) {
  // La vía es la de una estación (en la que está parado o a la que llega), nunca la del trayecto:
  // va pegada a esa estación para que no se lea como la vía por la que circula.
  const via = v.platform ? ` · vía ${v.platform}` : '';
  const rows = [
    ['Tipo', MODE_LABEL[v.mode] ?? v.mode],
    (v.origin || v.destination) && ['Recorrido', `${v.origin ?? '?'} → ${v.destination ?? '?'}`],
    ['Retraso', fmtDelay(v)],
    v.current && [v.stopped ? 'Parado en' : v.mode === 'bus' ? 'Última parada' : 'Última estación', `${v.current}${v.stopped ? via : ''}`],
    // El operador lo da parado en una estación lejos de su posición: la del mapa no está al día.
    v.farFromStop && v.current && ['Posición', `${v.source?.startsWith('renfe') ? 'Renfe' : 'El operador'} la da a ${v.farFromStop.toLocaleString('es-ES', { maximumFractionDigits: 1 })} km de ${v.current}: puede que no esté al día`],
    v.next && ['Próxima', `${v.next}${v.nextEta ? ` (${fmtLocalHour(v.nextEta)})` : v.nextInMinutes !== undefined && v.nextInMinutes !== null ? ` (en ${v.nextInMinutes} min)` : ''}${v.stopped ? '' : via}`],
    v.area && ['Núcleo', v.area],
    v.rollingStock && ['Material', v.rollingStock],
    v.fixTime && ['GPS', timeAgo(v.fixTime)],
    ...sourceRows(v.source, v.operator),
  ].filter(Boolean);
  const aheadText = (how) => `La <strong>línea azul clara continua</strong> (con borde oscuro) es lo que le queda hasta ${esc(v.destination ?? 'su destino')}${how}. `;
  const ahead = onRoute || v.ahead ? aheadText('') : '';
  const note = !v.estimated
    ? `${ahead}La <strong>línea azul discontinua</strong> es el recorrido de este tren en los últimos 45 min (desde que el radar lo sigue). `
      + 'La × sólo cierra esta ficha; pulsa en una zona vacía del mapa para quitar el recorrido y «Ver todo» para volver a verlo todo.'
    : (v.delay !== null && v.delay !== undefined
      ? '<strong>Posición estimada</strong> a partir del horario y del retraso real que publica el operador: no es GPS. '
      : '<strong>Posición estimada</strong> a partir del horario publicado: no es GPS y no refleja retrasos. ')
      + (v.atLastStop
        ? 'El operador no publica el recorrido entre paradas, así que se muestra en la última parada por la que ha pasado.'
        : 'Se mueve a saltos, en cada actualización. Si su ruta tiene trazado publicado, la <strong>línea azul discontinua</strong> '
          + 'es el tramo que habría recorrido en los últimos 45 min según el horario.')
      + (v.ahead ? ` ${aheadText(', según el horario').trim()}` : '');
  const badge = v.estimated ? '<div class="est-badge">Posición estimada · no es GPS</div>' : '';
  const open = stopsListOpen ?? !window.matchMedia('(max-width: 860px)').matches;
  const list = stops ? stopsListHtml(stops, { open }) : '';
  const stopsNote = list ? ' Los <strong>puntos</strong> son sus paradas: blancos los que le quedan y grises por los que ya ha pasado.'
    + (v.estimated ? ' Sus horas son las del horario.' : '') : '';
  return `<div class="pop"><h3>${esc(vehicleTitle(v))}</h3>${badge}<dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>
    ${telegramFollow(v.follow, v.mode)}${list}<div class="note">${note}${stopsNote}</div></div>`;
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
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>
    <div class="note">Perímetro estimado por satélite por el sistema europeo de incendios forestales (EFFIS), no es un
    dato oficial de extinción. <a href="https://forest-fire.emergency.copernicus.eu/apps/effis.csv/" target="_blank" rel="noopener">Ver en EFFIS</a></div></div>`;
}

const fmtArea = (ha) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 }).format(Number(ha));

// Los avisos oficiales no traen coordenadas: se sitúan en el centro de lo que nombran.
const APPROX_LABEL = {
  isla: 'aproximada: el centro de la isla',
  municipio: 'aproximada: el centro de la localidad (Obra derivada de CartoCiudad 2026 CC-BY 4.0 scne.es)',
  provincia: 'aproximada: el centro de la provincia',
  comunidad: 'aproximada: el aviso no dice el lugar exacto (centro de la comunidad)',
};

/** @param {object} e  @param {object[]} [others] otros avisos oficiales del mismo sitio */
function eventDetail(e, others = []) {
  if (e.category === 'cancelacion' && e.trip) return cancellationDetail(e);
  if (e.category === 'sin-datos' && e.trip) return missingTrainDetail(e);
  const rows = [
    ['Gravedad', SEVERITY_LABEL[e.severity] ?? e.severity],
    e.issued && ['Emitido', e.issuedDayOnly ? fmtDate(e.issued) : fmtDateTime(e.issued)], // algunas fuentes sólo dan el día
    e.start && ['Inicio', fmtDateTime(e.start)],
    e.end && ['Fin previsto', fmtDateTime(e.end)],
    e.updated && ['Última revisión', fmtDateTime(e.updated)], // de la incidencia en su fuente (DGT)
    e.area && ['Lugar', e.area],
    e.approx && ['Ubicación', APPROX_LABEL[e.approx] ?? 'aproximada'],
    ...sourceRows(e.source),
  ].filter(Boolean);
  const url = safeUrl(e.url);
  const link = url ? `<div class="note"><a href="${esc(url)}" target="_blank" rel="noopener">Ficha oficial</a></div>` : '';
  const more = others.length ? `<h4>Otros avisos oficiales en ${esc(e.area)}</h4><ul class="st-list">${others
    .map((o) => `<li><button type="button" class="link" data-event="${esc(o.id)}">${o.power ? 'Corte de luz: ' : ''}${esc(o.title)}</button></li>`).join('')}</ul>` : '';
  return `<div class="pop"><h3>${esc(e.title)}</h3>${e.description ? `<p>${esc(e.description)}</p>` : ''}
    <dl>${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${val?.html ?? esc(val)}</dd>`).join('')}</dl>${link}${more}</div>`;
}
