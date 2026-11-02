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
