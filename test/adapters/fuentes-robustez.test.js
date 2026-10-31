import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup } from '../../server/adapters/outbound/sources/parse.js';
import { createInMemorySituation } from '../../server/adapters/outbound/persistence/in-memory-situation.js';

test('lookup no devuelve propiedades heredadas aunque la fuente mande «__proto__» o «constructor»', () => {
  const SEVERITY = { high: 'alta' };
  assert.equal(lookup(SEVERITY, 'high'), 'alta');
  assert.equal(lookup(SEVERITY, '__proto__'), undefined);
  assert.equal(lookup(SEVERITY, 'constructor'), undefined);
  assert.equal(lookup(SEVERITY, 'toString'), undefined);
  assert.equal(lookup(SEVERITY, undefined), undefined);
  assert.equal(lookup(SEVERITY, null), undefined);
});

test('el estado público de las fuentes no enseña rutas del servidor ni claves de la URL', () => {
  const situation = createInMemorySituation();
  situation.registerSource({ id: 'a', name: 'A', kind: 'events', interval: 1000, url: 'https://x.example/datos?api_key=SECRETO' }, { enabled: true });
  situation.registerSource({ id: 'b', name: 'B', kind: 'events', interval: 1000, url: 'https://x.example/b.json', page: 'https://datos.example/ficha' }, { enabled: true });
  situation.saveFailure('a', new Error("EACCES: permission denied, open '/app/data/cache/a.zip'"), 1);
  situation.saveFailure('b', new Error('HTTP 500 en https://x.example/app/b.json'), 1);
  const [a, b] = situation.health();
  assert.equal(a.error, "EACCES: permission denied, open '[ruta interna]'");
  assert.doesNotMatch(a.url, /SECRETO/);
  assert.equal(b.error, 'HTTP 500 en https://x.example/app/b.json', 'las URL no se tocan');
  assert.equal(b.url, 'https://datos.example/ficha', 'se enlaza la ficha pública del conjunto si la hay');
});
