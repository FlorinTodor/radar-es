// Caso de uso: servir las teselas de las capas externas (IGN, EFFIS) y las áreas quemadas bajo un
// clic. Decide qué se puede pedir (el dominio acota las teselas a España y a un zoom máximo por
// capa) antes de que el proveedor descargue nada o lo guarde en disco.
import { isServableTile } from '../../domain/tiles.js';

/** Lado máximo, en grados, de la caja de áreas quemadas: lo que hay bajo un clic, no una región. */
const MAX_BURNT_BOX_DEG = 0.5;

/**
 * @param {{ tiles: import('../ports.js').TileProviderPort }} deps
 */
export function makeServeTiles({ tiles }) {
  return {
    /**
     * Tesela PNG. null si no se sirve (capa desconocida, fuera de España o de su rango de zoom);
     * `png: null` si el servicio original no responde y no hay copia guardada.
     * @returns {Promise<{ png: Uint8Array | null, cacheControl: string } | null>}
     */
    async tile(layer, z, x, y) {
      if (!tiles.layers.includes(layer) || !isServableTile(layer, z, x, y)) return null;
      return { png: await tiles.tile(layer, z, x, y), cacheControl: tiles.cacheControl(layer) };
    },

    /**
     * Áreas quemadas (GeoJSON) en una caja lon/lat pequeña. null si la caja no es válida; si EFFIS
     * falla, la promesa se rechaza.
     * @param {number[]} bbox  [oeste, sur, este, norte]
     */
    async burntAreas(bbox) {
      const valid = bbox.length === 4 && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1]
        && bbox[2] - bbox[0] < MAX_BURNT_BOX_DEG && bbox[3] - bbox[1] < MAX_BURNT_BOX_DEG;
      return valid ? tiles.burntAreas(bbox) : null;
    },
  };
}
