// Red ferroviaria de Adif: se descarga una vez al mes con la caché de disco, no guarda las respuestas
// de error ni las vacías y, si Adif falla, sigue con la copia guardada sin volver a preparar la red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';
import { ADIF_TRAMOS_URL, createAdifRailNetwork, parseTramos } from '../../server/adapters/outbound/network/adif-rail-network.js';

const FIXTURE = new URL('./fixtures/adif-tramos-mini.geojson', import.meta.url);
const bytes = (obj) => new TextEncoder().encode(JSON.stringify(obj));
const quiet = { info() {}, warn() {}, error() {} };

test('lee los tramos (también los de varias partes) y rechaza lo que no es la red', async () => {
  const fixture = new Uint8Array(await readFile(FIXTURE));
  const { lines, truncated } = parseTramos(fixture, 3);
  assert.equal(lines.length, 4, '2 tramos simples y uno de dos partes');
  assert.deepEqual(lines[0][0], [-3.1, 40.0]);
  assert.equal(truncated, false);
  assert.throws(() => parseTramos(fixture), /llega con 4 tramos/, 'la red de verdad tiene más de mil');
  assert.throws(() => parseTramos(bytes({ error: { code: 400, message: 'Invalid query' } }), 1), /error 400/);
  assert.throws(() => parseTramos(new TextEncoder().encode('<html>'), 1), /no es JSON/);
  assert.throws(() => parseTramos(bytes({ type: 'FeatureCollection', features: [] }), 1), /0 tramos/);
  const cut = JSON.parse(new TextDecoder().decode(fixture));
  cut.properties = { exceededTransferLimit: true };
  assert.equal(parseTramos(bytes(cut), 3).truncated, true);
});

test('descarga, guarda, no repite la preparación y sigue con la copia si Adif falla', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-adif-'));
  try {
    const fixture = new Uint8Array(await readFile(FIXTURE));
    let reply = () => bytes({ error: { code: 500, message: 'Error performing query operation' } });
    const asked = [];
    const http = { bytes: async (url) => { asked.push(url); return reply(); } };
    const cache = createFileCache({ http, dir: pathToFileURL(`${dir}/`), log: quiet });
    const rail = createAdifRailNetwork({ cache, log: quiet, minTramos: 3 });
    const file = join(dir, 'adif-tramos-en-servicio.geojson');

    // ArcGIS contesta el error con un 200: no se guarda y no hay red (los recorridos, con rectas).
    await assert.rejects(rail.load(), /error 500/);
    assert.equal(rail.network(), null);
    await assert.rejects(stat(file), { code: 'ENOENT' });
    assert.equal(asked[0], ADIF_TRAMOS_URL);

    reply = () => fixture;
    assert.equal(await rail.load(), 4);
    const net = rail.network();
    assert.ok(net && net.edges >= 4 && net.nodes >= 4);
    assert.deepEqual(new Uint8Array(await readFile(file)), fixture, 'guardada en disco');

    // La recarga periódica, con la copia aún vigente: ni descarga ni prepara otra vez la red.
    assert.equal(await rail.load(), 4);
    assert.equal(rail.network(), net);
    assert.equal(asked.length, 2);

    // Pasado el mes Adif falla: sigue la copia vieja, con la misma red.
    const old = new Date(Date.now() - 40 * 24 * 3600_000);
    await utimes(file, old, old);
    reply = () => { throw new Error('HTTP 503 en services7.arcgis.com'); };
    assert.equal(await rail.load(), 4);
    assert.equal(rail.network(), net);
    assert.equal(asked.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
