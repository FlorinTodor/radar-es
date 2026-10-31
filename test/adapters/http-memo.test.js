import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer, createJsonMemo } from '../../server/adapters/inbound/http/http-server.js';

test('el memo calcula una vez por ttl y vuelve a calcular al caducar', () => {
  let t = 0;
  let calls = 0;
  const memo = createJsonMemo({ now: () => t });
  const compute = () => ({ n: ++calls });
  const a = memo('k', 1000, compute);
  assert.equal(memo('k', 1000, compute), a);
  t = 999;
  assert.equal(memo('k', 1000, compute), a);
  t = 1000;
  assert.notEqual(memo('k', 1000, compute), a);
  assert.equal(calls, 2);
});

test('con stableEtag la firma no cambia si sólo cambia generatedAt', () => {
  let t = 0;
  const memo = createJsonMemo({ now: () => t });
  const body = (data) => () => ({ generatedAt: t, events: data });
  const a = memo('ev', 10, body([1, 2]), { stableEtag: true });
  t = 20;
  const b = memo('ev', 10, body([1, 2]), { stableEtag: true });
  assert.equal(a.etag, b.etag, 'mismos datos → misma firma');
  assert.notDeepEqual(a.json, b.json, 'el cuerpo sí lleva el generatedAt nuevo');
  t = 40;
  assert.notEqual(memo('ev', 10, body([1, 2, 3]), { stableEtag: true }).etag, a.etag, 'datos nuevos → firma nueva');
  t = 60;
  const c = memo('live', 10, body([1, 2]));
  t = 80;
  assert.notEqual(memo('live', 10, body([1, 2])).etag, c.etag, 'sin stableEtag la firma cuenta generatedAt');
});

test('el memo guarda como mucho `max` variantes y descarta la más antigua', () => {
  let calls = 0;
  const memo = createJsonMemo({ max: 2, now: () => 0 });
  const compute = () => ({ n: ++calls });
  memo('a', 1000, compute);
  memo('b', 1000, compute);
  memo('c', 1000, compute); // expulsa a «a»
  memo('b', 1000, compute);
  assert.equal(calls, 3, '«b» sigue en memoria');
  memo('a', 1000, compute);
  assert.equal(calls, 4, '«a» se había descartado');
});

let server;
let base;
const calls = { lines: 0, trails: [] };
before(async () => {
  const query = {
    lines: () => { calls.lines++; return { type: 'FeatureCollection', features: Array.from({ length: 50 }, (_, i) => ({ id: i })) }; },
    trails: (min) => { calls.trails.push(min); return { type: 'FeatureCollection', features: [] }; },
  };
  server = createHttpServer({
    query, bus: { subscribe: () => () => {} }, log: { error() {}, info() {}, warn() {} },
    publicDir: '/nonexistent', vendorDirs: {}, about: {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('/api/lines se calcula una sola vez aunque lo pidan muchos, con caché pública y 304', async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/api/lines`)));
  assert.equal(calls.lines, 1);
  const res = responses[0];
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public, max-age=600/);
  assert.equal((await res.json()).features.length, 50);
  const again = await fetch(`${base}/api/lines`, { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('/api/trails acota los minutos y no crea una variante por cada valor raro', async () => {
  for (const min of ['15', 'abc', '-3', '9999', '15.4']) await fetch(`${base}/api/trails?min=${min}`);
  assert.deepEqual(calls.trails, [15, 1, 45], '15, abc→15 (misma variante), -3→1, 9999→45, 15.4→15 (misma variante)');
});
