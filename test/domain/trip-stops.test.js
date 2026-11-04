// Paradas del viaje de un vehículo: de dónde viene, por dónde pasa y adónde va, con su hora y las que
// ya ha pasado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockOf, nextStopIndex, tripStopList } from '../../server/domain/trip-stops.js';

test('la hora del horario en «HH:MM», también la que pasa de medianoche', () => {
  assert.equal(clockOf(17 * 3600 + 5 * 60 + 40), '17:05');
  assert.equal(clockOf(25 * 3600 + 10 * 60), '01:10');
  assert.equal(clockOf(null), null);
});

test('la primera que no ha pasado: en la que está hasta su salida y, entre dos, la siguiente', () => {
  const stops = [{ arr: 100, dep: 100 }, { arr: 200, dep: 260 }, { arr: 400, dep: 400 }];
  assert.equal(nextStopIndex(stops, 50), 0, 'antes de salir');
  assert.equal(nextStopIndex(stops, 150), 1, 'de camino a la segunda');
  assert.equal(nextStopIndex(stops, 230), 1, 'parado en la segunda');
  assert.equal(nextStopIndex(stops, 300), 2);
  assert.equal(nextStopIndex(stops, 500), 3, 'ha pasado por todas');
});

test('lista: las pasadas sin hora prevista; en las que le quedan, la del operador o la del horario con su retraso', () => {
  const list = tripStopList([
    { name: 'Origen', at: [-3.689123, 40.4723], time: 17 * 3600 },
    { name: 'Medio', at: [-3.5, 40.3], time: 17 * 3600 + 1800 },
    { name: 'Llegada', at: [-3.2, 40.1], time: 18 * 3600, eta: '18:20' },
  ], 1, { delaySec: 420 });
  assert.deepEqual(list, {
    partial: false,
    stops: [
      { name: 'Origen', lon: -3.68912, lat: 40.4723, time: '17:00', eta: null, passed: true },
      { name: 'Medio', lon: -3.5, lat: 40.3, time: '17:30', eta: '17:37', passed: false },
      { name: 'Llegada', lon: -3.2, lat: 40.1, time: '18:00', eta: '18:20', passed: false },
    ],
  });
});

test('sin retraso ni hora no hay prevista; sin posición sale en la lista sin coordenadas; sin saber cuál es la próxima, ninguna pasada', () => {
  const { stops } = tripStopList([{ name: 'A', at: [-1, 40], time: 3600 }, { name: null, at: null }], -1, { delaySec: 0 });
  assert.deepEqual(stops, [
    { name: 'A', lon: -1, lat: 40, time: '01:00', eta: null, passed: false },
    { name: '?', lon: null, lat: null, time: null, eta: null, passed: false },
  ]);
  assert.equal(tripStopList([{ name: 'Sola' }], 0), null, 'con una sola parada no hay viaje');
  assert.equal(tripStopList([{ name: 'A' }, { name: 'B' }], 1, { partial: true }).partial, true);
});

test('parado en la parada de `next`: here sólo en esa', () => {
  const { stops } = tripStopList([{ name: 'A' }, { name: 'B' }, { name: 'C' }], 1, { here: true });
  assert.deepEqual(stops.map((s) => [s.name, s.passed, s.here ?? false]), [['A', true, false], ['B', false, true], ['C', false, false]]);
});
