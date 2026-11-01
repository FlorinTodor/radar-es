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
