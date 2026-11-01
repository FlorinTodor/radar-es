import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createBudget, createHttpServer, createJsonMemo } from '../../server/adapters/inbound/http/http-server.js';

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
const calls = { lines: 0, trails: [], vehicles: [], events: [] };
before(async () => {
  const query = {
    lines: () => { calls.lines++; return { type: 'FeatureCollection', features: Array.from({ length: 50 }, (_, i) => ({ id: i })) }; },
    trails: (min) => { calls.trails.push(min); return { type: 'FeatureCollection', features: [] }; },
    vehicles: (filter) => { calls.vehicles.push(filter); return []; },
    events: (filter) => { calls.events.push(filter.category); return []; },
  };
  server = createHttpServer({
    query, log: { error() {}, info() {}, warn() {} },
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

test('/api/vehicles acota sus filtros: los valores raros comparten variante', async () => {
  for (const q of ['minDelay=1.2', 'minDelay=1.4', 'minDelay=abc', 'minDelay=-50', 'minDelay=99999', 'mode=BUS!', 'mode=%00x', 'mode=bus']) {
    assert.equal((await fetch(`${base}/api/vehicles?${q}`)).status, 200, q);
  }
  assert.deepEqual(calls.vehicles, [
    { mode: undefined, source: undefined, minDelay: 1 }, // 1.2 y 1.4 → la misma variante
    { mode: undefined, source: undefined, minDelay: undefined }, // abc → sin filtro
    { mode: undefined, source: undefined, minDelay: -1 },
    { mode: undefined, source: undefined, minDelay: 1440 },
    { mode: '-', source: undefined, minDelay: undefined }, // BUS! y %00x → «-», que no coincide con nada
    { mode: 'bus', source: undefined, minDelay: undefined },
  ]);
});

test('el presupuesto de cálculos deja ráfagas y luego `perSecond` de media', () => {
  let t = 0;
  const budget = createBudget({ perSecond: 2, burst: 3, now: () => t });
  assert.deepEqual([1, 2, 3, 4].map(() => budget.take()), [true, true, true, false]);
  t = 499;
  assert.equal(budget.take(), false, 'aún no ha vuelto una ficha entera');
  t = 500;
  assert.equal(budget.take(), true);
  t = 60_000;
  assert.deepEqual([1, 2, 3, 4].map(() => budget.take()), [true, true, true, false], 'nunca más de `burst` guardadas');
});

test('pedir muchas variantes distintas a la vez da 503 en vez de calcularlas todas', async () => {
  const statuses = [];
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${base}/api/events?category=c${i}`);
    statuses.push(res.status);
    if (res.status === 503) {
      assert.equal(res.headers.get('retry-after'), '2');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  }
  assert.ok(calls.events.length <= 11, `calculadas ${calls.events.length}`);
  assert.ok(statuses.includes(503));
  assert.equal((await fetch(`${base}/api/events?category=c0`)).status, 200, 'una variante ya calculada se sirve igual');
});
