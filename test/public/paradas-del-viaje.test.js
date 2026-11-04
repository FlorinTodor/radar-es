// Paradas del vehículo seleccionado en el mapa y en su ficha (public/js/trip-stops.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STOP_LABEL_ANCHORS, STOP_SPACE_SIZE, stopLabelLayout, stopSpaceLayout, stopTipHtml, stopWhen, stopsCollection, stopsListHtml, tripFramePoints } from '../../public/js/trip-stops.js';

const DATA = {
  partial: false,
  stops: [
    { name: 'Madrid-Chamartín', lon: -3.68, lat: 40.47, time: '17:00', eta: null, passed: true },
    { name: 'Segovia AV', lon: -4.09, lat: 40.91, time: '17:28', eta: '17:35', passed: false },
    { name: 'Apeadero sin posición', lon: null, lat: null, time: null, eta: null, passed: false },
    { name: 'Valladolid <Campo Grande>', lon: -4.73, lat: 41.64, time: '18:05', eta: '18:12', passed: false },
  ],
};

test('en el mapa: origen y destino destacados, la próxima marcada, las pasadas aparte; sin posición, no sale', () => {
  const { features } = stopsCollection(DATA);
  assert.deepEqual(features.map((f) => [f.properties.name, f.properties.end, f.properties.next, f.properties.passed]), [
    ['Madrid-Chamartín', 1, 0, 1], ['Segovia AV', 0, 1, 0], ['Valladolid <Campo Grande>', 1, 0, 0],
  ]);
  assert.deepEqual(features[1].geometry.coordinates, [-4.09, 40.91]);
  assert.equal(features[1].properties.rank, 0, 'la etiqueta de la próxima, la primera que se coloca');
  assert.deepEqual(stopsCollection(null).features, []);
});

test('la hora: la del horario y, en las que le quedan, la prevista', () => {
  assert.equal(stopWhen(DATA.stops[0]), '17:00');
  assert.equal(stopWhen(DATA.stops[1]), '17:28 · prevista 17:35');
  assert.equal(stopWhen({ passed: false, time: null, eta: '09:10' }), 'prevista 09:10');
  assert.equal(stopWhen({ passed: false, time: null, eta: null }), '');
});

test('al pasar el ratón o tocar una parada: su nombre (escapado), si es origen o destino y su hora', () => {
  const html = stopTipHtml({ name: 'Valladolid <Campo Grande>', i: 3, passed: 0, next: 0, when: '18:05 · prevista 18:12' }, 4);
  assert.equal(html, '<strong>Valladolid &lt;Campo Grande&gt;</strong><br><span>Destino · 18:05 · prevista 18:12</span>');
  assert.match(stopTipHtml({ name: 'Segovia AV', i: 1, next: 1, when: '17:28' }, 4), /próxima parada · 17:28/);
});

test('en la ficha: cuántas le quedan, las pasadas atenuadas, la próxima resaltada y «…» si la fuente no las da todas', () => {
  const html = stopsListHtml(DATA);
  assert.match(html, /^<details class="trip-stops" data-keep="stops"><summary>Paradas · le quedan 3 de 4<\/summary>/);
  assert.match(html, /<li class="passed end"><span class="ts-name">Madrid-Chamartín<\/span><span class="ts-time">17:00<\/span><\/li>/);
  assert.match(html, /<li class="next"><span class="ts-name">Segovia AV<\/span><span class="ts-time">17:28 · prevista 17:35<\/span>/);
  assert.match(html, /Valladolid &lt;Campo Grande&gt;/);
  assert.doesNotMatch(html, /class="gap"/);
  assert.match(stopsListHtml(DATA, { open: true }), /data-keep="stops" open>/);
  const partial = stopsListHtml({ ...DATA, partial: true });
  assert.match(partial, /le quedan 3<\/summary>/);
  assert.match(partial, /17:00<\/span><\/li><li class="gap"/, 'después del origen');
  assert.match(stopsListHtml({ stops: DATA.stops.map((s) => ({ ...s, passed: true })) }), /ya ha llegado a Valladolid/);
  assert.equal(stopsListHtml({ stops: [DATA.stops[0]] }), '');
});

