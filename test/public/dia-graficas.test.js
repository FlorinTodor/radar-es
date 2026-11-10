// Gráficas del día en cifras (texto SVG/HTML, sin DOM): escalas redondas, líneas con huecos donde no hay
// datos, columnas de como mucho 24 px, nombres escapados y la hora bajo el puntero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnChart, dayShort, dayTitle, fmt, hbars, hourAt, lineChart, medianText, niceScale } from '../../public/js/dia-graficas.js';

test('escala redonda del eje: de 3 a 5 marcas desde cero', () => {
  assert.deepEqual(niceScale(87), { max: 100, ticks: [0, 25, 50, 75, 100] });
  assert.deepEqual(niceScale(3.2), { max: 4, ticks: [0, 1, 2, 3, 4] });
  assert.deepEqual(niceScale(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(niceScale(712).ticks, [0, 200, 400, 600, 800]);
});

test('línea por horas: un trazo por racha (sin unir los huecos), la referencia aparte y el valor al final', () => {
  const today = [1, 2, null, 4, 5, ...Array(19).fill(null)];
  const svg = lineChart({ width: 300, height: 140, today, compare: Array(24).fill(3), label: 'Metro <b>' });
  const d = svg.match(/class="line-today" d="([^"]+)"/)[1];
  assert.equal((d.match(/M/g) ?? []).length, 2, 'dos rachas: 0–1 y 3–4');
  assert.match(svg, /class="line-compare"/);
  assert.match(svg, /<text class="end"[^>]*>5<\/text>/, 'el último valor de hoy, al final de la línea');
  assert.match(svg, /aria-label="Metro &lt;b&gt;"/, 'el nombre, escapado');
  assert.doesNotMatch(lineChart({ width: 300, height: 140, today, label: 'x' }), /line-compare/);
});

test('columnas por horas: una por valor, de como mucho 24 px, y sin las vacías', () => {
  const values = [10, null, 0, 40, ...Array(20).fill(null)];
  const svg = columnChart({ width: 1200, height: 160, values, label: 'retraso', unit: ' %' });
  const cols = [...svg.matchAll(/class="col" data-i="(\d+)" d="M([\d.]+) [\d.]+V[\d.]+Q[\d.]+ [\d.]+ [\d.]+ [\d.]+H[\d.]+Q([\d.]+)/g)];
  assert.deepEqual(cols.map((c) => Number(c[1])), [0, 3]);
  for (const c of cols) assert.ok(Number(c[3]) - Number(c[2]) <= 24.01, 'como mucho 24 px de ancho');
  assert.match(svg, />40 %<\/text>/, 'el eje redondo, con su unidad');
});

test('barras horizontales: de mayor a menor como vienen, con el valor al final y los nombres escapados', () => {
  const html = hbars([{ label: 'Línea <C5>', value: 69, sub: 'desde Móstoles' }, { label: 'AVE', value: 32 }]);
  assert.match(html, /Línea &lt;C5&gt;/);
  assert.match(html, /width:100\.0%/);
  assert.match(html, /width:46\.4%/);
  assert.match(html, /<span class="hb-val">69<\/span>/);
});

test('la hora bajo el puntero, dentro de 0–23; fechas, números y la mediana en palabras', () => {
  assert.equal(hourAt(0, 30, 260), 0);
  assert.equal(hourAt(145, 30, 260), 12);
  assert.equal(hourAt(9999, 30, 260), 23);
  assert.equal(dayTitle('2026-11-10'), 'martes, 10 de noviembre de 2026');
  assert.equal(dayShort('2026-11-03'), 'mar, 3 nov');
  assert.equal(fmt(1284.5), '1284,5');
  assert.equal(fmt(null), '–');
  assert.equal(medianText({ minutes: 2 }), '2 min');
  assert.equal(medianText({ from: 15, to: 29 }), 'de 15 a 29 min');
  assert.equal(medianText({ from: 60, to: null }), '60 min o más');
  assert.equal(medianText(null), '–');
});
