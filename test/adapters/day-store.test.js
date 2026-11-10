// El registro de cada día del día en cifras en disco: se guarda de golpe, se lee y se quedan los últimos días.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDayStore } from '../../server/adapters/outbound/persistence/day-store.js';

test('guarda, lee y lista los días; borra los que pasan del tope; lo raro no se lee', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const store = createDayStore({ dir: pathToFileURL(`${dir}/dias/`), log: { warn: (m) => warnings.push(m) }, keepDays: 2 });
  assert.equal(await store.load('2026-11-10'), null, 'sin carpeta todavía');
  assert.deepEqual(await store.days(), []);
  for (const date of ['2026-11-08', '2026-11-09', '2026-11-10']) await store.save({ date, v: 1, n: date.slice(-2) });
  assert.deepEqual(await store.days(), ['2026-11-09', '2026-11-10'], 'sólo los dos últimos');
  assert.deepEqual(await store.load('2026-11-10'), { date: '2026-11-10', v: 1, n: '10' });
  assert.equal(await store.load('2026-11-08'), null);
  await store.save({ date: '../fuera' });
  assert.deepEqual((await readdir(join(dir, 'dias'))).sort(), ['dia-2026-11-09.json', 'dia-2026-11-10.json'], 'nada fuera de su sitio ni ficheros a medias');
  assert.equal(await store.load('../dias/dia-2026-11-10'), null);
  await writeFile(join(dir, 'dias', 'dia-2026-11-09.json'), '{roto');
  assert.equal(await store.load('2026-11-09'), null);
  assert.equal(warnings.length, 1, 'el roto se avisa');
});
