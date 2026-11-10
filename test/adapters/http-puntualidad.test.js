// /api/puntualidad/<clave>: la de un servicio o una línea; sólo claves válidas de esos dos tipos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, routeLabel } from '../../server/adapters/inbound/http/http-server.js';

let server;
let base;
const asked = [];
before(async () => {
  const query = { punctuality: (key) => { asked.push(key); return key === 's-renfe-8058' ? { key, kind: 'servicio', days: [] } : null; } };
  server = createHttpServer({ query, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('una clave conocida, 200 con caché corta; una que no se conoce, 404; lo que no es una clave de servicio o de línea, 400 sin preguntar', async () => {
  const ok = await fetch(`${base}/api/puntualidad/s-renfe-8058`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=60, s-maxage=120');
  assert.equal((await ok.json()).kind, 'servicio');
  assert.equal((await fetch(`${base}/api/puntualidad/l-amb-V15`)).status, 404);
  asked.length = 0;
  for (const path of ['p-71801', 'x', 's-', `s-${'a'.repeat(70)}`, 's-renfe-8058%2F..', '%E0%A4%A', '']) {
    assert.equal((await fetch(`${base}/api/puntualidad/${path}`)).status, 400, path);
  }
  assert.deepEqual(asked, [], 'no llegan al caso de uso');
  assert.equal(routeLabel('/api/puntualidad/s-renfe-8058', { routes: {} }), '/api/puntualidad/:clave', 'la monitorización no ve la clave');
});
