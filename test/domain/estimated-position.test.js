// Posición estimada a partir del horario: reglas del dominio, sin leer ningún GTFS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePosition } from '../../server/domain/estimated-position.js';
import { buildShape, stopsAlongShape } from '../../server/domain/schedule.js';

// Tres paradas en línea hacia el este; de 8:00 a 8:10 entre la primera y la segunda.
const H8 = 8 * 3600;
const STOPS = [
  { stopId: 'A', name: 'Alfa', lat: 40, lon: -3.70, arr: H8, dep: H8 },
  { stopId: 'B', name: 'Beta', lat: 40, lon: -3.68, arr: H8 + 600, dep: H8 + 630 },
  { stopId: 'C', name: 'Gamma', lat: 40, lon: -3.66, arr: H8 + 1200, dep: H8 + 1200 },
];

test('fuera de su horario no circula', () => {
  assert.equal(estimatePosition({ stops: STOPS, mode: 'metro', t: H8 - 60 }), null);
  assert.equal(estimatePosition({ stops: STOPS, mode: 'metro', t: H8 + 1300 }), null);
});

test('metro sin trazado: en línea recta, con lo que le queda y la flecha hacia la próxima parada', () => {
  const est = estimatePosition({ stops: STOPS, mode: 'metro', t: H8 + 300 });
  assert.ok(Math.abs(est.lon - -3.69) < 1e-9, 'a mitad de camino');
  assert.deepEqual(est.path.stops, [[-3.68, 40], [-3.66, 40]]);
  assert.equal(est.ahead, true);
  assert.equal(Math.round(est.heading), 90, 'hacia el este');
  assert.deepEqual([est.current, est.next, est.nextArr], [null, 'Beta', H8 + 600]);
});

test('autobús sin trazado: se queda en la última parada y no dibuja nada', () => {
  const est = estimatePosition({ stops: STOPS, mode: 'bus', t: H8 + 300 });
  assert.deepEqual([est.lat, est.lon, est.atLastStop, est.current], [40, -3.70, true, 'Alfa']);
  assert.equal(est.path, null);
  assert.equal(est.ahead, false);
});

test('tren de larga distancia sin trazado: en recta, pero sin dibujar lo que le queda', () => {
  const est = estimatePosition({ stops: STOPS, mode: 'av', t: H8 + 300 });
  assert.equal(est.path, undefined);
  assert.equal(est.heading, null);
});

test('parado en una estación: está en ella y la próxima es la siguiente', () => {
  const est = estimatePosition({ stops: STOPS, mode: 'tranvia', t: H8 + 615 });
  assert.deepEqual([est.lon, est.current, est.next], [-3.68, 'Beta', 'Gamma']);
});

test('con trazado: sobre él, con el tramo recorrido y hasta dónde llega', () => {
  // El trazado se desvía al norte entre Alfa y Beta: la posición va por él y no por la recta.
  const shape = buildShape([-3.70, 40, -3.69, 40.005, -3.68, 40, -3.66, 40]);
  const along = stopsAlongShape(STOPS, shape);
  const est = estimatePosition({ stops: STOPS, mode: 'tranvia', shape, along, t: H8 + 300 });
  assert.ok(est.lat > 40.004, `por el trazado (${est.lat})`);
  assert.ok(est.path.from < 1, 'en los últimos 45 min, desde el principio del viaje');
  assert.ok(est.path.to > 0 && est.path.to < est.path.end);
  assert.equal(est.ahead, true);
});
