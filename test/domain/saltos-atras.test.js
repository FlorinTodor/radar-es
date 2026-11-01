// Recorrido de los trenes de Renfe: saltos atrás, primera posición de otra estación y posiciones
// que no están al día. Casos medidos en producción el 1 de noviembre de 2026.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBackJump, recordPositions } from '../../server/domain/tracking.js';

const SEC = 1000;
const T0 = Date.UTC(2026, 10, 1, 23, 13, 27);
const CLEAN = { clean: true };

test('un C3 que empieza «en Atocha» y 20 s después (por su GPS) está en El Casar, a 10 km: el recorrido empieza en El Casar', () => {
  const c3 = (lat, lon, fixTime) => ({ id: 'renfe-c:1005L27095C3', mode: 'cercanias', delay: 5, lat, lon, fixTime });
  const tracks = new Map();
  recordPositions(tracks, [c3(40.40633, -3.68968, T0 + 4 * SEC)], T0, CLEAN); // primera posición: Atocha
  recordPositions(tracks, [c3(40.31853, -3.70971, T0 + 24 * SEC)], T0 + 41 * SEC, CLEAN); // El Casar
  recordPositions(tracks, [c3(40.31853, -3.70971, T0 + 44 * SEC)], T0 + 61 * SEC, CLEAN); // sigue allí
  recordPositions(tracks, [c3(40.33175, -3.69894, T0 + 345 * SEC)], T0 + 364 * SEC, CLEAN); // hacia el norte
  assert.deepEqual(tracks.get('renfe-c:1005L27095C3').map((p) => p.lat), [40.31853, 40.33175], 'sin la recta de 10 km hacia Atocha');
});

test('una posición 1,7 km por detrás, a velocidad posible, se descarta si el tren sigue hacia delante', () => {
  // C2 hacia Atocha (noroeste): 40.3967 → 1,7 km atrás → 2,8 km adelante, ya pasada la posición de antes.
  const c2 = (lat, lon) => ({ id: 'renfe-c:1005L75529C2', mode: 'cercanias', delay: 0, lat, lon });
  const tracks = new Map();
  [[40.37900, -3.66300], [40.38600, -3.66700], [40.39670, -3.67431]].forEach(([lat, lon], i) => recordPositions(tracks, [c2(lat, lon)], T0 + i * 60 * SEC, CLEAN));
  const atras = c2(40.38177, -3.66813);
  recordPositions(tracks, [atras], T0 + 201 * SEC, CLEAN);
  assert.equal(atras.lat, 40.39670, 'en el mapa se queda donde estaba');
  recordPositions(tracks, [c2(40.40667, -3.68940)], T0 + 261 * SEC, CLEAN);
  assert.deepEqual(tracks.get('renfe-c:1005L75529C2').map((p) => p.lat), [40.379, 40.386, 40.3967, 40.40667]);
});

test('si el tren de verdad va hacia atrás (la posición sigue desde el salto), se acepta y el recorrido empieza ahí', () => {
  const v = (lat) => ({ id: 'renfe-ld:00001', mode: 'md', delay: 0, lat, lon: -3.7 });
  const tracks = new Map();
  [40.30, 40.31, 40.32].forEach((lat, i) => recordPositions(tracks, [v(lat)], T0 + i * 60 * SEC, CLEAN));
  recordPositions(tracks, [v(40.3105)], T0 + 180 * SEC, CLEAN); // 1 km al sur
  recordPositions(tracks, [v(40.305)], T0 + 240 * SEC, CLEAN); // y sigue al sur
  assert.deepEqual(tracks.get('renfe-ld:00001').map((p) => p.lat), [40.3105, 40.305]);
});

test('un salto atrás de pocos metros es ruido del GPS: no se retiene', () => {
  assert.equal(isBackJump({ lat: 40.40, lon: -3.7 }, { lat: 40.398, lon: -3.7 }, 0), false, '220 m');
  assert.equal(isBackJump({ lat: 40.40, lon: -3.7 }, { lat: 40.39, lon: -3.7 }, 0), true, '1,1 km atrás');
  assert.equal(isBackJump({ lat: 40.40, lon: -3.7 }, { lat: 40.39, lon: -3.7 }, 180), false, 'hacia donde iba');
  assert.equal(isBackJump({ lat: 40.40, lon: -3.7 }, { lat: 40.39, lon: -3.7 }, null), false, 'sin saber hacia dónde iba');
});

test('«parado en» una estación lejos de su posición: el tren se queda donde estaba y su recorrido no salta', () => {
  // C1 hacia Atocha: en Valdebebas, y Renfe da la posición de T4 (2,2 km atrás) diciendo «parado en Valdebebas».
  const c1 = (lat, lon, extra = {}) => ({ id: 'renfe-c:1005L19945C1', mode: 'cercanias', delay: 0, lat, lon, ...extra });
  const tracks = new Map();
  recordPositions(tracks, [c1(40.48191, -3.61629)], T0, CLEAN);
  const t4 = c1(40.49240, -3.59348, { farFromStop: 2.2, stopped: true });
  recordPositions(tracks, [t4], T0 + 80 * SEC, CLEAN);
  assert.equal(t4.lat, 40.48191);
  assert.deepEqual(tracks.get('renfe-c:1005L19945C1').map((p) => p.lat), [40.48191]);
  // Sin historial previo no hay dónde quedarse: se muestra la que da.
  const solo = { id: 'renfe-ld:12692', mode: 'md', delay: 22, lat: 43.41187, lon: -8.18034, farFromStop: 9.4 };
  recordPositions(tracks, [solo], T0, CLEAN);
  assert.equal(tracks.get('renfe-ld:12692').length, 1);
});
