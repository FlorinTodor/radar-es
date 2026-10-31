// El mapa y el servidor tienen que estar de acuerdo en qué teselas de IGN y EFFIS existen: si el
// mapa pidiera una que el servidor rechaza, vería huecos y errores 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SPAIN_BOUNDS, TILE_LAYERS } from '../../server/domain/tiles.js';

const map = await readFile(new URL('../../public/js/map.js', import.meta.url), 'utf8');

test('la caja de las teselas del mapa es la del servidor', () => {
  const bounds = map.match(/const TILES_BOUNDS = (\[[^\]]+\]);/)?.[1];
  assert.ok(bounds, 'map.js define TILES_BOUNDS');
  assert.deepEqual(JSON.parse(bounds), [...SPAIN_BOUNDS]);
});

for (const [source, layer] of [['rail-ign', 'ign-rail'], ['effis', 'effis']]) {
  test(`la fuente ${source} del mapa usa la caja y los zooms de la capa ${layer}`, () => {
    const spec = map.match(new RegExp(`addSource\\('${source}', \\{([^}]+)\\}`))?.[1];
    assert.ok(spec, `map.js añade la fuente ${source}`);
    const url = spec.match(/tiles: \[(\w+)\]/)?.[1];
    assert.match(map, new RegExp(`const ${url} = \`\\$\\{location\\.origin\\}/tiles/${layer}/\\{z\\}`), `${url} apunta a /tiles/${layer}/`);
    assert.match(spec, /bounds: TILES_BOUNDS/);
    assert.equal(Number(spec.match(/minzoom: (\d+)/)?.[1]), TILE_LAYERS[layer].minzoom);
    assert.equal(Number(spec.match(/maxzoom: (\d+)/)?.[1]), TILE_LAYERS[layer].maxzoom);
  });
}
