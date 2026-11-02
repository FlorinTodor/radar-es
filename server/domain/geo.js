const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

/** Grados redondeados a 5 decimales (~1 m): de sobra para el mapa, y el JSON pesa mucho menos. */
export const round5 = (x) => Math.round(x * 1e5) / 1e5;

/**
 * Caja lon/lat [oeste, sur, este, norte] de España: la Península, Baleares, Canarias, Ceuta y Melilla
 * con un margen de unos 20-35 km, de El Hierro (-18,16) a Menorca (4,33) y de La Restinga (27,64) a
 * Estaca de Bares (43,79). Es la única: las teselas que se sirven (domain/tiles.js), los lugares que
 * se aceptan del geocodificador y la zona de las catástrofes de GDACS (con su margen) salen de aquí.
 * Los mismos valores están en public/js/map.js (`bounds` de las capas raster); una prueba lo vigila.
 */
export const SPAIN_BOUNDS = Object.freeze([-18.5, 27.4, 4.6, 44.0]);

/** ¿Está el punto dentro de la caja [oeste, sur, este, norte] (bordes incluidos)? */
export const inBounds = ([west, south, east, north], lat, lon) => lat >= south && lat <= north && lon >= west && lon <= east;

/** La caja con `deg` grados más por cada lado. */
export const widenBounds = ([west, south, east, north], deg) => Object.freeze([west - deg, south - deg, east + deg, north + deg]);

// Proyección local (equirectangular) para distancias en metros entre puntos cercanos: más barata que
// la de la esfera y, en tramos de pocos km (o unos cientos, a lo largo de una vía), con error de
// milésimas. La usan los trazados (schedule.js, route-ahead.js) y la red ferroviaria (rail-match.js).
/** Metros por grado de latitud. */
export const M_PER_DEG_LAT = 110_540;
/** Metros por grado de longitud a la latitud `lat`. */
export const mPerDegLon = (lat) => 111_320 * Math.cos(lat * RAD);

/** Rumbo en grados [0, 360) redondeado de 5 en 5: lo que hace falta para una flecha (y el JSON pesa menos). */
export const roundBearing5 = (deg) => (Math.round((((deg % 360) + 360) % 360) / 5) * 5) % 360;

export function distanceKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** Rumbo de un punto a otro, en grados desde el norte y de 5 en 5 (lo que hace falta para una flecha). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return roundBearing5(Math.atan2(y, x) / RAD);
}

/** Punto dentro de un anillo [[lon, lat], ...] (ray casting). */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Punto dentro de una geometría GeoJSON Polygon o MultiPolygon (respeta los huecos). */
export function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
}

/** Centro aproximado (media de vértices) de un Polygon/MultiPolygon; suficiente para centrar el mapa. */
export function roughCentroid(geometry) {
  const rings = geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((p) => p[0]);
  const pts = rings.flat();
  return { lon: pts.reduce((s, p) => s + p[0], 0) / pts.length, lat: pts.reduce((s, p) => s + p[1], 0) / pts.length };
}

