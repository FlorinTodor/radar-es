// Planificador: cuándo se evalúan las alertas. A los 5 s de una lectura (las lecturas que llegan en
// esos 5 s se agrupan en una sola evaluación) y, aunque no lleguen datos, cada 30 s: las alertas
// también dependen del tiempo que pasa. Temporizadores simulados con mock.timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPolling } from '../../server/adapters/inbound/scheduler/polling-scheduler.js';

const quietLog = { info() {}, warn() {}, error() {} };
/** Deja correr las promesas pendientes (las lecturas son asíncronas); setImmediate no está simulado. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Ojo con mock.timers: lo que se programa dentro de un tick cuenta desde el final de ese tick. Por eso
// se avanza justo hasta cada latido y luego los 5 s de espera, y no de golpe.

function start(t, { feeds = [], ingestSource = async () => true, detectAlerts, log = quietLog } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let detections = 0;
  const scheduler = startPolling({ feeds, ingestSource, detectAlerts: detectAlerts ?? (() => { detections++; }), log });
  t.after(() => scheduler.stop());
  return { scheduler, detections: () => detections };
}

test('las alertas se evalúan a los 5 s de una lectura, no antes', async (t) => {
  const { detections } = start(t, { feeds: [{ id: 'renfe', interval: 20_000 }] });
  t.mock.timers.tick(0); // primera lectura de renfe
  await flush();
  t.mock.timers.tick(4999);
  assert.equal(detections(), 0);
  t.mock.timers.tick(1);
  assert.equal(detections(), 1);
});

test('una lectura que falla también lleva a evaluar las alertas (la de «fuente caída»)', async (t) => {
  const { detections } = start(t, { feeds: [{ id: 'renfe', interval: 20_000 }], ingestSource: async () => false });
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(detections(), 1);
});

test('las lecturas que llegan dentro de esos 5 s se agrupan en una sola evaluación', async (t) => {
  const feeds = ['renfe', 'fgc', 'dgt', 'aemet'].map((id) => ({ id, interval: 60_000 }));
  const { detections } = start(t, { feeds });
  for (let i = 0; i < feeds.length; i++) {
    t.mock.timers.tick(i ? 250 : 0); // arranque escalonado: una cada 250 ms
    await flush();
  }
  t.mock.timers.tick(5000 - 3 * 250 - 1);
  assert.equal(detections(), 0, 'cuatro lecturas en 750 ms');
  t.mock.timers.tick(1);
  assert.equal(detections(), 1, 'una sola evaluación, a los 5 s de la primera');
  t.mock.timers.tick(5000);
  assert.equal(detections(), 1, 'y no otra por las lecturas que llegaron mientras tanto');
});

test('sin lecturas, el latido evalúa las alertas cada 30 s (más los 5 s de espera)', async (t) => {
  const { detections } = start(t);
  t.mock.timers.tick(30_000);
  assert.equal(detections(), 0, 'el latido sólo la programa');
  t.mock.timers.tick(5000);
  assert.equal(detections(), 1, 'a los 35 s');
  t.mock.timers.tick(25_000);
  assert.equal(detections(), 1);
  t.mock.timers.tick(5000);
  assert.equal(detections(), 2, 'a los 65 s');
  t.mock.timers.tick(25_000);
  t.mock.timers.tick(5000);
  assert.equal(detections(), 3, 'a los 95 s');
});

test('si evaluar las alertas falla, se registra y la siguiente vez se vuelve a evaluar', async (t) => {
  const errors = [];
  let calls = 0;
  start(t, {
    detectAlerts: () => { calls++; if (calls === 1) throw new Error('regla rota'); },
    log: { ...quietLog, error: (msg) => errors.push(msg) },
  });
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(5000);
  assert.equal(calls, 1);
  assert.match(errors[0], /^\[alertas\] Error: regla rota/);
  t.mock.timers.tick(25_000);
  t.mock.timers.tick(5000);
  assert.equal(calls, 2, 'el planificador sigue');
});

test('al parar, no se evalúa lo que estaba pendiente ni vuelve a latir', async (t) => {
  const { scheduler, detections } = start(t, { feeds: [{ id: 'renfe', interval: 20_000 }] });
  t.mock.timers.tick(0);
  await flush();
  scheduler.stop();
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(detections(), 0);
});
