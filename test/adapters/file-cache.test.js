// Caché en disco: además de las descargas, guarda resultados calculados para no repetirlos al arrancar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';

test('guarda y lee un resultado con Map y arrays tipados; si no está o está dañado, null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-cache-'));
  try {
    const cache = createFileCache({ http: {}, dir: pathToFileURL(`${dir}/`), log: { warn() {} } });
    assert.equal(await cache.readValue('nada.v8'), null);
    const value = { key: 'a', trips: ['T1', 0], calendar: new Map([['S', { days: [true] }]]), times: Int32Array.from([1, 2, 3]) };
    await cache.writeValue('horario.v8', value);
    assert.deepEqual(await cache.readValue('horario.v8'), value);
    assert.deepEqual(await readdir(dir), ['horario.v8'], 'sin ficheros temporales');
    await writeFile(join(dir, 'roto.v8'), 'no es v8');
    assert.equal(await cache.readValue('roto.v8'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
