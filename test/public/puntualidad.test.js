// La puntualidad en la ficha: el resumen de un servicio («7 de los últimos 10 días en que circuló») o de su
// línea, la tira de días con un signo para cada estado (no sólo el color) y su descripción en texto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noDelayHtml, punctualityHtml, punctualityKeys } from '../../public/js/puntualidad.js';

const day = (n) => new Date(Date.UTC(2026, 10, 10 + n)).toISOString().slice(0, 10); // n = 0: 10 nov
const days = (statuses) => statuses.map((status, i) => ({
  day: day(i - statuses.length + 1), status,
  ...(status === 'tarde' ? { delay: 12, max: 15 } : status === 'a-tiempo' ? { delay: 1, max: 3 } : status === 'en-curso' ? { delay: 6, max: 6 } : {}),
}));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('las claves de una lista follow: la del servicio y la de la línea', () => {
  assert.deepEqual(punctualityKeys(['s-renfe-8058', 'l-renfe-Avant']), { service: 's-renfe-8058', line: 'l-renfe-Avant' });
  assert.deepEqual(punctualityKeys(['l-alsa-710']), { service: null, line: 'l-alsa-710' });
  assert.deepEqual(punctualityKeys(undefined), { service: null, line: null });
});

test('un servicio: «llegó con 5 min o más de retraso 7 de los últimos 10 días en que circuló», cancelaciones y hoy', () => {
  const statuses = [...Array(16).fill('sin-dato'), 'a-tiempo', 'tarde', 'tarde', 'cancelado', 'tarde', 'tarde', 'a-tiempo', 'tarde', 'tarde', 'a-tiempo', 'tarde', 'sin-dato', 'sin-dato', 'en-curso'];
  const html = punctualityHtml({
    kind: 'servicio', days: days(statuses), summary: { ran: 10, late: 7, cancelled: 1 }, recent: { days: 11, late: 7, cancelled: 1 },
    now: { day: day(0), delay: 6, max: 6 }, firstSeen: day(-13), note: 'Retrasos que publica Renfe <b>',
  });
  const t = text(html);
  assert.match(t, /^Puntualidad Hoy va con \+6 min\. Llegó con 5 min o más de retraso 7 de los últimos 10 días en que circuló\. Cancelado 1 día\. El radar lo sigue desde el /);
  assert.equal((html.match(/<li class="pd /g) ?? []).length, 14, 'la tira, de los últimos 14 días');
  assert.match(html, /class="pd pd-cancelado" title="[^"]+: cancelado"><span aria-hidden="true">×<\/span>/, 'cada día con su signo y su descripción');
  assert.match(html, /role="img" aria-label="Últimos 14 días, del más antiguo al de hoy: [^"]*al llegar \+12\smin; máx\. \+15\smin/);
  assert.match(html, /en curso \(ahora \+6\smin\)/);
  // La leyenda, sólo de lo que sale en la tira.
  assert.match(t, /✓ a tiempo \+ 5 min o más de retraso × cancelado … en curso sin dato/);
  assert.match(html, /Retrasos que publica Renfe &lt;b&gt;/, 'escapado');
});

test('un servicio con un solo día, o sin ninguno acabado', () => {
  const one = text(punctualityHtml({ kind: 'servicio', days: days(['a-tiempo', 'sin-dato']), recent: { days: 1, late: 0, cancelled: 0 }, firstSeen: day(-1) }));
  assert.match(one, /El último día en que circuló llegó a tiempo\. El radar lo sigue desde el /);
  const none = text(punctualityHtml({ kind: 'servicio', days: days(['en-curso']), recent: { days: 0, late: 0, cancelled: 0 }, now: { delay: 0 }, firstSeen: day(0) }));
  assert.match(none, /^Puntualidad Hoy va en hora\. El radar lo sigue desde hoy\./);
  assert.equal(punctualityHtml(null), '');
});

test('una línea: hoy y los días anteriores, con el nombre de sus vehículos, y barras con su descripción', () => {
  const lineDays = [
    ...Array(28).fill(null).map((_, i) => ({ day: day(i - 29), samples: 0 })),
    { day: day(-1), samples: 400, late: 40, lateShare: 0.1, vehicles: 30, cancelled: 0 },
    { day: day(0), samples: 200, late: 36, lateShare: 0.18, vehicles: 34, cancelled: 3 },
  ];
  const html = punctualityHtml({ kind: 'linea', mode: 'cercanias', days: lineDays, summary: { samples: 400, late: 40, lateShare: 0.1 }, firstSeen: day(-20) },
    { nounPlural: (m) => (m === 'cercanias' ? 'trenes' : 'vehículos') });
  const t = text(html);
  assert.match(t, /^Puntualidad Su línea\. Hoy, el 18 % de las lecturas con 5 min o más de retraso \(34 trenes con dato\)\. 3 cancelaciones hoy\. Días anteriores: el 10 %\./);
  assert.equal((html.match(/<li class="pb/g) ?? []).length, 14);
  assert.match(html, /<span style="height:90%"><\/span>/, 'la escala llega hasta el 20 %: el 18 % casi la llena');
  assert.match(t, /\(arriba, el 20 %\)/);
  assert.match(html, /title="[^"]+: 18\s% de las lecturas con 5 min o más \(34 trenes\), 3 cancelaciones"/);
  assert.match(html, /class="pb pb-none" title="[^"]+: sin dato"/);
});

test('si su operador no publica el retraso, se dice', () => {
  assert.match(text(noDelayHtml()), /Su operador no publica el retraso/);
});
