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

test('trazado cerrado (el C4 de Sevilla): el tren en su estación de origen está en los dos extremos; vale el que lleva a sus paradas', () => {
  const ring = [W, NW, NE, E, W];
  // A unos metros de W, más cerca del final del trazado (el tramo E → W) que del principio: antes no se
  // dibujaba nada.
  const at = [W[0] + 0.00002, W[1] + 0.000005];
  const p = pathThroughStops(ring, at, [NW, NE, E, W]);
  assert.ok(p && near(p.at(-1), W), 'da la vuelta entera hasta W');
  assert.ok(p.some((q) => near(q, NE)) && p.some((q) => near(q, E)));
});

test('el tren parado en su estación de origen, unos metros por delante o por detrás de ella: no decide el sentido', () => {
  // Trazado de B a A y el viaje de A a B (como el C1 de Bilbao en Santurtzi, a 2 m «por delante» de su estación).
  const A = [-3.70, 40.40];
  const B = [-3.60, 40.40];
  const mid = [-3.65, 40.40];
  for (const dx of [0.00003, -0.00003]) {
    const p = pathThroughStops([B, mid, A], [A[0] + dx, A[1]], [A, mid, B]);
    assert.ok(p && near(p.at(-1), B), `con el tren ${dx > 0 ? 'por delante' : 'por detrás'} de A, llega a B`);
  }
});

test('vía de montaña: entre dos paradas el trazado da un rodeo largo, y si la parada sólo está cerca de una pasada, es la vía', () => {
  // De X a Y hay 1,7 km en recta y 6 km por el trazado (como la rampa de Pesquera entre Bárcena y Pujayo).
  const X = [-3.70, 40.40];
  const Y = [-3.68, 40.40];
  const loop = [X, [-3.70, 40.42], [-3.68, 40.42], Y];
  const p = pathThroughStops(loop, X, [Y]);
  assert.ok(p && near(p.at(-1), Y), 'antes se cortaba por ser mucho más largo que la recta');
});

test('un trazado de 200.000 vértices entre el tren y su parada se dibuja entero (con push(...tramo) se agotaba la pila)', () => {
  // Una recta de unos 17 km con un vértice cada 8 cm: lo que publique el operador no tiene tope de vértices.
  const N = 200_000;
  const coords = Array.from({ length: N }, (_, i) => [-3.7 + i * 1e-6, 40.4]);
  const p = pathThroughStops(coords, coords[0], [coords[N - 1]]);
  assert.ok(p, 'se dibuja');
  assert.ok(p.length >= N - 2 && p.length <= N + 2, `${p.length} puntos`);
  assert.ok(near(p[0], coords[0]) && near(p.at(-1), coords[N - 1]));
  assert.ok(p.every((q, i) => i === 0 || q[0] >= p[i - 1][0]), 'en orden, del tren a su destino');
});
