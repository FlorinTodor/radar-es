// /api/tracks/<id> y /api/ahead/<id> pueden costar un cálculo por la vía o por las paradas: cada
// vehículo se calcula como mucho una vez cada pocos segundos (memo), los cálculos tienen un presupuesto
// (503 con Retry-After si se gasta) y los ids inventados no lo gastan. Reloj simulado: nada depende de
// lo rápida que sea la máquina.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

let server;
let base;
let clock = 1_000_000;
const calls = new Map();
before(async () => {
  const count = (id) => calls.set(id, (calls.get(id) ?? 0) + 1);
  const query = {
    track: (id) => { count(`track:${id}`); return id.startsWith('tren-') ? [{ lon: -3.7, lat: 40, t: 1 }] : null; },
    ahead: (id) => { count(`ahead:${id}`); return id.startsWith('tren-') ? [[-3.7, 40], [-3.6, 40]] : null; },
  };
  server = createHttpServer({ query, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, now: () => clock });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('el mismo vehículo pedido otra vez enseguida sale del memo; pasado un rato se recalcula', async () => {
  const first = await fetch(`${base}/api/tracks/tren-1`);
  assert.equal(first.status, 200);
  assert.match(first.headers.get('cache-control'), /^public, .*s-maxage=\d+/);
  const etag = first.headers.get('etag');
  await fetch(`${base}/api/tracks/tren-1`);
  const unchanged = await fetch(`${base}/api/tracks/tren-1`, { headers: { 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal(calls.get('track:tren-1'), 1);
  clock += 60_000;
  await fetch(`${base}/api/tracks/tren-1`);
  assert.equal(calls.get('track:tren-1'), 2);
});

test('ids inventados: 404 y no gastan el presupuesto', async () => {
  clock += 3_600_000; // presupuesto lleno
  for (let i = 0; i < 200; i++) assert.equal((await fetch(`${base}/api/tracks/inventado-${i}`)).status, 404);
  assert.equal((await fetch(`${base}/api/ahead/tren-otro`)).status, 200, 'queda presupuesto para los de verdad');
});

test('muchos vehículos distintos a la vez: al gastar el presupuesto, 503 con Retry-After; luego se recupera', async () => {
  clock += 3_600_000;
  const statuses = [];
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/ahead/tren-${i}`);
    statuses.push(res.status);
    if (res.status === 503) {
      assert.ok(Number(res.headers.get('retry-after')) > 0);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  }
  assert.ok(statuses.includes(200) && statuses.includes(503), `hay de los dos: ${statuses.join(',')}`);
  // Los que ya se calcularon siguen saliendo del memo aunque no quede presupuesto.
  assert.equal((await fetch(`${base}/api/ahead/tren-0`)).status, 200);
  clock += 60_000;
  assert.equal((await fetch(`${base}/api/ahead/tren-99`)).status, 200, 'con el tiempo vuelve a haber presupuesto');
});

test('un id más largo que cualquier vehículo es una ruta inválida (no llena el memo con claves enormes)', async () => {
  const largo = `tren-${'x'.repeat(300)}`;
  for (const kind of ['tracks', 'ahead']) {
    const res = await fetch(`${base}/api/${kind}/${largo}`);
    assert.equal(res.status, 400);
    assert.equal(calls.get(`${kind === 'tracks' ? 'track' : 'ahead'}:${largo}`), undefined, 'ni se consulta');
  }
  // Los ids reales más largos (trip_id de algunos operadores, unos 80 caracteres) siguen valiendo.
  const real = 'tren-bus-grupo-ruiz:3:1_8__350_C__-8__350_C___3_11:30:00_1_sdf__1_8__350_C__:20261102';
  clock += 3_600_000;
  assert.equal((await fetch(`${base}/api/tracks/${encodeURIComponent(real)}`)).status, 200);
});