test('parado en una parada: ni pasada ni la próxima (la próxima es la siguiente), y lo dice', () => {
  const data = { stops: [
    { name: 'A', lon: 1, lat: 1, time: '10:00', passed: true },
    { name: 'B', lon: 2, lat: 2, time: '10:10', passed: false, here: true },
    { name: 'C', lon: 3, lat: 3, time: '10:20', passed: false },
  ] };
  const props = stopsCollection(data).features.map((f) => [f.properties.name, f.properties.here, f.properties.next]);
  assert.deepEqual(props, [['A', 0, 0], ['B', 1, 0], ['C', 0, 1]]);
  const html = stopsListHtml(data);
  assert.match(html, /le queda 1 de 3/);
  assert.match(html, /<li class="here"><span class="ts-name">B<\/span><span class="ts-time">parado aquí · 10:10<\/span>/);
  assert.match(stopTipHtml({ name: 'B', i: 1, here: 1, next: 0, when: '10:10' }, 3), /está parado aquí · 10:10/);
});

test('al seleccionarlo, el mapa encuadra todo su viaje: las paradas con posición, del origen al destino, y el vehículo', () => {
  // Un AVE directo Madrid → Zaragoza → Barcelona con el tren cerca de Barcelona: también Madrid y Zaragoza.
  const ave = { stops: [
    { name: 'Madrid-Puerta de Atocha', lon: -3.69, lat: 40.406, passed: true },
    { name: 'Zaragoza-Delicias', lon: -0.911, lat: 41.658, passed: true },
    { name: 'Barcelona-Sants', lon: 2.14, lat: 41.379, passed: false },
  ] };
  assert.deepEqual(tripFramePoints(ave, { lon: 2.0, lat: 41.4 }), [[-3.69, 40.406], [-0.911, 41.658], [2.14, 41.379], [2.0, 41.4]]);
  assert.deepEqual(tripFramePoints(DATA).length, 3, 'la parada sin posición no cuenta');
  assert.deepEqual(tripFramePoints(null, { lon: 1, lat: 2 }), [[1, 2]]);
});

test('nombres de las paradas: el origen, el destino y la próxima siempre, y sin montarse sobre otros ni sobre los puntos', async () => {
  const font = ['Noto Sans Regular'];
  const key = stopLabelLayout({ key: true, font });
  const rest = stopLabelLayout({ key: false, font });
  // Debajo del punto o, si ahí choca, encima; a los lados no, que cerca del borde se saldría de la pantalla.
  for (const l of [key, rest]) {
    assert.deepEqual(l['text-variable-anchor-offset'], ['top', [0, 1.6], 'bottom', [0, -1.6]]);
    assert.equal(l['text-anchor'], undefined, 'con sitios variables, text-anchor y text-offset no se usan');
    assert.equal(l['text-offset'], undefined);
  }
  assert.equal(key['text-allow-overlap'], true, 'los tres, aunque no quepan');
  assert.equal(rest['text-allow-overlap'], undefined, 'las demás se ocultan si chocan');
  assert.deepEqual(rest['symbol-sort-key'], ['get', 'rank']);
  assert.equal(STOP_LABEL_ANCHORS, key['text-variable-anchor-offset']);

  // El hueco de los puntos aparta los nombres: siempre está y no ignora la colocación.
  const KEY = ['==', ['get', 'end'], 1];
  const space = stopSpaceLayout(KEY);
  assert.equal(space['icon-allow-overlap'], true);
  assert.equal(space['icon-ignore-placement'], false);
  assert.deepEqual(space['icon-size'], ['case', KEY, STOP_SPACE_SIZE.key, STOP_SPACE_SIZE.rest]);

  // MapLibre coloca de la capa de arriba hacia abajo: los puntos, luego los tres y luego las demás.
  const src = await readFile(new URL('../../public/js/map.js', import.meta.url), 'utf8');
  const at = (id) => src.indexOf(`id: '${id}',`);
  assert.ok(at('stops-label') > 0 && at('stops-label') < at('stops-label-key') && at('stops-label-key') < at('stops-space'),
    'se añaden stops-label, stops-label-key y stops-space, por ese orden');
});
