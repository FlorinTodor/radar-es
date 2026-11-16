// Trazado de un viaje hecho de tramos de parada a parada (la carretera de CartoCiudad): cada parada, exacta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeFromLegs } from '../../server/domain/trazado-por-tramos.js';
import { pointAlong } from '../../server/domain/schedule.js';

const near = (p, [lon, lat], m = 0.5) => Math.hypot((p.lon - lon) * 89_000, (p.lat - lat) * 111_000) < m;

test('cada parada está donde empieza su tramo, aunque la ruta vuelva por la misma calle', () => {
  // Alfa → Beta (1,8 km al este); de Beta, 450 m más allá, vuelta por la misma calle y hasta Gamma, entre las dos.
  const legs = [
    [-6.0, 37.0, -5.99, 37.0, -5.98, 37.0],
    [-5.98, 37.0, -5.975, 37.0, -5.98, 37.0, -5.99, 37.0],
  ];
  const { shape, along } = shapeFromLegs(legs);
  assert.equal(along.length, 3);
  assert.equal(along[0], 0);
  assert.ok(Math.abs(along[1] - 1778) < 5, `Beta, al final de la ida (${along[1]})`);
  assert.ok(Math.abs(along[2] - (along[1] + 445 * 2 + 890)) < 10, `Gamma, tras la vuelta (${along[2]})`);
  assert.ok(near(pointAlong(shape, along[1]), [-5.98, 37.0]));
  assert.ok(near(pointAlong(shape, along[2]), [-5.99, 37.0]));
});

test('quita los puntos de paso a menos de 10 m, nunca una parada; dos paradas en el mismo punto, un solo punto', () => {
  const legs = [
    [0, 40, 0.00005, 40, 0.01, 40], // un punto de paso a 4 m de la primera parada: fuera
    [0.01, 40, 0.01004, 40], // la siguiente parada, a 3,4 m: se queda
    [0.01004, 40, 0.01004, 40], // otra parada en el mismo sitio
    [0.01004, 40, 0.02, 40],
  ];
  const { shape, along } = shapeFromLegs(legs);
  assert.equal(shape.dist.length, 4, 'las cuatro paradas distintas, sin el punto de paso');
  assert.equal(along[2], along[3], 'las dos del mismo sitio, a la misma distancia');
  for (let i = 1; i < along.length; i++) assert.ok(along[i] >= along[i - 1]);
  assert.ok(near(pointAlong(shape, along[2]), [0.01004, 40]));
});

test('un punto de paso pegado a una parada le cede su sitio', () => {
  const { shape, along } = shapeFromLegs([[0, 40, 0.005, 40, 0.00996, 40, 0.01, 40]]); // el penúltimo, a 3,4 m de la parada
  assert.equal(shape.dist.length, 3);
  assert.ok(near(pointAlong(shape, along[1]), [0.01, 40]));
});

test('sin tramos, nada', () => {
  assert.equal(shapeFromLegs([]), null);
});
