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
    ahead: (id, at) => (id === 'euskotren:TG2:1' ? [at ?? [-2.67, 42.85], [-2.66, 42.85]] : null),
    stops: (id) => (id === 'renfe-ld:18000' ? { partial: false, stops: [{ name: 'A', passed: true }, { name: 'B', passed: false }] } : null),
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
  assert.match(ok.headers.get('cache-control'), /^public, .*s-maxage=/);
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

test('/api/stops/<id>: las paradas del viaje; si no se saben, 404; un id mal codificado, 400', async () => {
  const ok = await fetch(`${base}/api/stops/${encodeURIComponent('renfe-ld:18000')}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control'), /^public, .*s-maxage=/);
  assert.equal((await ok.json()).stops.length, 2);
  const missing = await fetch(`${base}/api/stops/otro`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Paradas desconocidas' });
  assert.equal((await fetch(`${base}/api/stops/%E0%A4%A`)).status, 400);
});

test('?en=lon,lat: lo que le queda desde donde la web pinta el vehículo, redondeado a 5 decimales; uno que no vale, sin él', async () => {
  const id = encodeURIComponent('euskotren:TG2:1');
  assert.deepEqual((await (await fetch(`${base}/api/ahead/${id}?en=-2.6712345678,42.8512345678`)).json())[0], [-2.67123, 42.85123]);
  assert.deepEqual((await (await fetch(`${base}/api/ahead/${id}?en=-2.668,42.85`)).json())[0], [-2.668, 42.85], 'otra posición, otro cálculo');
  for (const bad of ['x', '1,2,3', '-2.67;42.85', '999,42', '-2.67,91', '']) {
    const res = await fetch(`${base}/api/ahead/${id}?en=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200, bad);
    assert.deepEqual((await res.json())[0], [-2.67, 42.85], `«${bad}»: como sin él`);
  }
});
