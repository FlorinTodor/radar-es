// Gráficas del día en cifras (texto SVG/HTML, sin DOM): escalas redondas, líneas con huecos donde no hay
// datos, columnas de como mucho 24 px, nombres escapados y la hora bajo el puntero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnChart, dayShort, dayTitle, fmt, hbars, hourAt, hourLabel, lineChart, medianPhrase, niceScale } from '../../public/js/dia-graficas.js';

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

test('la hora bajo el puntero, dentro de 0–23; fechas, números y la mediana en una frase', () => {
  assert.equal(hourAt(0, 30, 260), 0);
  assert.equal(hourAt(145, 30, 260), 12);
  assert.equal(hourAt(9999, 30, 260), 23);
  assert.equal(dayTitle('2026-11-10'), 'martes, 10 de noviembre de 2026');
  assert.equal(dayShort('2026-11-03'), 'mar, 3 nov');
  assert.equal(fmt(1284.5), '1284,5');
  assert.equal(fmt(null), '–');
  // La mediana como frase que se pueda leer, también cuando cae en un tramo.
  assert.equal(medianPhrase({ minutes: 2 }), 'la mitad, 2 min o menos');
  assert.equal(medianPhrase({ from: 30, to: 59 }), 'retraso mediano: entre 30 y 59 min');
  assert.equal(medianPhrase({ from: 60, to: null }), 'retraso mediano: 60 min o más');
  assert.equal(medianPhrase(null), null);
});

test('en inglés: fechas, números, horas y la mediana del idioma; los tipos de vehículo del servidor, traducidos', async () => {
  const { useLang, t } = await import('../../public/js/i18n.js');
  const { EN } = await import('../../public/js/i18n/en.js');
  const { MODES } = await import('../../server/domain/modos.js');
  await useLang('en');
  try {
    assert.equal(dayTitle('2026-11-10'), 'Tuesday, 10 November 2026');
    assert.equal(dayShort('2026-11-03'), 'Tue 3 Nov');
    assert.equal(fmt(1284.5), '1,284.5');
    assert.equal(hourLabel(7), '7:00');
    assert.equal(medianPhrase({ minutes: 2 }), 'half of them 2 min or less');
    assert.equal(medianPhrase({ from: 30, to: 59 }), 'median delay: between 30 and 59 min');
    // dia.js pinta el nombre y el sustantivo de cada tipo tal como llegan del servidor (t(m.label), t(m.noun)).
    for (const m of MODES) for (const word of [m.label, m.noun, m.nounPlural]) assert.ok(word in EN, `«${word}» en el diccionario`);
    assert.equal(t('Máximo a la vez: {n} {noun}', { n: 3, noun: t('autobuses') }), 'Most at once: 3 buses');
  } finally {
    await useLang('es');
  }
  assert.equal(dayTitle('2026-11-10'), 'martes, 10 de noviembre de 2026', 'y de vuelta en español');
  assert.equal(hourLabel(7), '7 h');
});
