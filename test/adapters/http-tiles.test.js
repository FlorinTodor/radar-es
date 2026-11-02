// /tiles y /api/burnt-areas: mismas respuestas que antes, pero sólo para teselas de España y
// hasta el zoom de cada capa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';
import { makeServeTiles } from '../../server/application/use-cases/serve-tiles.js';
// Vacía las colas del bucle (promesas y vueltas de E/S): lo que no tiene que pasar ya habría pasado.
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const provider = {
  layers: ['ign-rail', 'effis'],
  cacheControl: (layer) => (layer === 'effis' ? 'public, max-age=3600' : 'public, max-age=86400'),
  down: false,
  requested: [],
  async tile(...args) {
    this.requested.push(args.join('/'));
    if (this.broken) throw new Error('disco roto');
    return this.down ? null : PNG;
  },
  async burntAreas([w]) { if (w === -5) throw new Error('caído'); return { type: 'FeatureCollection', features: [] }; },
};

let server;
let base;
before(async () => {
  server = createHttpServer({
    query: {}, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, about: {},
    serveTiles: makeServeTiles({ tiles: provider }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Madrid: 8023/6178 a zoom 14 y 2005/1544 a zoom 12. París: 518/352 a zoom 10.
test('una tesela de España se sirve como PNG con la caché de su capa', async () => {
  const res = await fetch(`${base}/tiles/ign-rail/14/8023/6178.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
  assert.equal((await fetch(`${base}/tiles/effis/12/2005/1544.png`)).headers.get('cache-control'), 'public, max-age=3600');
});

test('fuera de España, por encima del zoom de la capa o con una ruta rara: 404 sin pedir nada', async () => {
  provider.requested.length = 0;
  for (const path of [
    '/tiles/ign-rail/10/518/352.png', // París
    '/tiles/ign-rail/15/16046/12356.png', // Madrid a zoom 15
    '/tiles/ign-rail/19/252981/204923.png',
    '/tiles/effis/13/4011/3089.png',
    '/tiles/osm/10/501/385.png',
    '/tiles/ign-rail/10/501/385.jpg',
    '/tiles/ign-rail/99/1/1.png',
  ]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'Tesela no válida' });
  }
  assert.deepEqual(provider.requested, []);
});

test('si el servicio no responde y no hay copia: 502 sin guardar en caché', async () => {
  provider.down = true;
  try {
    const res = await fetch(`${base}/tiles/ign-rail/14/8023/6178.png`);
    assert.equal(res.status, 502);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    provider.down = false;
  }
});

test('áreas quemadas: 200 con caché, 400 con una caja no válida y 502 si EFFIS falla', async () => {
  const ok = await fetch(`${base}/api/burnt-areas?bbox=-4,38,-3.9,38.1`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'public, max-age=600, s-maxage=1800');
  assert.deepEqual(await ok.json(), { type: 'FeatureCollection', features: [] });
  for (const q of ['', '?bbox=', '?bbox=-4,38,-2,40', '?bbox=a,b,c,d']) {
    assert.equal((await fetch(`${base}/api/burnt-areas${q}`)).status, 400, q);
  }
  const down = await fetch(`${base}/api/burnt-areas?bbox=-5,38,-4.9,38.1`);
  assert.equal(down.status, 502);
  assert.deepEqual(await down.json(), { error: 'EFFIS no responde' });
});

test('sin caso de uso de teselas, /tiles da 404 y /api/burnt-areas 400', async () => {
  const bare = createHttpServer({ query: {}, log: { error() {} }, publicDir: '/nonexistent', vendorDirs: {} });
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${bare.address().port}`;
  try {
    assert.equal((await fetch(`${url}/tiles/ign-rail/14/8023/6178.png`)).status, 404);
    assert.equal((await fetch(`${url}/api/burnt-areas?bbox=-4,38,-3.9,38.1`)).status, 400);
  } finally {
    bare.close();
  }
});

test('un fallo inesperado al leer una tesela es un 500, no una promesa sin recoger que cierra el proceso', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  provider.broken = true;
  try {
    const res = await fetch(`${base}/tiles/ign-rail/14/8023/6178.png`);
    assert.equal(res.status, 500);
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    provider.broken = false;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.equal((await fetch(`${base}/tiles/ign-rail/14/8023/6178.png`)).status, 200, 'y el servidor sigue');
});

test('áreas quemadas: una ráfaga de consultas recibe 429 en vez de llenar la cola de EFFIS', async () => {
  let asked = 0;
  const burst = createHttpServer({
    query: {}, log: { error() {} }, publicDir: '/nonexistent', vendorDirs: {}, now: () => 0, // reloj parado: no se recupera presupuesto
    serveTiles: makeServeTiles({ tiles: { ...provider, burntAreas: async () => { asked++; return { type: 'FeatureCollection', features: [] }; } } }),
  });
  await new Promise((resolve) => burst.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${burst.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${url}/api/burnt-areas?bbox=-4.${i + 10},38,-4,38.1`)).status);
    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
    assert.equal(asked, 10);
  } finally {
    burst.close();
  }
});
