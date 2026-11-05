// El recorrido del tren seleccionado no une con una recta dos posiciones muy lejanas (un rato largo
// sin datos), pero sí las de un túnel.
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

test('un túnel largo (unos 28 km sin posiciones) no corta el recorrido', () => {
  const track = [{ lat: 40.80, lon: -4.02 }, { lat: 40.81, lon: -4.01 }, { lat: 41.04, lon: -3.86 }, { lat: 41.05, lon: -3.85 }];
  assert.equal(trackParts(track).length, 1);
});

test('un hueco de más de 30 km parte el recorrido en dos tramos', () => {
  const track = [{ lat: 43.37, lon: -5.86 }, { lat: 43.37, lon: -5.85 }, { lat: 43.344, lon: -5.36 }, { lat: 43.344, lon: -5.35 }];
  assert.deepEqual(trackParts(track).map((p) => p.length), [2, 2]);
});

// Lo que le queda a un tren de FGC se busca por el trazado de su línea: la línea sale tal cual de su API.
const routeShapeSrc = src.match(/ {2}const routeShapeOf = \(v\) => \{\n[\s\S]+?\n {2}\};/)?.[0];
const routeShapeOfWith = (byNetwork) => new Function('byNetwork', 'pathBetween',
  `const LINE_NETWORK = { fgc: 'FGC' }; const shapeOf = () => undefined; const lineShapes = new Map(); ${routeShapeSrc} return routeShapeOf;`,
)(byNetwork, () => [[2.1, 41.4], [2.05, 41.35]]);

test('un tren de FGC cuya línea no es un texto no rompe el pintado: va sin trazado', () => {
  const s1 = { properties: { line: 'S1' }, geometry: { coordinates: [[2.1, 41.4], [2.05, 41.35]] } };
  const routeShapeOf = routeShapeOfWith(new Map([['FGC', [s1]]]));
  const train = { id: 'fgc:1', source: 'fgc', lat: 41.4, lon: 2.1, end: [2.05, 41.35] };
  assert.equal(routeShapeOf({ ...train, line: 'S1' }), s1);
  assert.equal(routeShapeOf({ ...train, id: 'fgc:2', line: 'S1R' }), s1, 'el refuerzo, por el trazado de su línea');
  for (const line of [8, true, ['S8'], { k: 'S8' }]) {
    assert.doesNotThrow(() => routeShapeOf({ ...train, id: `fgc:${typeof line}`, line }), String(line));
    assert.equal(routeShapeOf({ ...train, id: `fgc:${typeof line}`, line }), undefined);
  }
});
