import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { createHttpServer, cleanPagePath } from '../../server/adapters/inbound/http/http-server.js';

const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));
const SITE = 'https://xn--radarespaa-19a.es';

let server;
let base;
before(async () => {
  server = createHttpServer({
    query: {}, bus: { subscribe: () => () => {} }, log: { error() {}, info() {}, warn() {} },
    publicDir: PUBLIC, vendorDirs: {}, about: { publicUrl: SITE },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path) => fetch(base + path, { redirect: 'manual' });
/** fetch no deja cambiar la cabecera Host: para eso, node:http. */
const getWithHost = (path, host) => new Promise((resolve, reject) => {
  request(base + path, { headers: { Host: host } }, (res) => {
    res.resume();
    resolve({ status: res.statusCode, location: res.headers.location });
  }).on('error', reject).end();
});

test('cleanPagePath: una sola dirección por página y nunca una redirección a otra web', () => {
  assert.equal(cleanPagePath('/legal.html'), '/legal');
  assert.equal(cleanPagePath('/legal/'), '/legal');
  assert.equal(cleanPagePath('/index.html'), '/');
  assert.equal(cleanPagePath('/'), '/');
  assert.equal(cleanPagePath('/style.css'), '/style.css');
  assert.equal(cleanPagePath('//evil.com.html'), '/evil.com');
  assert.ok(!cleanPagePath('//evil.com/').startsWith('//'));
});

test('www redirige con 301 al dominio canónico conservando ruta y consulta', async () => {
  const res = await getWithHost('/legal?x=1', 'www.xn--radarespaa-19a.es');
  assert.equal(res.status, 301);
  assert.equal(res.location, `${SITE}/legal?x=1`);
});

test('el dominio canónico, localhost y la IP no se redirigen', async () => {
  assert.equal((await getWithHost('/legal', 'xn--radarespaa-19a.es')).status, 200);
  assert.equal((await getWithHost('/legal', 'localhost:8080')).status, 200);
  assert.equal((await get('/legal')).status, 200);
});

test('las URL con .html, barra final o /index.html redirigen a la URL limpia', async () => {
  for (const [from, to] of [['/legal.html', '/legal'], ['/legal/', '/legal'], ['/index.html', '/'], ['/legal.html?a=b', '/legal?a=b']]) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('una página que no existe devuelve 404 en HTML y sin indexar', async () => {
  const res = await get('/no-existe');
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /<meta name="robots" content="noindex">/);
  assert.match((await get('/no-existe.js')).headers.get('content-type'), /application\/json/, 'un fichero que falta sigue siendo JSON');
});

test('la API no se indexa', async () => {
  const res = await get('/api/no-existe');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
});
