// Histórico diario en JSONL: se escribe cada fila en el fichero del día y, una vez al día, se borran
// los de hace más de `keepDays` (sólo los suyos, por su nombre). Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJsonlHistory } from '../../server/adapters/outbound/persistence/jsonl-history.js';

test('escribe en el fichero del día y borra los diarios de hace más de keepDays', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'historial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['alerts-2026-07-01.jsonl', 'kpis-2026-08-03.jsonl', 'kpis-2026-08-04.jsonl', 'notas.txt']) await writeFile(join(dir, name), 'x\n');
  let now = Date.parse('2026-11-02T12:00:00+01:00');
  const history = createJsonlHistory({ dir: pathToFileURL(`${dir}/`), log: { warn: assert.fail }, keepDays: 90, now: () => now });
  await history.append('alerts', { id: 'a' });
  assert.deepEqual((await readdir(dir)).sort(), ['alerts-2026-11-02.jsonl', 'kpis-2026-08-04.jsonl', 'notas.txt'],
    'el 4 de agosto está justo dentro de los 90 días; lo que no es un diario suyo no se toca');
  assert.equal(await readFile(join(dir, 'alerts-2026-11-02.jsonl'), 'utf8'), '{"id":"a"}\n');
  await writeFile(join(dir, 'kpis-2026-01-01.jsonl'), 'x\n');
  await history.append('kpis', { n: 1 });
  assert.ok((await readdir(dir)).includes('kpis-2026-01-01.jsonl'), 'el mismo día no se vuelve a mirar');
  now += 86_400_000;
  await history.append('kpis', { n: 2 });
  assert.ok(!(await readdir(dir)).includes('kpis-2026-01-01.jsonl'), 'al día siguiente sí');
});

test('lee las filas de un día (las que no son JSON se saltan) y dice de qué días hay fichero', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'historial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'kpis-2026-11-10.jsonl'), '{"t":1}\n{"t":2,"cort\n\n{"t":3}\n');
  await writeFile(join(dir, 'kpis-2026-11-09.jsonl'), '{"t":0}\n');
  await writeFile(join(dir, 'alerts-2026-11-10.jsonl'), '{"id":"a"}\n');
  await writeFile(join(dir, 'kpis-notas.txt'), 'x\n');
  const history = createJsonlHistory({ dir: pathToFileURL(`${dir}/`), log: { warn: assert.fail } });
  assert.deepEqual(await history.read('kpis', '2026-11-10'), [{ t: 1 }, { t: 3 }]);
  assert.deepEqual(await history.read('kpis', '2026-11-11'), [], 'sin fichero, nada (y sin avisar)');
  assert.deepEqual(await history.days('kpis'), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(await history.days('alerts'), ['2026-11-10']);
  for (const [stream, day] of [['../kpis', '2026-11-10'], ['kpis', '../../x'], ['kpis', '2026-11-10.jsonl'], ['KPIS', '2026-11-10']]) {
    assert.deepEqual(await history.read(stream, day), [], `${stream} ${day}: nombres raros, nada`);
  }
});
