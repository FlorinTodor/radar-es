// Qué teselas de IGN y EFFIS se sirven: sólo las que tocan España y hasta el zoom de cada capa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isServableTile, maxTileCount, SPAIN_BOUNDS, TILE_LAYERS, tileRange } from '../../server/domain/tiles.js';

/** Tesela XYZ que contiene un punto (fórmula estándar de las teselas web). */
function tileAt(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return [z, Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)];
}

const SPAIN = {
  Madrid: [-3.70, 40.42], 'El Hierro (Orchilla)': [-18.16, 27.71], 'La Restinga': [-17.98, 27.64], 'Menorca (s\'Esperó)': [4.32, 39.87],
  'Estaca de Bares': [-7.69, 43.79], 'Cabo Touriñán': [-9.30, 42.88], Ceuta: [-5.32, 35.89], Melilla: [-2.94, 35.29], Lanzarote: [-13.5, 29.0],
};
const ABROAD = { París: [2.35, 48.86], Roma: [12.5, 41.9], 'Nueva York': [-74.0, 40.7], Dakar: [-17.45, 14.69], Marsella: [5.37, 43.3], Azores: [-25.7, 37.7] };

test('se sirven las teselas de toda España, islas, Ceuta y Melilla hasta el zoom máximo de cada capa', () => {
  for (const [layer, { minzoom, maxzoom }] of Object.entries(TILE_LAYERS)) {
    for (const [name, [lon, lat]] of Object.entries(SPAIN)) {
      for (const z of [minzoom, 8, maxzoom]) assert.ok(isServableTile(layer, ...tileAt(lon, lat, z)), `${layer} ${name} z${z}`);
    }
  }
});

test('fuera de la caja de España no se sirve nada', () => {
  for (const [name, [lon, lat]] of Object.entries(ABROAD)) {
    for (const z of [10, 14]) assert.equal(isServableTile('ign-rail', ...tileAt(lon, lat, z)), false, `${name} z${z}`);
  }
  // De lejos las teselas son grandes: la de Marsella a zoom 6 llega hasta Menorca y sí se sirve.
  assert.ok(isServableTile('ign-rail', ...tileAt(...ABROAD.Marsella, 6)));
  assert.equal(isServableTile('ign-rail', ...tileAt(...ABROAD['Nueva York'], 6)), false);
});

test('el zoom tiene tope por capa: la red ferroviaria hasta 14 y EFFIS hasta 12', () => {
  const [lon, lat] = SPAIN.Madrid;
  assert.equal(TILE_LAYERS['ign-rail'].maxzoom, 14);
  assert.equal(TILE_LAYERS.effis.maxzoom, 12);
  assert.ok(isServableTile('ign-rail', ...tileAt(lon, lat, 14)));
  assert.equal(isServableTile('ign-rail', ...tileAt(lon, lat, 15)), false);
  assert.equal(isServableTile('ign-rail', ...tileAt(lon, lat, 19)), false);
  assert.ok(isServableTile('effis', ...tileAt(lon, lat, 12)));
  assert.equal(isServableTile('effis', ...tileAt(lon, lat, 13)), false);
  assert.equal(isServableTile('effis', ...tileAt(lon, lat, 3)), false, 'por debajo del zoom mínimo del mapa');
  assert.equal(isServableTile('ign-rail', 0, 0, 0), false, 'el mundo entero');
});

test('capas desconocidas, coordenadas imposibles o no enteras no se sirven', () => {
  const madrid = tileAt(...SPAIN.Madrid, 10);
  for (const layer of ['osm', '__proto__', 'constructor', 'toString', '']) assert.equal(isServableTile(layer, ...madrid), false, layer);
  assert.equal(isServableTile('ign-rail', 10, 1024, 380), false, 'x fuera del mundo');
  assert.equal(isServableTile('ign-rail', 10, -1, 380), false);
  assert.equal(isServableTile('ign-rail', 10.5, madrid[1], madrid[2]), false);
  assert.equal(isServableTile('ign-rail', 10, Number.NaN, madrid[2]), false);
});

test('el borde de la caja: la última tesela que la toca se sirve y la siguiente no', () => {
  const z = 12;
  const r = tileRange(SPAIN_BOUNDS, z);
  const yMid = Math.round((r.minY + r.maxY) / 2);
  const xMid = Math.round((r.minX + r.maxX) / 2);
  assert.ok(isServableTile('effis', z, r.minX, yMid) && isServableTile('effis', z, r.maxX, yMid));
  assert.ok(isServableTile('effis', z, xMid, r.minY) && isServableTile('effis', z, xMid, r.maxY));
  assert.equal(isServableTile('effis', z, r.minX - 1, yMid), false);
  assert.equal(isServableTile('effis', z, r.maxX + 1, yMid), false);
  assert.equal(isServableTile('effis', z, xMid, r.minY - 1), false);
  assert.equal(isServableTile('effis', z, xMid, r.maxY + 1), false);
});

test('la caché de teselas está acotada: ~1,3 millones de la red ferroviaria y ~83.000 de EFFIS', () => {
  assert.equal(maxTileCount('ign-rail'), 1_317_078);
  assert.equal(maxTileCount('effis'), 83_082);
  assert.equal(maxTileCount('osm'), 0);
});
