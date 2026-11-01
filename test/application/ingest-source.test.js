import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';

const T0 = Date.UTC(2026, 0, 18, 18, 0);

function setup(fetch) {
  const saved = [];
  const failures = [];
  const published = [];
  const situation = {
    saveResult: (id, result, at) => saved.push({ id, result, at }),
    saveFailure: (id, err, at) => failures.push({ id, message: err.message, at }),
    tracks: () => new Map(),
  };
  const ingest = makeIngestSource({
    sources: [{ id: 'renfe', fetch }],
    situation,
    publisher: { publish: (topic, payload) => published.push([topic, payload]) },
    clock: { now: () => T0 },
    log: { warn() {} },
  });
  return { ingest, saved, failures, published };
}

test('lee la fuente por su id, guarda el resultado y avisa', async () => {
  const { ingest, saved, published } = setup(async () => ({ events: [{ id: 'e', url: 'javascript:alert(1)' }] }));
  assert.equal(await ingest('renfe'), true);
  assert.equal(saved[0].id, 'renfe');
  assert.equal(saved[0].at, T0);
  assert.equal(saved[0].result.events[0].url, null, 'los enlaces que no son http(s) se descartan');
  assert.deepEqual(published, [['source.updated', { id: 'renfe' }]]);
});

test('si la fuente falla guarda el error, avisa y devuelve false', async () => {
  const { ingest, failures, published } = setup(async () => { throw new Error('HTTP 503'); });
  assert.equal(await ingest('renfe'), false);
  assert.deepEqual(failures, [{ id: 'renfe', message: 'HTTP 503', at: T0 }]);
  assert.deepEqual(published, [['source.failed', { id: 'renfe' }]]);
});

test('una fuente que no está activa es un error de composición', async () => {
  const { ingest } = setup(async () => ({}));
  await assert.rejects(ingest('dgt'), /Fuente desconocida o desactivada: dgt/);
});
