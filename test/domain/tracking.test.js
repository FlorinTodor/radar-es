// Historial de posiciones: un salto imposible (el operador pasa el número de tren a otro convoy)
// empieza un viaje nuevo; el ruido del GPS, los ratos sin datos y los túneles no.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTeleport, recordPositions } from '../../server/domain/tracking.js';
import { delayJumps } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 10, 1, 11, 0);
const OVIEDO = { lat: 43.36667, lon: -5.8550873 };
const INFIESTO = { lat: 43.344013, lon: -5.3606467 }; // a 40 km
const c6 = (pos, delay) => ({ id: 'renfe-c:2004D70856C6', mode: 'cercanias', label: 'C6 70856', delay, ...pos });

test('un tren que aparece a 40 km en 20 s empieza un viaje nuevo y no da un salto de retraso falso', () => {
  const tracks = new Map();
  recordPositions(tracks, [c6(OVIEDO, 1)], T0 - 5 * MIN);
  recordPositions(tracks, [c6(OVIEDO, 1)], T0 - 20 * SEC); // sigue parado en Oviedo
  const now = c6(INFIESTO, 87);
  recordPositions(tracks, [now], T0);
  assert.deepEqual(tracks.get(now.id).map((p) => p.lat), [INFIESTO.lat]);
  assert.equal(delayJumps({ now: T0, vehicles: [now], tracks, thresholds: DEFAULT_THRESHOLDS }).length, 0);
});

test('un salto corto imposible (3 km en 20 s) no corta el recorrido: si el siguiente sigue desde él, valen los dos', () => {
  const tracks = new Map();
  recordPositions(tracks, [c6({ lat: 43.374817, lon: -5.7579193 }, 2)], T0 - 20 * SEC);
  const salto = c6({ lat: 43.37962, lon: -5.792306 }, 2);
  recordPositions(tracks, [salto], T0);
  assert.equal(tracks.get(salto.id).length, 1, 'hasta ver el siguiente, se queda donde estaba');
  assert.equal(salto.lon, -5.7579193);
  recordPositions(tracks, [c6({ lat: 43.38, lon: -5.796 }, 2)], T0 + 20 * SEC);
  assert.deepEqual(tracks.get(salto.id).map((p) => p.lon), [-5.7579193, -5.792306, -5.796]);
});

test('un punto suelto imposible que vuelve atrás se descarta: el tren no va y viene', () => {
  const tracks = new Map();
  recordPositions(tracks, [c6({ lat: 42.84682, lon: -2.89372 }, 0)], T0 - 20 * SEC);
  const suelto = c6({ lat: 42.82412, lon: -2.89913 }, 0); // 2,5 km en 20 s
  recordPositions(tracks, [suelto], T0);
  assert.equal(suelto.lat, 42.84682, 'en el mapa sigue en su sitio');
  recordPositions(tracks, [c6({ lat: 42.83863, lon: -2.89315 }, 0)], T0 + 20 * SEC); // vuelve a la vía
  assert.deepEqual(tracks.get(suelto.id).map((p) => p.lat), [42.84682, 42.83863]);
});

test('un salto corto que se repite más de 2 min se acepta: no se queda congelado para siempre', () => {
  const tracks = new Map();
  recordPositions(tracks, [c6({ lat: 43.37, lon: -5.75 }, 0)], T0 - 20 * SEC);
  // Cada 30 s a 5 km al norte o al sur: imposible desde el anterior y desde el retenido.
  const at = (s) => c6({ lat: 43.37 + ((s / 30) % 2 ? -0.045 : 0.045), lon: -5.75 }, 0);
  for (let s = 0; s <= 90; s += 30) recordPositions(tracks, [at(s)], T0 + s * SEC);
  assert.equal(tracks.get('renfe-c:2004D70856C6').length, 1, 'en los 2 primeros minutos, retenido');
  recordPositions(tracks, [at(150)], T0 + 150 * SEC);
  assert.equal(tracks.get('renfe-c:2004D70856C6').length, 2);
});

test('una posición vieja repetida (A, B, B, A) se descarta y el tren se queda en B', () => {
  const A = { lat: 40.53711, lon: -3.69921 };
  const B = { lat: 40.53445, lon: -3.69826 }; // a 305 m
  const tracks = new Map();
  const seq = [A, B, B, A, B, B, A];
  let v;
  seq.forEach((pos, i) => recordPositions(tracks, [(v = c6(pos, 0))], T0 + i * 20 * SEC));
  assert.deepEqual(tracks.get(v.id).map((p) => p.lat), [A.lat, B.lat]);
  assert.equal(v.lat, B.lat, 'la última posición que se muestra es B, no la repetida');
});

test('parado en el mismo sitio no es una posición repetida', () => {
  const tracks = new Map();
  const A = { lat: 40.53711, lon: -3.69921 };
  let v;
  for (let i = 0; i < 4; i++) recordPositions(tracks, [(v = c6(A, 0))], T0 + i * 20 * SEC);
  assert.equal(tracks.get(v.id).length, 1);
  assert.equal(v.lat, A.lat);
});

