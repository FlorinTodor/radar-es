// Alerta «el retraso sube N min de golpe»: ir adelantado cuenta como ir en hora. Un tren que espera
// en su estación de origen antes de su hora sale en Renfe con retraso negativo (-23, -36 min) y al
// llegar su hora pasa a 0: eso no es una incidencia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delayJumps } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 13, 0);
const BENACAZON = { lat: 37.35694, lon: -6.208262 };
const c5 = (delay) => ({ id: 'renfe-c:3004D23721C5', mode: 'cercanias', service: 'Cercanías', label: '23721', line: 'C5', delay, ...BENACAZON });
const jumps = (before, now) => delayJumps({
  now: T0,
  vehicles: [c5(now)],
  tracks: new Map([['renfe-c:3004D23721C5', [{ t: T0 - 5 * MIN, ...BENACAZON, delay: before }]]]),
  thresholds: DEFAULT_THRESHOLDS,
});

test('pasar de adelantado (-23 min) a en hora no es una subida de retraso', () => {
  assert.deepEqual(jumps(-23, 0), []);
  assert.deepEqual(jumps(-36, 0), []);
});

test('de adelantado a un retraso grande sí avisa, contando desde en hora', () => {
  const [alert] = jumps(-10, 20);
  assert.equal(alert.title, 'Cercanías C5 23721: el retraso sube 20 min de golpe');
  assert.equal(alert.description, 'De 0 a 20 min en menos de 15 min.');
  assert.deepEqual(jumps(-30, 10), [], '10 min de retraso no llega al umbral aunque viniera de -30');
});

test('una subida de retraso de verdad sigue avisando igual', () => {
  const [alert] = jumps(7, 22);
  assert.equal(alert.title, 'Cercanías C5 23721: el retraso sube 15 min de golpe');
  assert.equal(alert.description, 'De 7 a 22 min en menos de 15 min.');
  assert.deepEqual(jumps(7, 20), []);
});
