import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShape } from '../../server/domain/schedule.js';
import { nearestAlong, progressOnShape, shapeStretch, trackOnShape } from '../../server/domain/recorrido-trazado.js';

// Un viaje de ida y vuelta por la misma calle: 1 km hacia el este y vuelta (como muchas líneas de autobús).
const there = Array.from({ length: 11 }, (_, i) => [-3.7 + i * 0.00118, 40.4]);
const shape = buildShape([...there, ...there.slice(0, -1).reverse()].flat());
const at = (km) => ({ lon: -3.7 + km * 0.0118, lat: 40.4001 }); // a ~11 m de la calle

test('nearestAlong: la proyección más cercana, dentro de la ventana pedida', () => {
  const p = at(0.5);
  const free = nearestAlong(shape, p.lon, p.lat);
  assert.ok(free.off < 15);
  const back = nearestAlong(shape, p.lon, p.lat, 1100);
  assert.ok(back.along > 1400 && back.along < 1600, `en la vuelta (${back.along})`);
});

test('progressOnShape: siempre hacia delante desde donde iba, aunque la vuelta pase por el mismo sitio', () => {
  const ida = progressOnShape(shape, at(0.5).lon, at(0.5).lat, 400);
  assert.ok(Math.abs(ida.along - 500) < 30, `en la ida (${ida.along})`);
  const vuelta = progressOnShape(shape, at(0.5).lon, at(0.5).lat, 1300);
  assert.ok(Math.abs(vuelta.along - 1500) < 30, `en la vuelta (${vuelta.along})`);
  assert.equal(vuelta.restart, false);
  assert.equal(progressOnShape(shape, -3.7, 40.41, 400), null, 'a 1 km de la calle no está en el trazado');
});

test('trackOnShape: de dónde a dónde ha ido; un desvío corta y lo que sigue empieza de nuevo', () => {
  const track = [at(0.1), at(0.3), at(0.6)];
  const run = trackOnShape(shape, track);
  assert.ok(Math.abs(run.from - 100) < 30 && Math.abs(run.to - 600) < 30, JSON.stringify(run));
  const detour = trackOnShape(shape, [at(0.1), { lon: -3.69, lat: 40.41 }, at(0.6), at(0.8)]);
  assert.ok(Math.abs(detour.from - 600) < 30, 'tras el desvío, desde donde vuelve a la calle');
  assert.equal(trackOnShape(shape, [at(0.1), { lon: -3.69, lat: 40.41 }]), null, 'si la última posición no está en el trazado, nada');
  assert.equal(trackOnShape(shape, []), null);
});

test('shapeStretch: el tramo entre dos distancias, con sus puntos, y nada si no hay tramo', () => {
  const part = shapeStretch(shape, 250, 750);
  assert.ok(part.length >= 6);
  assert.ok(Math.abs(part[0][0] - (-3.7 + 0.25 * 0.0118)) < 1e-4);
  assert.equal(shapeStretch(shape, 500, 500), null);
  assert.equal(shapeStretch(shape, 900, 100), null);
  assert.ok(shapeStretch(shape, 1900, 99999).length >= 2, 'hasta el final, aunque se pida más');
});

test('headingOnShape: hacia dónde sigue el trazado; al final, ninguno', async () => {
  const { headingOnShape } = await import('../../server/domain/recorrido-trazado.js');
  assert.ok(Math.abs(headingOnShape(shape, 200) - 90) < 3, 'en la ida, hacia el este');
  assert.ok(Math.abs(headingOnShape(shape, 1300) - 270) < 3, 'en la vuelta, hacia el oeste');
  assert.equal(headingOnShape(shape, shape.dist.at(-1)), null);
});
