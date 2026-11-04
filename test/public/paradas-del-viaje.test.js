// Paradas del vehículo seleccionado en el mapa y en su ficha (public/js/trip-stops.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopTipHtml, stopWhen, stopsCollection, stopsListHtml } from '../../public/js/trip-stops.js';

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
