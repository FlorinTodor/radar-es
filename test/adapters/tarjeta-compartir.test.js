import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardSvg, textWidth, wrap } from '../../server/adapters/outbound/cards/svg-card.js';
import { findCardFonts, renderCardPng } from '../../server/adapters/outbound/cards/png-card.js';
import { createCardRenderer } from '../../server/adapters/outbound/cards/card-renderer.js';
import { eventShare } from '../../server/domain/compartir.js';

const NOW = Date.UTC(2026, 10, 16, 10, 42);
const event = {
  id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'muy alta', title: 'Accidente · A-7 km 214.0',
  description: 'Málaga, Málaga', lat: 36.72, lon: -4.42, start: NOW - 1800_000,
};
const card = (over = {}) => ({ ...eventShare(event, { now: NOW, credit: 'Fuente: DGT' }), ...over });

test('wrap: no pasa del ancho, corta las palabras que no caben y acaba en «…» sin el punto de antes', () => {
  const lines = wrap('Uno dos tres cuatro cinco seis siete ocho nueve diez once doce.', { size: 30, width: 200, max: 3 });
  assert.equal(lines.length, 3);
  for (const l of lines) assert.ok(textWidth(l, 30) <= 200, l);
  assert.ok(lines[2].endsWith('…'));
  assert.deepEqual(wrap('Hola.', { size: 30, width: 200, max: 1 }), ['Hola.']);
  assert.ok(wrap('x'.repeat(100), { size: 30, width: 200, max: 5 }).every((l) => textWidth(l, 30) <= 200));
  assert.deepEqual(wrap('   ', { size: 30, width: 200, max: 2 }), []);
});

test('la tarjeta lleva el título, la atribución y la web; el texto de las fuentes, escapado', () => {
  const svg = cardSvg(card({ title: 'Corte <script>alert(1)</script> & "más"' }));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
  assert.ok(!svg.includes('<script>'));
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /Fuente: DGT/);
  assert.match(svg, /radarespana\.es/);
  assert.match(svg, /TRÁFICO · GRAVEDAD MUY ALTA/);
});

test('sin emojis ni caracteres de control (la letra no los tiene) y con un color de los nuestros', () => {
  const svg = cardSvg(card({ title: 'Aviso 🚨 urgente\u0007', color: 'red" onload="x' }));
  assert.ok(!svg.includes('🚨'));
  assert.ok(!svg.includes('\u0007'));
  assert.ok(!svg.includes('onload'));
});

test('un sitio en Canarias va en su recuadro; uno fuera de los dos mapas, sin punto', () => {
  const canarias = cardSvg(card({ point: { lon: -15.6, lat: 28.1 } }));
  const fuera = cardSvg(card({ point: { lon: 30, lat: 10 } }));
  const peninsula = cardSvg(card());
  const dots = (svg) => (svg.match(/r="12"/g) ?? []).length;
  assert.equal(dots(peninsula), 1);
  assert.equal(dots(canarias), 1);
  assert.equal(dots(fuera), 0);
});

test('PNG de verdad con la letra del sistema (si no está, no hay tarjetas: se prueba que lo dice)', async (t) => {
  const fonts = findCardFonts();
  const log = { warn: (m) => warned.push(m) };
  const warned = [];
  if (!fonts) {
    const renderer = createCardRenderer({ pool: { run: () => assert.fail('no debe dibujar') }, log, fonts: null });
    assert.equal(renderer.available(), false);
    assert.equal(warned.length, 1);
    await assert.rejects(renderer.render(card()));
    return t.skip('sin DejaVu Sans en este sistema');
  }
  const png = await renderCardPng(cardSvg(card()), fonts);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // Ancho y alto de la cabecera IHDR: 1200×630.
  const view = new DataView(png.buffer, png.byteOffset);
  assert.equal(view.getUint32(16), 1200);
  assert.equal(view.getUint32(20), 630);
});

test('el dibujante manda el SVG y la letra al hilo de cálculo, con la tarea «card»', async () => {
  const calls = [];
  const renderer = createCardRenderer({ pool: { run: async (task, args) => { calls.push([task, args]); return new Uint8Array([1]); } }, log: { warn() {} }, fonts: ['/a.ttf'] });
  assert.equal(renderer.available(), true);
  assert.deepEqual(await renderer.render(card()), new Uint8Array([1]));
  assert.equal(calls[0][0], 'card');
  assert.match(calls[0][1][0], /^<svg/);
  assert.deepEqual(calls[0][1][1], ['/a.ttf']);
});
