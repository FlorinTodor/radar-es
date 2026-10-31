// El caso de uso decide qué teselas se piden: lo que no se sirve no llega al proveedor (ni al
// IGN o EFFIS, ni al disco).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServeTiles } from '../../server/application/use-cases/serve-tiles.js';

/** Tesela XYZ que contiene un punto. */
function tileAt(lon, lat, z) {
  const n = 2 ** z;
  const rad = (lat * Math.PI) / 180;
  return [z, Math.floor(((lon + 180) / 360) * n), Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)];
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);

function fakeProvider({ png = PNG, burnt = { type: 'FeatureCollection', features: [] }, fail = false } = {}) {
  const calls = { tile: [], burnt: [] };
  return {
    calls,
    layers: ['ign-rail', 'effis', 'otra'],
    cacheControl: (layer) => `cache-${layer}`,
    tile: async (...args) => { calls.tile.push(args); return png; },
    burntAreas: async (bbox) => { calls.burnt.push(bbox); if (fail) throw new Error('EFFIS caído'); return burnt; },
  };
}

test('una tesela de España se pide al proveedor y lleva la caché de su capa', async () => {
  const tiles = fakeProvider();
  const tile = await makeServeTiles({ tiles }).tile('ign-rail', ...tileAt(-3.7, 40.42, 14));
  assert.deepEqual(tile, { png: PNG, cacheControl: 'cache-ign-rail' });
  assert.deepEqual(tiles.calls.tile, [['ign-rail', ...tileAt(-3.7, 40.42, 14)]]);
});

test('fuera de España, por encima del zoom o de una capa sin límites: null y sin pedir nada', async () => {
  const tiles = fakeProvider();
  const serve = makeServeTiles({ tiles });
  assert.equal(await serve.tile('ign-rail', ...tileAt(2.35, 48.86, 10)), null, 'París');
  assert.equal(await serve.tile('ign-rail', ...tileAt(-3.7, 40.42, 15)), null, 'zoom 15');
  assert.equal(await serve.tile('effis', ...tileAt(-3.7, 40.42, 13)), null, 'EFFIS a zoom 13');
  assert.equal(await serve.tile('otra', ...tileAt(-3.7, 40.42, 8)), null, 'el proveedor la tiene, pero no tiene límites');
  assert.equal(await serve.tile('ign-rail', 19, 252981, 204923), null, 'la tesela de zoom 19 que antes se guardaba');
  assert.equal(tiles.calls.tile.length, 0);
});

test('una capa con límites que el proveedor no tiene no se sirve', async () => {
  const tiles = { ...fakeProvider(), layers: ['effis'] };
  assert.equal(await makeServeTiles({ tiles }).tile('ign-rail', ...tileAt(-3.7, 40.42, 8)), null);
});

test('si el servicio no responde y no hay copia, png: null', async () => {
  const tile = await makeServeTiles({ tiles: fakeProvider({ png: null }) }).tile('effis', ...tileAt(-3.7, 40.42, 8));
  assert.deepEqual(tile, { png: null, cacheControl: 'cache-effis' });
});

test('áreas quemadas: sólo cajas pequeñas y bien formadas llegan a EFFIS', async () => {
  const tiles = fakeProvider();
  const serve = makeServeTiles({ tiles });
  for (const bad of [[], [1, 2, 3], [-4, 38, -4.1, 38.1], [-4, 38, -3.9, 37.9], [-4, 38, -3.5, 38.1], [-4, 38, -3.9, 38.5], [-4, Number.NaN, -3.9, 38.1]]) {
    assert.equal(await serve.burntAreas(bad), null, JSON.stringify(bad));
  }
  assert.equal(tiles.calls.burnt.length, 0);
  assert.deepEqual(await serve.burntAreas([-4, 38, -3.9, 38.1]), { type: 'FeatureCollection', features: [] });
  assert.deepEqual(tiles.calls.burnt, [[-4, 38, -3.9, 38.1]]);
});

test('áreas quemadas: si EFFIS falla, el error llega a quien llama', async () => {
  await assert.rejects(makeServeTiles({ tiles: fakeProvider({ fail: true }) }).burntAreas([-4, 38, -3.9, 38.1]), /EFFIS caído/);
});