test('un rato sin datos a velocidad posible (40 km en 30 min) sigue siendo el mismo viaje', () => {
  const a = { t: T0 - 30 * MIN, ...OVIEDO };
  assert.equal(isTeleport(a, { t: T0, ...INFIESTO }), false);
  assert.equal(isTeleport({ ...a, seen: T0 - 20 * SEC }, { t: T0, ...INFIESTO }), true);
});

test('al salir de un túnel largo no es un salto aunque la fuente repitiera la última posición', () => {
  // AVE por el túnel de Guadarrama (28 km): la fuente repite la posición de la boca sur con su
  // hora de GPS de entonces durante 7 min; al salir llega la posición nueva con GPS nuevo.
  const ave = (pos, fixTime) => ({ id: 'renfe-ld:AVE-04071', mode: 'av', delay: 3, fixTime, ...pos });
  const sur = { lat: 40.8, lon: -4.02 };
  const norte = { lat: 41.04, lon: -3.86 };
  const tracks = new Map();
  recordPositions(tracks, [ave(sur, T0 - 7 * MIN)], T0 - 7 * MIN);
  for (let s = 6 * 60; s > 0; s -= 20) recordPositions(tracks, [ave(sur, T0 - 7 * MIN)], T0 - s * SEC);
  recordPositions(tracks, [ave(norte, T0)], T0);
  assert.equal(tracks.get('renfe-ld:AVE-04071').length, 2);
});

test('si el GPS es nuevo, 40 km en 20 s sigue siendo un salto', () => {
  const tracks = new Map();
  recordPositions(tracks, [{ ...c6(OVIEDO, 1), fixTime: T0 - 20 * SEC }], T0 - 20 * SEC);
  recordPositions(tracks, [{ ...c6(INFIESTO, 87), fixTime: T0 }], T0);
  assert.equal(tracks.get('renfe-c:2004D70856C6').length, 1);
});

test('hacia dónde va: de la última posición alejada a la actual; el GPS parado no la gira', async () => {
  const { headingOf } = await import('../../server/domain/tracking.js');
  const p = (lat, lon) => ({ t: 0, lat, lon });
  assert.equal(headingOf([p(43.36, -5.86), p(43.36, -5.85)]), 90); // hacia el este
  assert.equal(headingOf([p(43.36, -5.86), p(43.37, -5.86)]), 0); // hacia el norte
  // Parado en la estación con el GPS bailando unos metros: sigue mirando hacia donde iba.
  assert.equal(headingOf([p(43.36, -5.86), p(43.37, -5.86), p(43.37001, -5.86001), p(43.36999, -5.85999)]), 0);
  assert.equal(headingOf([p(43.36, -5.86), p(43.36005, -5.86)]), null); // 6 m: no se sabe
  assert.equal(headingOf(undefined), null);
});

test('hacia dónde va: un punto suelto atrasado no da la vuelta a la flecha', async () => {
  const { headingOf } = await import('../../server/domain/tracking.js');
  // Alvia hacia el noreste: cada 20 s unos cientos de metros, y uno que vuelve 1,75 km atrás.
  const p = (s, lat, lon) => ({ t: s * 1000, lat, lon });
  const track = [p(0, 41.70068, -1.22274), p(20, 41.70238, -1.22046), p(40, 41.70448, -1.21780), p(60, 41.71693, -1.20221), p(80, 41.70540, -1.21664)];
  assert.equal(headingOf(track), 45, 'sigue hacia el noreste');
  // Pasados 3 min sin moverse, sigue mirando hacia donde iba.
  assert.equal(headingOf([p(0, 43.36, -5.86), p(20, 43.37, -5.86), p(400, 43.37001, -5.86)]), 0);
});

test('un Cercanías no va a 313 km/h: ese salto atrás se descarta (un AVE sí podría)', () => {
  const tracks = new Map();
  const c10 = (lat, lon, mode = 'cercanias') => ({ id: `renfe-${mode}:75144`, mode, delay: 0, lat, lon });
  recordPositions(tracks, [c10(40.40042, -3.69278)], T0 - 17 * SEC);
  const atras = c10(40.40250, -3.71002); // 1,48 km en 17 s
  recordPositions(tracks, [atras], T0);
  assert.equal(atras.lon, -3.69278, 'se queda en Delicias');
  const ave = (lat, lon) => c10(lat, lon, 'av');
  recordPositions(tracks, [ave(40.40042, -3.69278)], T0 - 17 * SEC);
  const rapido = ave(40.40250, -3.71002);
  recordPositions(tracks, [rapido], T0);
  assert.equal(rapido.lon, -3.71002);
});

test('las posiciones estimadas no se filtran: si vuelven a una parada es porque ha subido el retraso', () => {
  const tracks = new Map();
  const tram = (lat, lon) => ({ id: 'horario-tram:T1', mode: 'tranvia', estimated: true, delay: 0, lat, lon });
  const parada = [41.42011, 2.20957];
  recordPositions(tracks, [tram(...parada)], T0 - 60 * SEC);
  recordPositions(tracks, [tram(41.4196, 2.2089)], T0 - 30 * SEC);
  const vuelta = tram(...parada);
  recordPositions(tracks, [vuelta], T0);
  assert.equal(vuelta.lat, parada[0]);
  assert.equal(tracks.get('horario-tram:T1').length, 3);
});
