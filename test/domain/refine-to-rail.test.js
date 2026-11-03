// Los trazados que un operador publica casi sólo con sus estaciones cortan las curvas en recta y se salen
// de la vía: con la red de vías detallada se rehacen por ella. Lo que va bien, o lo que es del operador
// (un trazado detallado por donde la red no tiene vía), se queda como estaba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRailNetwork, meters, nearestOnRail, refineToRail } from '../../server/domain/rail-match.js';

const KX = 111_320 * Math.cos((37.4 * Math.PI) / 180);
const KY = 110_540;
const at = ([lon, lat], east, north) => [lon + east / KX, lat + north / KY];
const arc = (center, r, fromDeg, toDeg, n = 40) => Array.from({ length: n + 1 }, (_, i) => {
  const a = ((fromDeg + ((toDeg - fromDeg) * i) / n) * Math.PI) / 180;
  return at(center, r * Math.cos(a), r * Math.sin(a));
});
/** Distancia máxima de una línea (cada 10 m) a la red. */
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

// Una línea de metro que hace una curva de 90° de 2 km de radio, como la L1 de Sevilla en el Aljarafe,
// y sigue recta 3 km hacia el norte.
const O = [-6.04, 37.35];
const CURVE = arc(O, 2000, 0, 90);
const STRAIGHT = [CURVE.at(-1), at(O, 0, 5000)];
const net = buildRailNetwork([CURVE, STRAIGHT]);

test('un trazado con sólo las estaciones se rehace por la vía, curva incluida', () => {
  // Tres estaciones: al principio de la curva, al final (a 15 m de la vía, como suelen caer) y al final de la recta.
  const coarse = [CURVE[0], at(CURVE.at(-1), 12, 9), STRAIGHT[1]];
  assert.ok(maxOff(net, coarse) > 500, 'la recta entre estaciones se sale ~585 m');
  const refined = refineToRail(net, coarse);
  assert.ok(maxOff(net, refined) < 15, 'rehecho, todo por la vía (lo que ya iba bien, a los ~12 m de la estación, se queda)');
  assert.ok(meters(...refined[0], ...CURVE[0]) < 5 && meters(...refined.at(-1), ...STRAIGHT[1]) < 5, 'empieza y acaba donde el trazado');
});

test('lo que ya va por la vía no se toca', () => {
  const good = [...CURVE.slice(0, -1), ...STRAIGHT];
  assert.equal(refineToRail(net, good), good);
  assert.equal(refineToRail(null, good), good, 'sin red, tal cual');
  const single = [CURVE[0]];
  assert.equal(refineToRail(net, single), single, 'un solo punto, tal cual');
});

test('un trazado detallado por donde la red no tiene vía es del operador y se respeta', () => {
  // Una variante nueva: 300 m al oeste de la recta, con un punto cada 50 m.
  const variant = Array.from({ length: 61 }, (_, i) => at(O, -300 + (i === 0 || i === 60 ? 300 : 0), 2000 + i * 50));
  assert.equal(refineToRail(net, variant), variant);
});

test('un tramo cuyos extremos no están junto a una vía, o que por la vía da un rodeo, se queda como venía', () => {
  const lejos = [at(O, 500, 0), at(O, 500, 1500)]; // a 1,5 km de la curva y sin vía cerca de los extremos
  assert.equal(refineToRail(net, lejos), lejos);
  // Del principio de la curva al final de la recta en línea recta (5,4 km) por la vía son 8,1 km: más de 1,6 veces + 400 m no,
  // pero un atajo de 2,9 km entre dos puntos de la curva que por la vía están a 3,1 km sí se rehace.
  const rodeo = buildRailNetwork([arc(O, 2000, 0, 300, 120)]); // casi una vuelta entera
  const atajo = [arc(O, 2000, 0, 300, 120)[0], arc(O, 2000, 0, 300, 120).at(-1)]; // 2 km en recta, 10,5 km por la vía
  assert.equal(refineToRail(rodeo, atajo), atajo);
});
