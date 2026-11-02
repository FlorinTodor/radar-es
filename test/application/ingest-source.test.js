import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';

const T0 = Date.UTC(2026, 0, 18, 18, 0);

function setup(fetch) {
  const saved = [];
  const failures = [];
  const situation = {
    saveResult: (id, result, at) => saved.push({ id, result, at }),
    saveFailure: (id, err, at) => failures.push({ id, message: err.message, at }),
    updateTracks: (update) => update(new Map()),
  };
  const ingest = makeIngestSource({
    sources: [{ id: 'renfe', fetch }],
    situation,
    clock: { now: () => T0 },
    log: { warn() {} },
  });
  return { ingest, saved, failures };
}

test('lee la fuente por su id y guarda el resultado', async () => {
  const { ingest, saved } = setup(async () => ({ events: [{ id: 'e', url: 'javascript:alert(1)' }] }));
  assert.equal(await ingest('renfe'), true);
  assert.equal(saved[0].id, 'renfe');
  assert.equal(saved[0].at, T0);
  assert.equal(saved[0].result.events[0].url, null, 'los enlaces que no son http(s) se descartan');
});

test('si la fuente falla guarda el error y devuelve false', async () => {
  const { ingest, failures } = setup(async () => { throw new Error('HTTP 503'); });
  assert.equal(await ingest('renfe'), false);
  assert.deepEqual(failures, [{ id: 'renfe', message: 'HTTP 503', at: T0 }]);
});

test('una fuente que no está activa es un error de composición', async () => {
  const { ingest } = setup(async () => ({}));
  await assert.rejects(ingest('dgt'), /Fuente desconocida o desactivada: dgt/);
});
