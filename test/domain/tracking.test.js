// Historial de posiciones: un salto imposible (el operador pasa el número de tren a otro convoy)
// empieza un viaje nuevo; el ruido del GPS y los ratos sin datos no.
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

test('el ruido del GPS (3 km en 20 s) no corta el recorrido', () => {
  const tracks = new Map();
  recordPositions(tracks, [c6({ lat: 43.374817, lon: -5.7579193 }, 2)], T0 - 20 * SEC);
  recordPositions(tracks, [c6({ lat: 43.37962, lon: -5.792306 }, 2)], T0);
  assert.equal(tracks.get('renfe-c:2004D70856C6').length, 2);
});

test('un rato sin datos a velocidad posible (40 km en 30 min) sigue siendo el mismo viaje', () => {
  const a = { t: T0 - 30 * MIN, ...OVIEDO };
  assert.equal(isTeleport(a, { t: T0, ...INFIESTO }), false);
  assert.equal(isTeleport({ ...a, seen: T0 - 20 * SEC }, { t: T0, ...INFIESTO }), true);
});
