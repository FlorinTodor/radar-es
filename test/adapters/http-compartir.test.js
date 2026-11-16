import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHttpServer, routeLabel, sharedHead } from '../../server/adapters/inbound/http/http-server.js';
import { readFile } from 'node:fs/promises';
import { makeShare } from '../../server/application/use-cases/share.js';

const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));
const SITE = 'https://xn--radarespaa-19a.es';
const NOW = Date.UTC(2026, 10, 16, 10, 42);
const accident = { id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'alta', title: 'Accidente · A-7 & "km" 214', description: 'Málaga', lat: 36.7, lon: -4.4 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let server;
let base;
let renders = 0;
const state = { events: [accident], now: NOW };
before(async () => {
  const share = makeShare({
    query: { events: () => state.events, vehicles: () => [], health: () => [{ id: 'dgt', license: 'Fuente: DGT' }], station: () => null },
    store: { load: async () => null, save: async () => {} },
    renderer: { available: () => true, render: async () => { renders++; return PNG; } },
    clock: { now: () => state.now },
    log: { info() {}, warn() {}, error() {} },
  });
  state.share = share;
  server = createHttpServer({ query: {}, log: { error() {}, info() {}, warn() {} }, publicDir: PUBLIC, vendorDirs: {}, about: { publicUrl: SITE }, share, now: () => state.now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const meta = (html, prop) => new RegExp(`<meta property="${prop}" content="([^"]*)">`).exec(html)?.[1];

test('el enlace de una incidencia es el mapa con su título, su descripción y su tarjeta, fuera de los buscadores', async () => {
  const res = await fetch(`${base}/incidencia/dgt:1`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<title>Accidente · A-7 &amp; &quot;km&quot; 214 · Radar España<\/title>/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.equal(meta(html, 'og:title'), 'Accidente · A-7 &amp; &quot;km&quot; 214');
  assert.equal(meta(html, 'og:url'), `${SITE}/incidencia/dgt:1`);
  assert.match(meta(html, 'og:image'), new RegExp(`^${SITE}/api/tarjeta/incidencia/dgt:1\\.png\\?v=[0-9a-z]{7}$`));
  assert.match(html, /<script type="module" src="\/js\/app.js"><\/script>/); // el mapa de siempre
});

test('en inglés, la tarjeta y la dirección lo dicen', async () => {
  const html = await (await fetch(`${base}/incidencia/dgt:1?lang=en`)).text();
  assert.equal(meta(html, 'og:url'), `${SITE}/incidencia/dgt:1?lang=en`);
  assert.match(meta(html, 'og:image'), /&amp;lang=en$/);
  assert.equal(meta(html, 'og:locale'), 'en_GB');
});

test('lo que no se conoce: el mapa con 404 y la imagen general', async () => {
  const res = await fetch(`${base}/incidencia/no-existe`);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.equal(meta(html, 'og:image'), `${SITE}/og.png`);
  assert.match(html, /Ya no está en el directo/);
});

test('la tarjeta: PNG; con su versión, para siempre; sin ella, un minuto; 304 con su ETag', async () => {
  const html = await (await fetch(`${base}/incidencia/dgt:1`)).text();
  const image = meta(html, 'og:image').replace(SITE, base);
  const res = await fetch(image);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
  const old = await fetch(`${base}/api/tarjeta/incidencia/dgt:1.png?v=vieja00`);
  assert.equal(old.headers.get('cache-control'), 'public, max-age=60, s-maxage=60');
  await old.arrayBuffer();
  const again = await fetch(image, { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
});

test('tarjeta de algo que no existe o con una ruta rara: 404, sin dibujar nada', async () => {
  const before_ = renders;
  for (const path of ['/api/tarjeta/incidencia/no-existe.png', '/api/tarjeta/incidencia/dgt:1', '/api/tarjeta/otra/dgt:1.png', '/api/tarjeta/incidencia/%E0%A4%A.png']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
    await res.arrayBuffer();
  }
  assert.equal(renders, before_);
});

test('/api/compartido: si sigue en el directo y, si no, lo último que se supo', async () => {
  const live = await (await fetch(`${base}/api/compartido/incidencia/dgt:1`)).json();
  assert.equal(live.status, 'activa');
  state.share.remember();
  state.events = [];
  state.share.remember();
  state.now += 5_000; // el índice por id se rehace cada 5 s
  const gone = await (await fetch(`${base}/api/compartido/incidencia/dgt:1`)).json();
  assert.equal(gone.status, 'terminada');
  assert.equal(gone.event.title, accident.title);
  assert.equal(gone.endedAt, NOW);
  assert.equal((await fetch(`${base}/api/compartido/incidencia/otra`)).status, 404);
  assert.equal((await fetch(`${base}/api/compartido/nada`)).status, 404);
  state.events = [accident];
  state.now += 5_000;
});

test('las métricas cuentan cada tipo de enlace sin decir cuál', () => {
  const routes = {};
  assert.equal(routeLabel('/incidencia/dgt:1', { routes }), '/incidencia/:id');
  assert.equal(routeLabel('/vehiculo/x.y', { routes }), '/vehiculo/:id');
  assert.equal(routeLabel('/estacion/71801', { routes }), '/estacion/:id');
  assert.equal(routeLabel('/api/tarjeta/incidencia/dgt:1.png', { routes }), '/api/tarjeta/:id');
  assert.equal(routeLabel('/api/compartido/incidencia/dgt:1', { routes }), '/api/compartido/:id');
});

test('index.html tiene todas las etiquetas que cambia cada enlace (si alguien las quita, este test avisa)', async () => {
  const html = await readFile(`${PUBLIC}/index.html`, 'utf8');
  const card = { title: 'T$&$1', summary: 'S', alt: 'A', version: 'abcdefg', path: '/incidencia/x' };
  const out = sharedHead(html, { origin: SITE, kind: 'incidencia', id: 'x', lang: 'es', card, cards: true });
  for (const prop of ['og:title', 'og:description', 'og:url', 'og:image', 'og:image:alt']) {
    assert.notEqual(meta(out, prop), meta(html, prop), prop);
  }
  assert.match(out, /<title>T\$&amp;\$1 · Radar España<\/title>/); // «$&» y «$1» tal cual, sin interpretarlos
  assert.match(out, /<link rel="canonical" href="https:\/\/xn--radarespaa-19a\.es\/incidencia\/x">/);
  assert.equal((out.match(/name="robots"/g) ?? []).length, 1);
});

test('/api/compartido de una que su fuente publicó de nuevo con otro identificador: dice cuál es la de ahora', async () => {
  state.share.remember();
  state.events = [{ ...accident, id: 'dgt:nuevo' }];
  state.now += 60_000;
  state.share.remember();
  state.now += 5_000;
  const body = await (await fetch(`${base}/api/compartido/incidencia/dgt:1`)).json();
  assert.equal(body.status, 'activa');
  assert.equal(body.current, 'dgt:nuevo');
  const html = await (await fetch(`${base}/incidencia/dgt:1`)).text();
  assert.match(html, /<meta property="og:url" content="https:\/\/xn--radarespaa-19a\.es\/incidencia\/dgt:nuevo">/);
  state.events = [accident];
  state.now += 5_000;
});
