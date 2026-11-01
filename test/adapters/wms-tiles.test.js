import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWmsTiles, tileBbox } from '../../server/adapters/outbound/tiles/wms-tiles.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('tileBbox: z0 es el mundo entero y z1 0/0 su cuarto noroeste', () => {
  const W = 20037508.342789244;
  assert.deepEqual(tileBbox(0, 0, 0).map(Math.round), [-W, -W, W, W].map(Math.round));
  assert.deepEqual(tileBbox(1, 0, 0).map(Math.round), [-W, 0, 0, W].map(Math.round));
});

test('cada tesela se pide una vez, y si el servicio falla se sirve la copia guardada', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teselas-'));
  let calls = 0;
  let fail = false;
  const http = { bytes: async () => { calls++; if (fail) throw new Error('caído'); return PNG; } };
  const tiles = createWmsTiles({ http, dir });
  try {
    const [a, b] = await Promise.all([tiles.tile('ign-rail', 6, 31, 24), tiles.tile('ign-rail', 6, 31, 24)]);
    assert.equal(calls, 1, 'dos peticiones a la vez → una descarga');
    assert.deepEqual([...a], [...PNG]);
    assert.deepEqual([...b], [...PNG]);
    await tiles.tile('ign-rail', 6, 31, 24);
    assert.equal(calls, 1, 'la segunda vez sale del disco');
    fail = true;
    assert.equal(await tiles.tile('effis', 6, 31, 24), null, 'sin copia y con el servicio caído: null');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('una respuesta que no es imagen (error del WMS en XML) no se guarda', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teselas-'));
  const http = { bytes: async () => new TextEncoder().encode('<ServiceExceptionReport/>') };
  try {
    assert.equal(await createWmsTiles({ http, dir }).tile('effis', 5, 15, 12), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('con la cola llena, las teselas nuevas se responden al momento sin descargar ni esperar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teselas-'));
  const pending = [];
  let calls = 0;
  const http = { bytes: () => { calls++; return new Promise((resolve) => pending.push(() => resolve(PNG))); } };
  const tiles = createWmsTiles({ http, dir });
  try {
    // 4 descargando + 64 esperando turno: las 10 siguientes ya no caben.
    const all = Array.from({ length: 78 }, (_, i) => tiles.tile('ign-rail', 14, 8000 + i, 6000));
    const extra = await Promise.all(all.slice(68));
    assert.deepEqual(extra, Array(10).fill(null));
    assert.equal(calls, 4, 'sólo 4 descargas a la vez');
    while (pending.length) pending.shift()();
    await new Promise((r) => setTimeout(r, 0));
    while (calls < 68 || pending.length) {
      while (pending.length) pending.shift()();
      await new Promise((r) => setTimeout(r, 5));
    }
    const done = await Promise.all(all.slice(0, 68));
    assert.ok(done.every((png) => png && png.length === PNG.length), 'las que cupieron en la cola se sirven');
    assert.equal(calls, 68);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
