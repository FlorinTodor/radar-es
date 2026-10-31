import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDelay, startPolling } from '../../server/adapters/inbound/scheduler/polling-scheduler.js';

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

const HOUR = 60 * MIN;
const quietLog = { info() {}, warn() {}, error() {} };
/** Deja correr las promesas pendientes (las lecturas son asíncronas). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('el planificador lee cada fuente por su id, escalonadas 250 ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const read = [];
  const scheduler = startPolling({
    feeds: [{ id: 'renfe', interval: 20_000 }, { id: 'dgt', interval: 60_000 }],
    ingestSource: async (id) => { read.push(id); return true; },
    detectAlerts() {},
    log: quietLog,
  });
  try {
    t.mock.timers.tick(0);
    assert.deepEqual(read, ['renfe']);
    t.mock.timers.tick(250);
    assert.deepEqual(read, ['renfe', 'dgt']);
    await flush();
    t.mock.timers.tick(20_000);
    assert.deepEqual(read, ['renfe', 'dgt', 'renfe'], 'renfe otra vez a los 20 s');
  } finally {
    scheduler.stop();
  }
});

test('los catálogos se recargan cada 6 h y dejan de recargarse al parar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let refreshed = 0;
  const scheduler = startPolling({ feeds: [], ingestSource: async () => true, detectAlerts() {}, refreshCatalogs: async () => { refreshed++; }, log: quietLog });
  t.mock.timers.tick(6 * HOUR - 1);
  assert.equal(refreshed, 0, 'la primera carga la hace el arranque');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(refreshed, 1);
  t.mock.timers.tick(6 * HOUR);
  await flush();
  assert.equal(refreshed, 2);
  scheduler.stop();
  t.mock.timers.tick(12 * HOUR);
  await flush();
  assert.equal(refreshed, 2);
});

test('si la recarga de catálogos falla, se registra y el planificador sigue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const warnings = [];
  const scheduler = startPolling({
    feeds: [], ingestSource: async () => true, detectAlerts() {},
    refreshCatalogs: async () => { throw new Error('Renfe no responde'); },
    log: { ...quietLog, warn: (msg) => warnings.push(msg) },
  });
  try {
    t.mock.timers.tick(6 * HOUR);
    await flush();
    assert.deepEqual(warnings, ['[catálogos] Renfe no responde']);
  } finally {
    scheduler.stop();
  }
});
