// Qué teselas de las capas externas (red ferroviaria del IGN, áreas quemadas de EFFIS) se sirven.
// Cada tesela servida se descarga del servicio original y se guarda en disco, así que sólo se
// aceptan las que el mapa puede pedir: las que tocan España y hasta el zoom máximo de cada capa
// (más cerca, el mapa amplía la última). Así nadie puede llenar el disco pidiendo el mundo entero
// a zoom 19, ni hacer que machaquemos al IGN o a EFFIS.
//
// Los mismos valores están en las fuentes raster de public/js/map.js (`bounds`, `minzoom`,
// `maxzoom`), para que el mapa nunca pida una tesela que aquí se rechaza.
import { SPAIN_BOUNDS } from './geo.js';

/**
 * Zooms de tesela (256 px) que se sirven de cada capa. Una capa que no está aquí no se sirve.
 * - El mínimo es el del mapa: con `minZoom: 3`, MapLibre pide teselas de 256 px de zoom 4.
 * - ign-rail: a zoom 14 ya se ven las vías con el detalle del dato (~7 m por píxel) y el mapa
 *   base dibuja las suyas desde el zoom 13. Como mucho 1,3 millones de teselas en la caja.
 * - effis: las áreas quemadas salen de MODIS (250 m por píxel): a zoom 12 sobra detalle. Como
 *   mucho 83.000 teselas.
 */
export const TILE_LAYERS = Object.freeze({
  'ign-rail': Object.freeze({ minzoom: 4, maxzoom: 14 }),
  effis: Object.freeze({ minzoom: 4, maxzoom: 12 }),
});

// Proyección web Mercator normalizada a [0, 1], con las mismas fórmulas que MapLibre.
const mercatorX = (lon) => (180 + lon) / 360;
const mercatorY = (lat) => (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

/**
 * Rango de teselas XYZ de zoom `z` que tocan una caja lon/lat. Es el mismo cálculo que hace
 * MapLibre con el `bounds` de una fuente, así que coincide con lo que el mapa pide.
 * @param {readonly number[]} bounds  [oeste, sur, este, norte]
 * @param {number} z
 */
export function tileRange([west, south, east, north], z) {
  const n = 2 ** z;
  return {
    minX: Math.floor(mercatorX(west) * n),
    maxX: Math.ceil(mercatorX(east) * n) - 1,
    minY: Math.floor(mercatorY(north) * n),
    maxY: Math.ceil(mercatorY(south) * n) - 1,
  };
}

/**
 * ¿Se sirve la tesela z/x/y de esta capa? Sólo si la capa existe, el zoom está en su rango y la
 * tesela toca la caja.
 * @param {string} layer
 * @param {number} z
 * @param {number} x
 * @param {number} y
 */
export function isServableTile(layer, z, x, y, { layers = TILE_LAYERS, bounds = SPAIN_BOUNDS } = {}) {
  const zooms = Object.hasOwn(layers, layer) ? layers[layer] : null;
  if (!zooms || ![z, x, y].every(Number.isInteger) || z < zooms.minzoom || z > zooms.maxzoom) return false;
  const r = tileRange(bounds, z);
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/**
 * Número máximo de teselas que puede llegar a guardar una capa (todas las de la caja en su rango de zoom).
 * Herramienta de cálculo: el servidor no la usa. Sirve para elegir el zoom máximo de cada capa sabiendo
 * cuánto disco puede llegar a ocupar (las cifras de TILE_LAYERS salen de aquí, y las pruebas las vigilan).
 */
export function maxTileCount(layer, { layers = TILE_LAYERS, bounds = SPAIN_BOUNDS } = {}) {
  const zooms = layers[layer];
  if (!zooms) return 0;
  let total = 0;
  for (let z = zooms.minzoom; z <= zooms.maxzoom; z++) {
    const r = tileRange(bounds, z);
    total += (r.maxX - r.minX + 1) * (r.maxY - r.minY + 1);
  }
  return total;
}

/** Lado máximo, en grados, de la caja de áreas quemadas: lo que hay bajo un clic, no una región. */
const MAX_BURNT_BOX_DEG = 0.5;
/**
 * Rejilla, en grados (unos 5 km), a la que se amplía la caja de áreas quemadas. Los clics cercanos
 * piden la misma caja, que Cloudflare guarda una vez, y nadie puede generar infinitas variantes
 * distintas para que las pidamos todas a EFFIS. El mismo valor está en public/js/map.js.
 */
export const BURNT_GRID_DEG = 0.05;

/**
 * Caja [oeste, sur, este, norte] que se pide a EFFIS: la del clic, ampliada a la rejilla. null si no
 * es una caja bien formada, es más grande que lo que hay bajo un clic o no toca España.
 * @param {unknown} bbox
 */
export function burntAreaBox(bbox, { bounds = SPAIN_BOUNDS } = {}) {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) return null;
  const [west, south, east, north] = bbox;
  if (!(east > west && north > south) || east - west >= MAX_BURNT_BOX_DEG || north - south >= MAX_BURNT_BOX_DEG) return null;
  if (east < bounds[0] || west > bounds[2] || north < bounds[1] || south > bounds[3]) return null;
  // El ±1e-9 evita que un valor que ya está en la rejilla (-3.9 = -78 × 0,05) salte a la siguiente.
  const grid = (v, round) => Math.round(round(v / BURNT_GRID_DEG + (round === Math.floor ? 1e-9 : -1e-9)) * BURNT_GRID_DEG * 100) / 100;
  return [grid(west, Math.floor), grid(south, Math.floor), grid(east, Math.ceil), grid(north, Math.ceil)];
}
