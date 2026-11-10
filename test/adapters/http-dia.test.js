// /api/dia y /api/dia/AAAA-MM-DD: el día en cifras. Hoy, con ETag y recalculado como mucho cada minuto; un día
// pasado, guardado más tiempo; mientras se lee del disco, 503 con Retry-After; sin datos, 404. Reloj simulado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, routeLabel } from '../../server/adapters/inbound/http/http-server.js';

let server;
let base;
let now = 1_000_000;
let calls = 0;
const ready = new Set();
const days = {
  summary(day) {
    calls++;
    if (day === null) return { date: '2026-11-10', today: true, n: calls };
    if (day === '2026-11-09') return ready.has(day) ? { date: day, today: false } : { date: day, loading: true };
    return null;
  },
};
before(async () => {
  server = createHttpServer({ query: {}, days, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, now: () => now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('hoy: JSON con ETag (304 si no ha cambiado) y recalculado como mucho cada minuto', async () => {
  const first = await fetch(`${base}/api/dia`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  const body = await first.json();
  assert.equal(body.date, '2026-11-10');
  assert.equal((await fetch(`${base}/api/dia`, { headers: { 'If-None-Match': etag } })).status, 304);
  now += 59_000;
  assert.equal((await (await fetch(`${base}/api/dia`)).json()).n, body.n, 'antes del minuto, la misma');
  now += 2_000;
  assert.notEqual((await (await fetch(`${base}/api/dia`)).json()).n, body.n);
});

test('un día pasado: 503 mientras se lee (sin guardar nada) y después 200 guardado una hora', async () => {
  const loading = await fetch(`${base}/api/dia/2026-11-09`);
  assert.equal(loading.status, 503);
  assert.equal(loading.headers.get('retry-after'), '2');
  assert.equal(loading.headers.get('cache-control'), 'no-store');
  ready.add('2026-11-09');
  now += 2_500; // lo de «cargando» se guarda 2 s
  const res = await fetch(`${base}/api/dia/2026-11-09`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public, max-age=3600/);
  assert.equal((await res.json()).today, false);
});

test('fechas mal escritas, 400; sin datos, 404; sin el caso de uso, la ruta no existe', async () => {
  for (const path of ['/api/dia/hoy', '/api/dia/2026-11-9', '/api/dia/..%2F..%2Fx', '/api/dia/2026-11-10/x']) {
    assert.equal((await fetch(`${base}${path}`)).status, 400, path);
  }
  assert.equal((await fetch(`${base}/api/dia/2026-02-30`)).status, 404);
  const bare = createHttpServer({ query: {}, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {} });
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${bare.address().port}/api/dia`)).status, 404);
  } finally {
    bare.close();
  }
});

test('la monitorización cuenta /api/dia y /api/dia/:fecha sin la fecha', () => {
  assert.equal(routeLabel('/api/dia', { routes: {} }), '/api/dia');
  assert.equal(routeLabel('/api/dia/2026-11-09', { routes: {} }), '/api/dia/:fecha');
});
