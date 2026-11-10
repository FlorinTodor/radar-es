// /api/live/siguiendo?clave=…: cómo está lo que alguien sigue, por su clave (domain/seguir.js), igual para
// todo el mundo y con la caché del directo; y los módulos del dominio que el navegador usa tal cual
// (/server/domain/…), sólo los de la lista y que sólo se importan entre ellos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHttpServer, SHARED_DOMAIN_MODULES, sharedDomainFiles } from '../../server/adapters/inbound/http/http-server.js';
import { lineKey } from '../../server/domain/seguir.js';

const DOMAIN = fileURLToPath(new URL('../../server/domain/', import.meta.url));
const BUS_27 = lineKey({ operator: 'EMT Málaga', line: '27' });

let server;
let base;
const asked = [];
before(async () => {
  const query = {
    following: (key) => {
      asked.push(key);
      return { generatedAt: 1, key, kind: 'linea', state: 'circulan', vehicles: { total: 1, withDelayInfo: 1, delayed: 0, list: [] }, events: { total: 0, active: 0, list: [] } };
    },
  };
  server = createHttpServer({ query, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, sharedFiles: sharedDomainFiles(DOMAIN) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('una clave válida: su estado, con la caché del directo y una sola consulta para muchas peticiones', async () => {
  const url = `${base}/api/live/siguiendo?clave=${encodeURIComponent(BUS_27)}`;
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /s-maxage=15/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.equal((await res.json()).key, BUS_27);
  await fetch(url);
  assert.equal(asked.filter((k) => k === BUS_27).length, 1, 'la segunda, del memo');
  const again = await fetch(url, { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('sin clave, o con una que no lo es, 400 sin llegar a consultar nada', async () => {
  const before = asked.length;
  for (const q of ['', '?clave=', '?clave=hola', `?clave=${'l-a'.padEnd(70, 'b')}`, '?clave=l-emt%20malaga', '?clave=../etc']) {
    assert.equal((await fetch(`${base}/api/live/siguiendo${q}`)).status, 400, q);
  }
  assert.equal(asked.length, before);
});

test('los módulos compartidos se sirven como JavaScript; nada más de server/', async () => {
  for (const f of SHARED_DOMAIN_MODULES) {
    const res = await fetch(`${base}/server/domain/${f}`);
    assert.equal(res.status, 200, f);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(await res.text(), await readFile(new URL(`../../server/domain/${f}`, import.meta.url), 'utf8'));
  }
  for (const path of ['/server/domain/model.js', '/server/main.js', '/server/domain/../main.js', '/server/domain/%2e%2e/main.js', '/server/domain/']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});

test('los módulos compartidos sólo importan otros compartidos (el navegador no tiene el resto)', async () => {
  for (const f of SHARED_DOMAIN_MODULES) {
    // Sin comentarios: los tipos de JSDoc citan otros módulos con import('…') y eso no se carga.
    const source = (await readFile(new URL(`../../server/domain/${f}`, import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const spec of imports) {
      assert.match(spec, /^\.\/[\w-]+\.js$/, `${f} importa ${spec}`);
      assert.ok(SHARED_DOMAIN_MODULES.includes(spec.slice(2)), `${f} importa ${spec}, que no se sirve al navegador`);
    }
    assert.doesNotMatch(source, /\bimport\s*\(|\bprocess\.|\brequire\(/, `${f} no usa nada sólo de Node`);
  }
});

test('presupuesto por cliente: uno que pide claves inventadas sin parar no deja sin consultas a los demás', async () => {
  let t = 1_000_000; // reloj parado: el presupuesto no se rellena durante la prueba
  const query = { following: (key) => ({ generatedAt: 1, key, kind: 'linea', state: 'no-se-ve', vehicles: { total: 0, list: [] }, events: { total: 0, list: [] } }) };
  const own = createHttpServer({ query, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, now: () => t });
  await new Promise((resolve) => own.listen(0, '127.0.0.1', resolve));
  const url = (n) => `http://127.0.0.1:${own.address().port}/api/live/siguiendo?clave=l-inventada-${n}`;
  try {
    const statuses = [];
    for (let n = 0; n < 70; n++) statuses.push((await fetch(url(n), { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status);
    assert.equal(statuses.filter((s) => s === 200).length, 60, 'la ráfaga de un cliente: 60 claves nuevas');
    assert.equal(statuses.at(-1), 503);
    assert.equal((await fetch(url(0), { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status, 200, 'lo que ya está en el memo no gasta');
    assert.equal((await fetch(url(500), { headers: { 'CF-Connecting-IP': '198.51.100.2' } })).status, 200, 'otro cliente sigue pudiendo');
    t += 1_000;
    assert.equal((await fetch(url(71), { headers: { 'CF-Connecting-IP': '203.0.113.7' } })).status, 200, 'pasado un segundo, vuelve a tener');
  } finally {
    own.close();
  }
});
