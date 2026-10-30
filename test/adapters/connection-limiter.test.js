import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionLimiter } from '../../server/adapters/inbound/http/connection-limiter.js';

test('limita las conexiones abiertas por IP y las libera al cerrar', () => {
  const lim = createConnectionLimiter({ maxPerIp: 2, now: () => 0 });
  const a = lim.acquire('1.1.1.1');
  const b = lim.acquire('1.1.1.1');
  assert.ok(a && b);
  assert.equal(lim.acquire('1.1.1.1'), null);
  assert.ok(lim.acquire('2.2.2.2'), 'otra IP no se ve afectada');
  a();
  a(); // liberar dos veces no descuenta dos
  assert.equal(lim.total, 2);
  assert.ok(lim.acquire('1.1.1.1'));
});

test('limita el total de conexiones', () => {
  const lim = createConnectionLimiter({ maxTotal: 3, now: () => 0 });
  for (const ip of ['a', 'b', 'c']) assert.ok(lim.acquire(ip));
  assert.equal(lim.acquire('d'), null);
});

test('limita las conexiones nuevas por IP y minuto, aunque se cierren', () => {
  let t = 0;
  const lim = createConnectionLimiter({ maxNewPerIpPerMinute: 3, now: () => t });
  for (let i = 0; i < 3; i++) lim.acquire('1.1.1.1')();
  assert.equal(lim.acquire('1.1.1.1'), null, 'abrir y cerrar sin parar también cuenta');
  t = 61_000;
  assert.ok(lim.acquire('1.1.1.1'), 'pasado el minuto vuelve a dejar');
});
