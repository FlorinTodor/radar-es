// Lo que le queda a un tren: por el trazado de su viaje, pero sólo entre las paradas que le quedan.
// Renfe da a veces trazados que no son el del viaje (un C7 «por Pitis» que va por Atocha, un C6 a
// Vinaròs con un trazado que acaba en Castelló): nunca se dibuja por donde no va el tren.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headingOfPath, pathThroughStops } from '../../server/domain/route-ahead.js';
import { pathBetween } from '../../public/js/track-match.js';

// Una «U» por el norte entre W y E (como el C7 por Pitis); el tren va de W a E por el sur.
const W = [-3.70, 40.40];
const NW = [-3.70, 40.45];
const NE = [-3.65, 40.45];
const E = [-3.65, 40.40];
const U = [W, NW, NE, E];
const near = (a, b, m = 30) => Math.hypot((a[0] - b[0]) * 85_000, (a[1] - b[1]) * 111_000) < m;

test('si el trazado no pasa por su próxima parada, no se dibuja (antes se dibujaba dando la vuelta)', () => {
  const south = [-3.675, 40.40];
  assert.ok(pathBetween(U, W, E), 'sólo con el destino, el trazado lleva de W a E por el norte');
  assert.equal(pathThroughStops(U, W, [south, E]), null);
});

test('si el viaje va por el trazado, se dibuja entero hasta su destino', () => {
  const p = pathThroughStops(U, W, [[-3.70, 40.43], NE, E]);
  assert.ok(near(p[0], W) && near(p.at(-1), E));
  assert.ok(p.some((q) => near(q, NW)) && p.some((q) => near(q, NE)), 'por sus curvas');
});

test('el trazado dibujado al revés que el viaje no cambia nada', () => {
  const p = pathThroughStops([...U].reverse(), W, [[-3.70, 40.43], NE, E]);
  assert.ok(near(p[0], W) && near(p.at(-1), E));
});

test('trazado más corto que el viaje: se dibuja hasta la última parada que está sobre él', () => {
  const p = pathThroughStops([W, NW], W, [[-3.70, 40.43], NW, NE, E]);
  assert.ok(near(p.at(-1), NW), 'se corta en NW, no sigue en recta hacia E');
});

test('una parada por detrás en el trazado (el trazado da la vuelta): se corta ahí', () => {
  const p = pathThroughStops(U, [-3.70, 40.43], [NW, [-3.70, 40.41]]);
  assert.ok(near(p.at(-1), NW));
});

test('línea circular: cada parada se busca en la pasada que queda por delante', () => {
  // Un anillo que vuelve a W; la última parada (W) está en los dos extremos del trazado.
  const ring = [W, NW, NE, E, W];
  const p = pathThroughStops(ring, [-3.675, 40.45], [NE, E, W]);
  assert.ok(near(p.at(-1), W));
  assert.ok(p.length >= 4, 'sigue el anillo por E hasta volver a W');
});

test('tren lejos del trazado o sin paradas: nada', () => {
  assert.equal(pathThroughStops(U, [-3.60, 40.30], [E]), null);
  assert.equal(pathThroughStops(U, W, []), null);
  assert.equal(pathThroughStops(null, W, [E]), null);
});

test('la flecha sale del camino: hacia donde va por su vía', () => {
  assert.equal(headingOfPath(pathThroughStops(U, W, [[-3.70, 40.43], NE, E])), 0);
  assert.equal(headingOfPath([W]), null);
});
