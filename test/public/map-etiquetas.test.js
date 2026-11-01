// El mapa base (OpenFreeMap) rotula en inglés; map.js cambia esas etiquetas al nombre en español.
// map.js importa MapLibre desde /vendor y no se puede cargar en Node: se prueba la función suelta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../../public/js/map.js', import.meta.url), 'utf8');
const nameEs = src.match(/const NAME_ES = (\[.+\]);/)?.[1];
const fn = src.match(/export function spanishLabels\(map\) \{\n[\s\S]+?\n\}/)?.[0];
const spanishLabels = new Function(`const NAME_ES = ${nameEs}; return ${fn?.replace('export ', '')};`)();

test('las etiquetas en inglés del mapa base pasan al nombre en español', () => {
  const english = ['coalesce', ['get', 'name_en'], ['get', 'name']];
  const layers = [
    { id: 'place-country', type: 'symbol', layout: { 'text-field': ['case', ['has', 'name:nonlatin'], ['get', 'name:latin'], english] } },
    { id: 'road-shield', type: 'symbol', layout: { 'text-field': ['to-string', ['get', 'ref']] } },
    { id: 'icono', type: 'symbol', layout: { 'icon-image': 'x' } },
    { id: 'agua', type: 'fill', paint: {} },
  ];
  const set = [];
  spanishLabels({ getStyle: () => ({ layers }), setLayoutProperty: (...args) => set.push(args) });
  assert.deepEqual(set, [['place-country', 'text-field', ['coalesce', ['get', 'name:es'], ['get', 'name:latin'], ['get', 'name']]]]);
});

test('el mapa cambia las etiquetas nada más cargar el estilo', () => {
  assert.match(src, /map\.on\('load', resolve\)\)\.then\(\(\) => \{\n.+\n\s+spanishLabels\(map\);/);
});
