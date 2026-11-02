// /api/stations/<código>: la ficha completa de una estación, aparte de la lista ligera.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, securityHeaders } from '../../server/adapters/inbound/http/http-server.js';

let server;
let base;
before(async () => {
  const known = { '15211': 'Oviedo', 'fgc:PC': 'Barcelona - Plaça Catalunya', 'tmb:P.6660111': 'Hospital de Bellvitge' };
  const query = { station: (code) => (known[code] ? { code, name: known[code], photo: { url: 'https://upload.wikimedia.org/x.jpg' } } : null) };
  server = createHttpServer({ query, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('estación conocida 200 con caché de catálogo; desconocida o con un código raro, 404', async () => {
  const ok = await fetch(`${base}/api/stations/15211`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control'), /public/);
  assert.equal((await ok.json()).name, 'Oviedo');
  for (const path of ['/api/stations/99999', '/api/stations/../x', '/api/stations/1521', '/api/stations/abcde']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('estaciones de otras redes: la red y su código, también con «:» codificado; nada más', async () => {
  for (const [path, name] of [['/api/stations/fgc:PC', 'Barcelona - Plaça Catalunya'], ['/api/stations/fgc%3APC', 'Barcelona - Plaça Catalunya'],
    ['/api/stations/tmb:P.6660111', 'Hospital de Bellvitge']]) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 200, path);
    assert.equal((await res.json()).name, name);
  }
  for (const path of ['/api/stations/fgc:XX', '/api/stations/FGC:PC', '/api/stations/fgc:', '/api/stations/fgc:a%2Fb', '/api/stations/fgc:%E0%A4%A', '/api/stations/:PC']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('la CSP deja cargar las fotos de Wikimedia Commons y nada más de fuera', () => {
  const csp = securityHeaders({})['Content-Security-Policy'];
  assert.match(csp, /img-src 'self' data: blob: https:\/\/upload\.wikimedia\.org https:\/\/thumb\.wikimedia\.org(;|$)/);
});
