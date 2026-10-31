// Qué teselas de las capas externas (red ferroviaria del IGN, áreas quemadas de EFFIS) se sirven.
// Cada tesela servida se descarga del servicio original y se guarda en disco, así que sólo se
// aceptan las que el mapa puede pedir: las que tocan España y hasta el zoom máximo de cada capa
// (más cerca, el mapa amplía la última). Así nadie puede llenar el disco pidiendo el mundo entero
// a zoom 19, ni hacer que machaquemos al IGN o a EFFIS.
//
// Los mismos valores están en las fuentes raster de public/js/map.js (`bounds`, `minzoom`,
// `maxzoom`), para que el mapa nunca pida una tesela que aquí se rechaza.

/**
 * Caja lon/lat [oeste, sur, este, norte] que cubre la Península, Baleares, Canarias, Ceuta y
 * Melilla con un margen de unos 20-35 km: de El Hierro (-18,16) a Menorca (4,33) y de La Restinga
 * (27,64) a Estaca de Bares (43,79).
 */
export const SPAIN_BOUNDS = Object.freeze([-18.5, 27.4, 4.6, 44.0]);

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

/** Número máximo de teselas que puede llegar a guardar una capa (todas las de la caja en su rango de zoom). */
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
