// El recorrido del tren seleccionado no une con una recta dos posiciones lejanas (un rato sin datos).
// map.js importa MapLibre desde /vendor y no se puede cargar en Node: se prueba la función suelta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../../public/js/map.js', import.meta.url), 'utf8');
const gap = src.match(/const TRACK_GAP_KM = [\d.]+;/)?.[0];
const fn = src.match(/export function trackParts\(track\) \{\n[\s\S]+?\n\}/)?.[0];
const trackParts = new Function(`${gap} return ${fn?.replace('export ', '')};`)();

test('las posiciones seguidas forman un solo tramo', () => {
  const track = [0, 1, 2, 3].map((i) => ({ lat: 43.37, lon: -5.85 + i * 0.01 })); // ~0,8 km entre puntos
  assert.equal(trackParts(track).length, 1);
  assert.equal(trackParts(track)[0].length, 4);
});

test('un hueco de más de 5 km parte el recorrido en dos tramos', () => {
  const track = [{ lat: 43.37, lon: -5.86 }, { lat: 43.37, lon: -5.85 }, { lat: 43.344, lon: -5.36 }, { lat: 43.344, lon: -5.35 }];
  assert.deepEqual(trackParts(track).map((p) => p.length), [2, 2]);
});
