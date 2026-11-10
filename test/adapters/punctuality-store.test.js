// La copia de la puntualidad en disco: comprimida, de golpe y, si no se lee, como si no hubiera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPunctualityStore } from '../../server/adapters/outbound/persistence/punctuality-store.js';

test('guarda y lee lo mismo (con arrays tipados); sin fichero, null; uno estropeado, null y se apunta', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-puntualidad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const store = createPunctualityStore({ dir: pathToFileURL(`${dir}/`), log: { warn: (m) => warnings.push(m) } });
  assert.equal(await store.load(), null);
  assert.deepEqual(warnings, [], 'que no haya copia no es un aviso');
  const snapshot = { version: 1, data: new Int16Array([1, -32768, 3]), keys: 'a\nb' };
  await store.save(snapshot);
  assert.deepEqual(await store.load(), snapshot);
  assert.deepEqual(await readdir(dir), ['puntualidad.v1.gz'], 'sin ficheros a medio escribir');
  await writeFile(join(dir, 'puntualidad.v1.gz'), 'no es gzip');
  assert.equal(await store.load(), null);
  assert.match(warnings[0], /no se pudo leer la copia guardada/);
});

test('si no puede escribir, lo apunta y no rechaza', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-puntualidad-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'fichero'), 'x');
  const warnings = [];
  // Su carpeta es un fichero: no se puede escribir dentro.
  const store = createPunctualityStore({ dir: pathToFileURL(`${dir}/fichero/`), log: { warn: (m) => warnings.push(m) } });
  await store.save({ version: 1 });
  assert.match(warnings[0], /no se pudo guardar la copia/);
});
