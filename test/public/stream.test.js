// Directo de la web: si el servidor no responde porque se está actualizando (502-504, o el 503 de
// nginx), se avisa de eso y no de «sin conexión»; vuelve solo.
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function arrancar(t, respuestas) {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // los reintentos no corren solos
  globalThis.document = { hidden: false, addEventListener() {} };
  let i = 0;
  globalThis.fetch = async () => {
    const status = respuestas[Math.min(i++, respuestas.length - 1)];
    return { ok: status === 200, status, json: async () => ({ generatedAt: Date.now(), vehicles: [] }) };
  };
  const estados = [];
  const { connect } = await import(`../../public/js/stream.js?${Math.random()}`);
  const noop = () => {};
  connect({ status: (s) => estados.push(s), live: noop, events: noop, buses: noop, health: noop });
  await new Promise((resolve) => setImmediate(resolve));
  return estados;
}

test('un 503 o un 502 mientras se actualiza el servidor: «actualizando»', async (t) => {
  for (const codigo of [503, 502, 504, 522]) {
    const estados = await arrancar(t, [codigo]);
    assert.equal(estados.at(-1), 'updating', `con ${codigo}`);
    t.mock.timers.reset();
  }
});

test('otros errores no son una actualización; y con datos, en directo', async (t) => {
  assert.equal((await arrancar(t, [500])).at(-1), 'error', 'un 500 sin datos todavía: sin conexión, como siempre');
  t.mock.timers.reset();
  assert.equal((await arrancar(t, [200])).at(-1), 'live');
});

test('soon: la próxima consulta de autobuses, como mucho en 5 s (pedido durante la consulta o después), nunca más tarde', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.document = { hidden: false, addEventListener() {} };
  const pedidas = [];
  globalThis.fetch = async (url) => {
    pedidas.push(url);
    return { ok: true, status: 200, json: async () => ({ generatedAt: Date.now(), vehicles: [] }) };
  };
  const { connect } = await import(`../../public/js/stream.js?${Math.random()}`);
  const noop = () => {};
  let stream = null;
  let pedir = true;
  stream = connect({ status: noop, live: noop, events: noop, health: noop, buses: () => { if (pedir) stream.soon('buses', 5000); } }, { buses: true });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const autobuses = () => pedidas.filter((u) => u === '/api/live/buses').length;
  await settle();
  assert.equal(autobuses(), 1);
  pedir = false; // la ficha ya no espera su carretera
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(autobuses(), 2, 'pedido mientras consultaba: a los 5 s, no a los 20');
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(autobuses(), 2, 'sin pedirlo, otra vez a su ritmo');
  stream.soon('buses', 5000);
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(autobuses(), 3, 'pedido entre consultas: se adelanta');
  stream.soon('buses', 60_000);
  t.mock.timers.tick(22_000);
  await settle();
  assert.equal(autobuses(), 4, 'nunca la retrasa');
});
