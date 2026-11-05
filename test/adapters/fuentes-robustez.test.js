import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlText, lookup } from '../../server/adapters/outbound/sources/parse.js';
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

test('htmlText con «<», «<!--» o «<script» sin cerrar a miles: termina y no se come el texto normal', () => {
  // Antes, cada apertura sin cerrar volvía a recorrer el resto del texto (cuadrático): con estos ~200 KB
  // tardaba segundos, y con los MB de un feed, horas. Ahora una etiqueta empieza por «<» + letra, «/», «!» o
  // «?», y un comentario o un script sin cerrar llegan hasta el final, como en un navegador.
  assert.equal(htmlText('<!--'.repeat(50_000)), '');
  assert.equal(htmlText('<script'.repeat(30_000)), '');
  assert.equal(htmlText('<a'.repeat(100_000)), '');
  assert.equal(htmlText(`Aviso${'<'.repeat(200_000)}`), `Aviso${'<'.repeat(200_000)}`);
  // Con HTML normal, lo mismo que antes.
  assert.equal(htmlText('Temperaturas < 0 ºC en cumbres'), 'Temperaturas < 0 ºC en cumbres');
  assert.equal(htmlText('<p>Aviso por <b>lluvias</b> en <a href="https://x.invalid/a">Gran Canaria</a>.</p><p>Segundo</p>'), 'Aviso por lluvias en Gran Canaria .\nSegundo');
  assert.equal(htmlText('<!-- c -->texto<script>var a=1<2;</script> fin'), 'texto fin');
  assert.equal(htmlText('<STYLE>p{}</STYLE><h2>Título</h2><ul><li>uno</li><li>dos</li></ul><BR/>y'), 'Título\nuno\ndos\ny');
  assert.equal(htmlText('<?xml version="1.0"?><!DOCTYPE html>Lluvias &lt;b&gt;fuertes&lt;/b&gt; &amp;oacute;'), 'Lluvias <b>fuertes</b> ó');
});
