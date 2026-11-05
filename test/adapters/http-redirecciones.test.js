// Redirecciones del cliente HTTP de las fuentes. fetch las seguía solo, a cualquier origen y reenviando las
// cabeceras propias: la ApiKey del NAP, la x-api-key de e·sios o la passKey de EMT llegaban a quien
// apuntara la redirección, también de https a http. Y si EFFIS redirigía a un servicio interno, su JSON
// acababa en /api/burnt-areas. Dos servidores en 127.0.0.1 (orígenes distintos por el puerto): A redirige
// y B cuenta lo que le llega.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHttpClient } from '../../server/adapters/outbound/http/http-client.js';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';
import { createWmsTiles } from '../../server/adapters/outbound/tiles/wms-tiles.js';

const KEY = 'CLAVE-FICTICIA';
const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

let a;
let b;
const seenByB = []; // cabeceras de cada petición que llega a B
let loops = 0;
before(async () => {
  b = await listen((req, res) => {
    seenByB.push(req.headers);
    res.end('B');
  });
  a = await listen((req, res) => {
    const to = (location) => res.writeHead(302, { Location: location }).end();
    if (req.url === '/a-otro-origen') return to(`${b.base}/destino`);
    if (req.url === '/mismo-origen') return to('/final');
    if (req.url === '/final') return res.end(JSON.stringify({ apikey: req.headers.apikey ?? null }));
    if (req.url === '/bucle') {
      loops++;
      return to('/bucle');
    }
    if (req.url === '/a-fichero') return to('file:///etc/passwd');
    return res.writeHead(404).end();
  });
});
after(() => {
  a.server.close();
  b.server.close();
});

/** Cambia el fetch global mientras dura `fn`: `fake(url)` responde lo suyo o undefined para el de verdad. */
async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => (await fake(String(url))) ?? real(url, init);
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}
const redirect = (location) => new Response(null, { status: 302, headers: { location } });

test('con cabeceras propias (claves), una redirección a otro origen no se sigue y la clave no sale', async () => {
  const http = createHttpClient();
  const before = seenByB.length;
  await assert.rejects(http.bytes(`${a.base}/a-otro-origen`, { headers: { ApiKey: KEY } }), /a otro origen \(127\.0\.0\.1:\d+\): no se sigue/);
  await assert.rejects(http.json(`${a.base}/a-otro-origen`, { headers: { 'X-ClientId': KEY, passKey: KEY } }), /a otro origen/);
  assert.equal(seenByB.length, before, 'B no recibe ninguna petición');
});

test('la descarga de un GTFS del NAP (por la caché de ficheros, con su ApiKey) tampoco sigue a otro origen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-redirecciones-'));
  try {
    const cache = createFileCache({ http: createHttpClient(), dir: pathToFileURL(`${dir}/`), log: { warn() {} } });
    const before = seenByB.length;
    await assert.rejects(cache.bytes(`${a.base}/a-otro-origen`, 'gtfs-1.zip', 3_600_000, { headers: { ApiKey: KEY } }), /a otro origen/);
    assert.equal(seenByB.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('con cabeceras propias, una redirección al mismo origen se sigue y las conserva', async () => {
  assert.deepEqual(await createHttpClient().json(`${a.base}/mismo-origen`, { headers: { ApiKey: KEY } }), { apikey: KEY });
});

test('sin cabeceras, una redirección a otro origen se sigue como antes, sólo con el User-Agent', async () => {
  const before = seenByB.length;
  assert.equal(await createHttpClient({ userAgent: 'prueba' }).text(`${a.base}/a-otro-origen`), 'B');
  assert.equal(seenByB.length, before + 1);
  assert.equal(seenByB.at(-1)['user-agent'], 'prueba');
});

test('con sameOrigin, aunque no haya cabeceras, una redirección a otro origen no se sigue', async () => {
  const before = seenByB.length;
  await assert.rejects(createHttpClient().text(`${a.base}/a-otro-origen`, { sameOrigin: true }), /a otro origen/);
  assert.equal(seenByB.length, before);
});

test('las áreas quemadas de EFFIS no siguen una redirección fuera de EFFIS (su JSON va tal cual al visitante)', async () => {
  const others = [];
  const tiles = createWmsTiles({ http: createHttpClient(), dir: tmpdir() });
  await withFetch((url) => {
    if (new URL(url).host === 'maps.effis.emergency.copernicus.eu') return redirect('https://interno.test/secreto.json');
    others.push(url);
    return new Response('{"secreto":1}');
  }, () => assert.rejects(tiles.burntAreas([-4, 38, -3.9, 38.1]), /a otro origen \(interno\.test\)/));
  assert.deepEqual(others, [], 'no se pide nada fuera de EFFIS');
});

test('nunca de https a http, lleve o no cabeceras', async () => {
  const before = seenByB.length;
  await withFetch((url) => (url.startsWith('https://fuente.test/') ? redirect(`${b.base}/destino`) : undefined), async () => {
    await assert.rejects(createHttpClient().bytes('https://fuente.test/datos'), /de https a http en fuente\.test: no se sigue/);
    await assert.rejects(createHttpClient().bytes('https://fuente.test/datos', { headers: { 'x-api-key': KEY } }), /de https a http/);
  });
  assert.equal(seenByB.length, before, 'B no recibe ninguna petición');
});

test('como mucho 5 redirecciones, y sólo a http(s)', async () => {
  await assert.rejects(createHttpClient().bytes(`${a.base}/bucle`), /Más de 5 redirecciones desde 127\.0\.0\.1/);
  assert.equal(loops, 6, 'la primera petición y cinco saltos');
  await assert.rejects(createHttpClient().bytes(`${a.base}/a-fichero`), /Redirección a file: en 127\.0\.0\.1:\d+: no se sigue/);
});
