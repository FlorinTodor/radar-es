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
