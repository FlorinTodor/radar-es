// Las líneas del mapa por la vía: los tramos rectos que se salen se rehacen detrás, sin parar la web;
// mientras tanto (o sin red de vías) se sirven las del operador, y la atribución cita la red de vías
// sólo en las redes que se han rehecho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLinesOnRail } from '../../server/application/use-cases/lines-on-rail.js';
import { buildRailNetwork, meters, nearestOnRail } from '../../server/domain/rail-match.js';

const KX = 111_320 * Math.cos((37.4 * Math.PI) / 180);
const KY = 110_540;
const at = ([lon, lat], east, north) => [lon + east / KX, lat + north / KY];
const O = [-6.04, 37.35];
const CURVE = Array.from({ length: 41 }, (_, i) => { const a = ((90 * i) / 40) * (Math.PI / 180); return at(O, 2000 * Math.cos(a), 2000 * Math.sin(a)); });
const net = buildRailNetwork([CURVE]);
const feature = (network, coordinates) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties: { network, line: 'L1', mode: 'metro', shapes: ['S1'] } });
const coarse = feature('Metro de Sevilla', [CURVE[0], CURVE.at(-1)]);
const good = feature('Metro de Málaga', CURVE);
const base = { type: 'FeatureCollection', features: [coarse, good] };
const catalog = {
  load: async () => 2,
  lines: () => base,
  sources: () => [{ name: 'Metro de Sevilla', credit: 'Metro de Sevilla' }, { name: 'Metro de Málaga', credit: 'Metro de Málaga' }],
};
const credit = 'Obra derivada de IGR-RT 2026 CC-BY 4.0 scne.es';

test('se rehacen detrás; hasta entonces, las del operador', async () => {
  const lines = makeLinesOnRail({ network: catalog, railGeometry: { network: () => net, credit }, yieldTurn: async () => {} });
  assert.equal(lines.lines(), base, 'la primera consulta no espera');
  await lines.settled();
  const ready = lines.lines();
  assert.notEqual(ready, base);
  assert.equal(lines.lines(), ready, 'el mismo objeto mientras no cambien las líneas ni la red');
  const [sevilla, malaga] = ready.features;
  assert.equal(malaga, good, 'lo que ya va por la vía, el mismo objeto');
  assert.ok(sevilla.geometry.coordinates.length > 10, 'la recta, rehecha por la curva');
  assert.ok(sevilla.geometry.coordinates.every(([lon, lat]) => nearestOnRail(net, lon, lat, 5)));
  assert.deepEqual(sevilla.properties, coarse.properties, 'con sus propiedades');
  assert.ok(meters(...sevilla.geometry.coordinates[0], ...CURVE[0]) < 1);
  const sources = lines.sources();
  assert.equal(sources[0].credit, `Metro de Sevilla · Vía: ${credit}`);
  assert.equal(sources[1].credit, 'Metro de Málaga', 'sin tramos rehechos, sólo la del operador');
});

test('sin red de vías, las del operador tal cual', () => {
  const lines = makeLinesOnRail({ network: catalog, railGeometry: { network: () => null, credit } });
  assert.equal(lines.lines(), base);
  assert.deepEqual(lines.sources(), catalog.sources());
  assert.equal(makeLinesOnRail({ network: catalog }).lines(), base);
});
