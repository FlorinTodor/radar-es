// Caché en disco: además de las descargas, guarda resultados calculados (JSON) para no repetirlos al arrancar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';

test('guarda y lee un JSON; si no está o está dañado, null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-cache-'));
  try {
    const cache = createFileCache({ http: {}, dir: pathToFileURL(`${dir}/`), log: { warn() {} } });
    assert.equal(await cache.readJson('nada.json'), null);
    await cache.writeJson('paradas.json', { key: 'a', trips: ['T1', 0] });
    assert.deepEqual(await cache.readJson('paradas.json'), { key: 'a', trips: ['T1', 0] });
    await writeFile(join(dir, 'roto.json'), '{ no es json');
    assert.equal(await cache.readJson('roto.json'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
