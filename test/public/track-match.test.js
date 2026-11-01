// El recorrido del tren seleccionado se pega al trazado de su línea: sigue sus curvas, no salta a
// otra pasada de la misma línea y deja tal cual lo que está lejos del trazado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTrack } from '../../public/js/track-match.js';

const line = (coords) => ({ geometry: { type: 'LineString', coordinates: coords } });
// Trazado en forma de L cerca de Oviedo: 2 km hacia el este y luego 2 km hacia el norte.
const ESQUINA = [-5.80, 43.36];
const L = line([[-5.825, 43.36], ESQUINA, [-5.80, 43.378]]);

test('entre dos posiciones dibuja el trazado con su curva, no la recta', () => {
  const parts = [[[-5.81, 43.3601], [-5.8001, 43.37]]]; // antes y después de la esquina, a pocos metros de la vía
  const [out] = matchTrack(parts, [L]);
  assert.ok(out.some(([lon, lat]) => lon === ESQUINA[0] && lat === ESQUINA[1]), 'pasa por la esquina');
  assert.ok(Math.abs(out[0][1] - 43.36) < 1e-9, 'la primera posición queda sobre la vía');
});

test('una posición lejos del trazado se queda donde está', () => {
  const lejos = [-5.70, 43.30];
  const [out] = matchTrack([[[-5.81, 43.3601], lejos]], [L]);
  assert.deepEqual(out.at(-1), lejos);
});

test('sin trazado de la línea, el recorrido no cambia', () => {
  const parts = [[[-5.81, 43.3601], [-5.8001, 43.37]]];
  assert.deepEqual(matchTrack(parts, []), parts);
});

test('en una línea que vuelve sobre sí misma no da la vuelta entera entre dos posiciones cercanas', () => {
  // Ida y vuelta por dos vías paralelas a 100 m: dos posiciones seguidas en la vía de ida no pueden
  // unirse recorriendo toda la línea.
  const ida = [[-5.85, 43.36], [-5.75, 43.36]];
  const vuelta = [[-5.75, 43.3609], [-5.85, 43.3609]];
  const circular = line([...ida, ...vuelta]);
  // La primera cae en la vía de ida y la segunda, por ruido del GPS, en la de vuelta.
  const [out] = matchTrack([[[-5.80, 43.3601], [-5.799, 43.3608]]], [circular]);
  assert.ok(!out.some(([lon]) => lon === -5.75), 'no pasa por el final de la línea');
  assert.equal(out.length, 2);
});

test('elige el trazado de la ciudad del tren entre líneas con el mismo nombre', () => {
  const otraCiudad = line([[-3.70, 40.40], [-3.68, 40.42]]);
  const [out] = matchTrack([[[-5.81, 43.3601], [-5.8001, 43.37]]], [otraCiudad, L]);
  assert.ok(out.some(([lon, lat]) => lon === ESQUINA[0] && lat === ESQUINA[1]));
});

test('lo que le queda a un tren: el trazado desde su posición hasta donde acaba su viaje', async () => {
  const { pathBetween } = await import('../../public/js/track-match.js');
  const trazado = [[-3.00, 43.20], [-2.98, 43.20], [-2.96, 43.21], [-2.94, 43.21]];
  const ahead = pathBetween(trazado, [-2.97, 43.2052], [-2.94, 43.21]); // entre el 2.º y el 3.er punto, sobre la vía
  assert.ok(Math.abs(ahead[0][0] + 2.97) < 0.002, 'empieza donde está el tren');
  assert.deepEqual(ahead.slice(1), [[-2.96, 43.21], [-2.94, 43.21]]);
  assert.equal(pathBetween(trazado, [-2.97, 43.25], [-2.94, 43.21]), null, 'a 5 km del trazado no es su viaje');
  assert.equal(pathBetween(trazado, [-2.97, 43.2052], [-2.97, 43.30]), null, 'su final no está en el trazado');
  assert.equal(pathBetween(trazado, [-2.97, 43.2052], null), null, 'sin final no se sabe hacia dónde va');
  assert.equal(pathBetween([], [-2.97, 43.2], [-2.94, 43.21]), null);
});

test('con el trazado dibujado al revés, lo que le queda va hacia su final igualmente', async () => {
  const { pathBetween } = await import('../../public/js/track-match.js');
  const trazado = [[-3.00, 43.20], [-2.98, 43.20], [-2.96, 43.21], [-2.94, 43.21]];
  const back = pathBetween(trazado, [-2.97, 43.2052], [-3.00, 43.20]); // va hacia el primer punto
  assert.ok(Math.abs(back[0][0] + 2.97) < 0.002, 'empieza donde está el tren');
  assert.deepEqual(back.slice(1), [[-2.98, 43.20], [-3.00, 43.20]]);
});

test('un viaje que acaba antes que su trazado se dibuja sólo hasta su final', async () => {
  const { pathBetween } = await import('../../public/js/track-match.js');
  const trazado = [[-3.00, 43.20], [-2.98, 43.20], [-2.96, 43.21], [-2.94, 43.21]];
  const corto = pathBetween(trazado, [-2.99, 43.2001], [-2.96, 43.21]);
  assert.deepEqual(corto.slice(1), [[-2.98, 43.20], [-2.96, 43.21]], 'no sigue hasta el último punto del trazado');
});

test('la flecha va por la vía hacia donde acaba su viaje, aunque el trazado esté al revés', async () => {
  const { headingAlong } = await import('../../public/js/track-match.js');
  const trazado = [[-3.00, 43.20], [-2.98, 43.20], [-2.96, 43.20]]; // de oeste a este
  assert.equal(headingAlong(trazado, [-2.99, 43.2001], [-2.96, 43.20]), 90, 'hacia el este');
  assert.equal(headingAlong(trazado, [-2.99, 43.2001], [-3.00, 43.20]), 270, 'hacia el oeste');
  assert.equal(headingAlong(trazado, [-2.96, 43.2], [-2.96, 43.20]), null, 'ya ha llegado');
  assert.equal(headingAlong(trazado, [-2.99, 43.25], [-2.96, 43.20]), null, 'lejos de su vía');
});

test('si el viaje sigue más allá del trazado, se dibuja hasta donde llega el trazado', async () => {
  const { pathBetween } = await import('../../public/js/track-match.js');
  const trazado = [[-3.00, 43.20], [-2.98, 43.20], [-2.96, 43.20]];
  const hasta = pathBetween(trazado, [-2.99, 43.2001], [-2.70, 43.25]); // su final, 25 km más allá del extremo este
  assert.deepEqual(hasta.slice(1), [[-2.98, 43.20], [-2.96, 43.20]]);
  assert.equal(pathBetween(trazado, [-2.99, 43.2001], [-2.98, 43.30]), null, 'un final lejos a un lado del trazado no es su viaje');
});
