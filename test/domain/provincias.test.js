// Provincias para los avisos de zona del bot: cada punto, a la suya (aproximada, también en las islas y en los
// bordes), y qué avisos de AEMET, terremotos y avisos oficiales son de cada una.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVINCIAS_ES, eventInProvince, feltRadiusKm, findProvince, provinceById, provinceOfPoint } from '../../server/domain/provincias.js';

test('las 50 provincias, Ceuta y Melilla, con ids únicos y círculos con sentido', () => {
  assert.equal(PROVINCIAS_ES.length, 52);
  assert.equal(new Set(PROVINCIAS_ES.map((p) => p.id)).size, 52);
  for (const p of PROVINCIAS_ES) for (const c of p.circles) assert.ok(c.km > 0 && c.km < 120 && c.lat > 27 && c.lat < 44, p.name);
});

test('findProvince: por su nombre, sin tildes, en otras lenguas o con «provincia de»', () => {
  assert.equal(findProvince('valencia').id, 'valencia');
  assert.equal(findProvince('València').id, 'valencia');
  assert.equal(findProvince('La Coruña').id, 'a-coruna');
  assert.equal(findProvince('provincia de Cádiz').id, 'cadiz');
  assert.equal(findProvince('Vizcaya').id, 'bizkaia');
  assert.equal(findProvince('Baleares').id, 'illes-balears');
  assert.equal(findProvince('Atlántida'), null);
  assert.equal(findProvince(''), null);
});

test('provinceOfPoint: capitales, pueblos de frontera e islas, y nada en alta mar', () => {
  const cases = [
    ['madrid', 40.42, -3.70], ['madrid', 40.03, -3.6], ['toledo', 39.96, -4.83], ['valencia', 39.47, -0.38], ['alicante', 38.54, -0.13],
    ['albacete', 38.87, -1.1], ['burgos', 42.68, -2.95], ['alava', 42.85, -2.67], ['navarra', 42.06, -1.6], ['gipuzkoa', 43.34, -1.79],
    ['almeria', 36.78, -2.81], ['pontevedra', 42.24, -8.72], ['a-coruna', 42.88, -8.54], ['illes-balears', 39.95, 4.1],
    ['las-palmas', 28.5, -13.86], ['santa-cruz-de-tenerife', 28.68, -17.76], ['ceuta', 35.889, -5.316], ['melilla', 35.292, -2.938],
    // Zonas de aviso de AEMET (el centro de la zona): Sierra de San Vicente y Centro y valle de Villaverde.
    ['toledo', 40.17, -4.65], ['cantabria', 43.21, -3.85],
  ];
  for (const [id, lat, lon] of cases) assert.equal(provinceOfPoint(lat, lon)?.id, id, `${lat}, ${lon}`);
  assert.equal(provinceOfPoint(45, -12), null, 'en el Atlántico');
  assert.equal(provinceOfPoint(null, null), null);
});

test('eventInProvince: AEMET sólo naranja y rojo; terremotos recientes que pueden sentirse; avisos oficiales por lo que nombran', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const toledo = provinceById('toledo');
  const meteo = { category: 'meteo', level: 'naranja', lat: 40.17, lon: -4.65 };
  assert.equal(eventInProvince(meteo, toledo, { now }), true);
  assert.equal(eventInProvince({ ...meteo, level: 'amarillo' }, toledo, { now }), false);
  assert.equal(eventInProvince(meteo, provinceById('madrid'), { now }), false);

  const cadiz = provinceById('cadiz');
  const quake = { category: 'sismo', magnitude: 4, lat: 36.4, lon: -6.8, start: now - 3600_000 };
  assert.equal(feltRadiusKm(4), 50);
  assert.equal(eventInProvince(quake, cadiz, { now }), true, 'en el golfo de Cádiz, cerca de la costa');
  assert.equal(eventInProvince({ ...quake, magnitude: 2.1 }, cadiz, { now }), false, 'no se siente');
  assert.equal(eventInProvince({ ...quake, start: now - 5 * 3600_000 }, cadiz, { now }), false, 'de hace horas');
  assert.equal(eventInProvince(quake, provinceById('madrid'), { now }), false);

  const plan = { category: 'emergencia', area: 'Canarias', approx: 'comunidad', lat: 28.33, lon: -15.75 };
  assert.equal(eventInProvince(plan, provinceById('las-palmas'), { now }), true);
  assert.equal(eventInProvince(plan, provinceById('santa-cruz-de-tenerife'), { now }), true);
  assert.equal(eventInProvince(plan, cadiz, { now }), false);
  assert.equal(eventInProvince({ category: 'emergencia', area: 'Toledo', approx: 'provincia' }, toledo, { now }), true);
  assert.equal(eventInProvince({ category: 'emergencia', area: 'La Palma', approx: 'isla' }, provinceById('santa-cruz-de-tenerife'), { now }), true);
  assert.equal(eventInProvince({ category: 'emergencia', area: 'Talavera de la Reina', approx: 'municipio', lat: 39.96, lon: -4.83 }, toledo, { now }), true);
  assert.equal(eventInProvince({ category: 'carretera', lat: 40.17, lon: -4.65 }, toledo, { now }), false, 'el tráfico no es un aviso de zona');
});
