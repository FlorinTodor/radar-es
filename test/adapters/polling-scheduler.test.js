import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay } from '../../server/adapters/inbound/scheduler/polling-scheduler.js';

const MIN = 60_000;

test('sin fallos se respeta el intervalo de la fuente', () => {
  assert.equal(nextDelay(20_000, 0), 20_000);
  assert.equal(nextDelay(60 * MIN, 0), 60 * MIN);
});

test('una fuente horaria que falla se reintenta pronto, no a las 2 h', () => {
  const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => nextDelay(60 * MIN, n));
  assert.deepEqual(delays.slice(0, 4), [30_000, MIN, 2 * MIN, 4 * MIN]);
  assert.equal(Math.max(...delays), 60 * MIN); // nunca más que su intervalo
});

test('una fuente rápida que falla espera como mucho 10 min', () => {
  assert.equal(nextDelay(20_000, 1), 30_000);
  assert.equal(nextDelay(20_000, 20), 10 * MIN);
});
