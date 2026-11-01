// /api/tracks/<id>: el id llega codificado en la ruta; uno mal codificado es un error del cliente.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

let server;
let base;
const errors = [];
before(async () => {
  const query = {
    track: (id) => (id === 'Renfe 7/123' ? [{ lat: 40, lon: -3.7 }] : null),
    ahead: (id) => (id === 'euskotren:TG2:1' ? [[-2.67, 42.85], [-2.66, 42.85]] : null),
  };
  server = createHttpServer({
    query, log: { error: (msg) => errors.push(msg), info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('el id se decodifica: recorrido conocido 200, desconocido 404', async () => {
  const ok = await fetch(`${base}/api/tracks/${encodeURIComponent('Renfe 7/123')}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await ok.json(), [{ lat: 40, lon: -3.7 }]);
  const missing = await fetch(`${base}/api/tracks/otro`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Vehículo sin historial' });
});

test('un %-escape roto responde 400 y no deja un error en el log', async () => {
  const res = await fetch(`${base}/api/tracks/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Ruta inválida' });
  assert.deepEqual(errors, []);
});

test('/api/ahead/<id>: lo que le queda a un vehículo estimado; si no se sabe, 404', async () => {
  const ok = await fetch(`${base}/api/ahead/${encodeURIComponent('euskotren:TG2:1')}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [[-2.67, 42.85], [-2.66, 42.85]]);
  assert.equal((await fetch(`${base}/api/ahead/otro`)).status, 404);
});
