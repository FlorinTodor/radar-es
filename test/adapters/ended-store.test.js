import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createEndedStore } from '../../server/adapters/outbound/persistence/ended-store.js';

test('guarda y vuelve a leer las incidencias terminadas; sin copia o con una rota, null y un aviso', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-compartir-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warned = [];
  const store = createEndedStore({ dir: pathToFileURL(`${dir}/compartir/`), log: { warn: (m) => warned.push(m) } });
  assert.equal(await store.load(), null);
  assert.equal(warned.length, 0); // no haber copia no es un fallo
  const record = { version: 1, ended: [{ event: { id: 'dgt:1', title: 'x', category: 'carretera' }, endedAt: 1 }] };
  await store.save(record);
  assert.deepEqual(await store.load(), record);
  await mkdir(`${dir}/rota/`, { recursive: true });
  await writeFile(`${dir}/rota/terminadas.v1.json.gz`, 'no es gzip');
  const broken = createEndedStore({ dir: pathToFileURL(`${dir}/rota/`), log: { warn: (m) => warned.push(m) } });
  assert.equal(await broken.load(), null);
  assert.equal(warned.length, 1);
});
