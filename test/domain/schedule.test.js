import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gtfsTimeToSeconds, scheduledPosition, serviceRuns } from '../../server/domain/schedule.js';
import { pointInGeometry } from '../../server/domain/geo.js';

const stops = [
  { stopId: 'MAD', name: 'Madrid', lat: 40.0, lon: -3.0, arr: 36000, dep: 36000 }, // 10:00
  { stopId: 'ZAZ', name: 'Zaragoza', lat: 41.0, lon: -1.0, arr: 41400, dep: 41520 }, // 11:30 – 11:32
  { stopId: 'BCN', name: 'Barcelona', lat: 41.4, lon: 2.1, arr: 45000, dep: 45000 }, // 12:30
];

test('horas GTFS de más de 24 h', () => {
  assert.equal(gtfsTimeToSeconds('25:10:00'), 90600);
  assert.equal(gtfsTimeToSeconds('basura'), null);
});

test('posición interpolada entre dos estaciones', () => {
  const p = scheduledPosition(stops, 38700); // a mitad de camino Madrid → Zaragoza
  assert.equal(p.atStop, false);
  assert.equal(p.next.name, 'Zaragoza');
  assert.ok(Math.abs(p.lat - 40.5) < 1e-9 && Math.abs(p.lon + 2.0) < 1e-9);
});

test('detenido en estación durante la parada comercial', () => {
  const p = scheduledPosition(stops, 41460);
  assert.equal(p.atStop, true);
  assert.equal(p.prev.name, 'Zaragoza');
});

test('fuera del horario del tren no hay posición', () => {
  assert.equal(scheduledPosition(stops, 30000), null);
  assert.equal(scheduledPosition(stops, 50000), null);
});

test('calendario con excepciones', () => {
  const cal = { start: '20260901', end: '20261231', days: [true, true, true, true, true, false, false] };
  assert.equal(serviceRuns(cal, undefined, '20261030', 4), true); // viernes
  assert.equal(serviceRuns(cal, undefined, '20261031', 5), false); // sábado
  assert.equal(serviceRuns(cal, new Map([['20261030', 2]]), '20261030', 4), false); // suprimido
  assert.equal(serviceRuns(undefined, new Map([['20261031', 1]]), '20261031', 5), true); // añadido
});

test('punto dentro de polígono con hueco', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  assert.equal(pointInGeometry(2, 2, geometry), true);
  assert.equal(pointInGeometry(5, 5, geometry), false); // en el hueco
  assert.equal(pointInGeometry(12, 5, geometry), false);
});
