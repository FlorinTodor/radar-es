// El recorrido de un tren de Larga Distancia se pega a la vía de la red general: sigue sus curvas
// aunque falten posiciones durante kilómetros, pasa de un tramo a otro por las bifurcaciones (también
// las que caen en mitad de un tramo), no da rodeos imposibles y deja tal cual lo que está lejos de la vía.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRailNetwork, matchToRail, meters, nearestOnRail } from '../../server/domain/rail-match.js';

const KX = 111_320 * Math.cos((40 * Math.PI) / 180);
const KY = 110_540;
/** Punto a `east` y `north` metros de otro ([lon, lat]). */
const at = ([lon, lat], east, north) => [lon + east / KX, lat + north / KY];
/** Arco de circunferencia (ángulos en grados desde el este, en sentido antihorario). */
const arc = (center, r, fromDeg, toDeg, n = 30) => Array.from({ length: n + 1 }, (_, i) => {
  const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
  return at(center, r * Math.cos(a), r * Math.sin(a));
});
const pos = ([lon, lat], t = 0) => ({ lon, lat, t });
const length = (line) => line.slice(1).reduce((s, p, i) => s + meters(line[i][0], line[i][1], p[0], p[1]), 0);
/** Distancia máxima de una línea (densificada cada 10 m) a la red. */
function maxOff(net, line) {
  let max = 0;
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const n = Math.max(1, Math.ceil(meters(a[0], a[1], b[0], b[1]) / 10));
    for (let k = 0; k <= n; k++) {
      const site = nearestOnRail(net, a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, 5000);
      max = Math.max(max, site ? site.d : Infinity);
    }
  }
  return max;
}

// Red sintética cerca de Madrid. J: bifurcación.
//  - T1: de A a J en curva (cuarto de circunferencia de 5 km de radio), llegando a J hacia el este.
//  - T2: de J 10 km recto hacia el este, en un solo trozo.
//  - T3: ramal desde J que gira hacia el norte (4 km de radio); empieza a 9 m de J, como en los datos reales.
//  - T4: ramal hacia el sur que sale de la mitad de T2 (a 5 km de J), donde T2 no está cortado.
const J = [-3.0, 40.0];
const C1 = at(J, 0, -5000);
const C3 = at(J, 0, 4000);
const T1 = [...arc(C1, 5000, 180, 90).slice(0, -1), J];
const T2 = [J, at(J, 10_000, 0)];
const T3 = [at(J, 8, 5), ...arc(C3, 4000, 270, 360).slice(1)];
const T4 = [at(J, 5000, 2), at(J, 5000, -3000)];
const net = buildRailNetwork([T1, T2, T3, T4]);

test('la red: los extremos cercanos son un nudo y el tramo con un ramal en medio se parte', () => {
  assert.equal(net.edges, 5, 'T2 queda partido en dos por T4');
  assert.equal(net.nodes, 6, 'A, J (con el inicio de T3 a 9 m), B, final de T3, cruce de T4 y final de T4');
  assert.ok(net.bytes > 0);
});

test('con un hueco de kilómetros sigue la curva y pasa de un tramo a otro por la bifurcación', () => {
  const p1 = at(C1, 5000 * Math.cos((170 * Math.PI) / 180), 5000 * Math.sin((170 * Math.PI) / 180) + 2); // T1, a 2 m de la vía
  const p2 = at(C3, 4000 * Math.cos((300 * Math.PI) / 180), 4000 * Math.sin((300 * Math.PI) / 180)); // T3
  assert.ok(maxOff(net, [p1, p2]) > 500, 'la recta se sale de la vía (comprobación de la prueba)');
  const parts = matchToRail(net, [pos(p1), pos(p2, 600_000)]);
  assert.equal(parts.length, 1);
  const [line] = parts;
  assert.ok(maxOff(net, line) < 12, 'todo el dibujo va por la vía (salvo el salto de 9 m en la bifurcación)');
  const expected = ((80 * Math.PI) / 180) * 5000 + ((30 * Math.PI) / 180) * 4000; // arco de T1 + arco de T3
  assert.ok(Math.abs(length(line) - expected) < 30, `longitud ${length(line).toFixed(0)} ≈ ${expected.toFixed(0)} m`);
  assert.ok(line.some(([lon, lat]) => meters(lon, lat, J[0], J[1]) < 1), 'pasa por J');
});

test('pasa a un ramal que sale de la mitad de un tramo', () => {
  const p1 = at(J, 2000, 1);
  const p2 = at(J, 5000, -1000); // en T4
  const [line] = matchToRail(net, [pos(p1), pos(p2, 300_000)]);
  assert.ok(Math.abs(length(line) - 4000) < 20, `3 km por T2 y 1 km por T4, no la recta de 3,2 km (${length(line).toFixed(0)} m)`);
  assert.ok(line.some(([lon, lat]) => meters(lon, lat, ...at(J, 5000, 0)) < 5), 'por el cruce');
});

test('en el mismo tramo dibuja el trozo de vía entre las dos posiciones, con sus vértices', () => {
  const a = arc(C1, 5000, 170, 110, 1);
  const [line] = matchToRail(net, [pos(a[0]), pos(a[1], 300_000)]);
  assert.ok(line.length > 3, 'con los vértices de la curva');
  assert.ok(maxOff(net, line) < 1);
  assert.ok(Math.abs(length(line) - ((60 * Math.PI) / 180) * 5000) < 20);
});

test('no da un rodeo mucho más largo que la recta: se queda con la recta', () => {
  // U: dos brazos de 10 km a 2 km uno del otro, unidos sólo por abajo.
  const O = [-4.0, 41.0];
  const u = buildRailNetwork([[O, at(O, 0, -10_000), at(O, 2000, -10_000), at(O, 2000, 0)]]);
  const arriba = [at(O, 0, -500), at(O, 2000, -500)];
  const [recta] = matchToRail(u, arriba.map((p, i) => pos(p, i)));
  assert.equal(recta.length, 2, '21 km por la vía para 2 km de recta: es otra vía o un dato malo');
  const abajo = [at(O, 0, -9800), at(O, 2000, -9800)];
  const [curva] = matchToRail(u, abajo.map((p, i) => pos(p, i)));
  assert.equal(curva.length, 4, 'abajo el rodeo es corto (2,4 km) y sigue la vía por las esquinas');
});

test('una posición lejos de la vía se queda donde está', () => {
  const lejos = at(J, 7000, 600);
  const [line] = matchToRail(net, [pos(at(J, 6000, 1)), pos(lejos, 1), pos(at(J, 8000, -1), 2)]);
  assert.ok(line.some(([lon, lat]) => lon === lejos[0] && lat === lejos[1]));
  assert.ok(Math.abs(line[0][1] - J[1]) < 1e-9, 'las de la vía sí van a la vía');
});

test('más de 30 km sin datos: el recorrido se parte, como en el mapa', () => {
  const parts = matchToRail(net, [pos(at(J, 1000, 0)), pos(at(J, 1000, 40_000), 1)]);
  assert.equal(parts.length, 2);
});

test('sin red, las posiciones tal cual; parado, sin puntos repetidos', () => {
  const p = at(J, 1000, 3);
  assert.deepEqual(matchToRail(null, [pos(p), pos(p, 1)]), [[p]]);
  assert.equal(matchToRail(net, [pos(p), pos(p, 1)])[0].length, 1);
});
