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

test('escribir de golpe: quien lee a la vez ve el fichero viejo o el nuevo, nunca uno cortado', async () => {
  const { writeFileAtomic } = await import('../../server/adapters/outbound/http/file-cache.js');
  const { readFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'radar-cache-'));
  try {
    const file = join(dir, 'gtfs-1.zip');
    const before = Buffer.alloc(1 << 20, 'a');
    const after = Buffer.alloc(8 << 20, 'b');
    await writeFile(file, before);
    const reads = [];
    const writing = writeFileAtomic(file, after);
    for (let i = 0; i < 20; i++) reads.push(readFile(file));
    await writing;
    for (const got of await Promise.all(reads)) assert.ok(got.equals(before) || got.equals(after), `leídos ${got.length} bytes`);
    assert.ok((await readFile(file)).equals(after));
    assert.deepEqual(await readdir(dir), ['gtfs-1.zip'], 'sin ficheros temporales');
    await assert.rejects(writeFileAtomic(dir, 'x'), 'no se puede poner un fichero encima de una carpeta');
    assert.deepEqual(await readdir(dir), ['gtfs-1.zip'], 'si falla, tampoco queda el temporal');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('una descarga se guarda de golpe y sin restos', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-cache-'));
  try {
    const bytes = new Uint8Array(3 << 20).fill(7);
    const cache = createFileCache({ http: { bytes: async () => bytes }, dir: pathToFileURL(`${dir}/`), log: { warn() {} } });
    assert.equal((await cache.bytes('https://x.example/gtfs.zip', 'gtfs-2.zip', 60_000)).length, bytes.length);
    assert.deepEqual(await readdir(dir), ['gtfs-2.zip']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
