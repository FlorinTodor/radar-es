import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeFrequencyOffsets, gtfsTimeToSeconds, scheduledPosition, serviceRuns } from '../../server/domain/schedule.js';
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

test('viajes por frecuencia: repeticiones en circulación', () => {
  // Un metro cada 5 min de 06:00 a 07:00; el viaje dura 20 min; la plantilla sale a las 06:00.
  const freq = { start: 21600, end: 25200, headway: 300 };
  const at = (t) => activeFrequencyOffsets(freq, 21600, 1200, t);
  assert.deepEqual(at(21000), []); // antes de empezar
  assert.deepEqual(at(21600), [0]); // sale el primero
  assert.deepEqual(at(22800), [0, 300, 600, 900, 1200]); // 06:20: el primero llega, salen 5
  assert.equal(at(26400).length, 0); // 07:20: el último (06:55) ya llegó a las 07:15
});

test('punto dentro de polígono con hueco', () => {
  const geometry = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
  assert.equal(pointInGeometry(2, 2, geometry), true);
  assert.equal(pointInGeometry(5, 5, geometry), false); // en el hueco
  assert.equal(pointInGeometry(12, 5, geometry), false);
});

// ---------- Trazados ----------
import { buildShape, pointAlong, stopsAlongShape } from '../../server/domain/schedule.js';

// Calle en forma de L: 1 km hacia el este y luego 1 km hacia el norte (cerca de Madrid).
const LAT0 = 40.4;
const DLON_1KM = 1000 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
const DLAT_1KM = 1000 / 110_540;
const corner = [-3.7 + DLON_1KM, LAT0];
const lShape = () => buildShape([-3.7, LAT0, ...corner, -3.7 + DLON_1KM, LAT0 + DLAT_1KM]);

test('buildShape mide la distancia acumulada y quita puntos demasiado juntos', () => {
  const s = buildShape([-3.7, LAT0, -3.70001, LAT0, ...corner, -3.7 + DLON_1KM, LAT0 + DLAT_1KM]); // el 2.º, a ~1 m
  assert.equal(s.dist.length, 3);
  assert.ok(Math.abs(s.dist[2] - 2000) < 5, `longitud ${s.dist[2]}`);
});

test('pointAlong sigue la esquina en vez de cortar en diagonal', () => {
  const p = pointAlong(lShape(), 1000);
  assert.ok(Math.abs(p.lon - corner[0]) < 1e-5 && Math.abs(p.lat - corner[1]) < 1e-5);
  const q = pointAlong(lShape(), 1500); // medio km después de la esquina, subiendo
  assert.ok(Math.abs(q.lon - corner[0]) < 1e-5 && q.lat > LAT0 + DLAT_1KM * 0.45 && q.lat < LAT0 + DLAT_1KM * 0.55);
});

test('stopsAlongShape coloca cada parada sobre el trazado, hacia delante', () => {
  const stops = [{ lon: -3.7, lat: LAT0 }, { lon: corner[0], lat: LAT0 + 0.0005 }, { lon: -3.7 + DLON_1KM, lat: LAT0 + DLAT_1KM }];
  const along = stopsAlongShape(stops, lShape());
  assert.ok(Math.abs(along[0]) < 5 && Math.abs(along[1] - 1055) < 10 && Math.abs(along[2] - 2000) < 5, `${[...along]}`);
});

test('stopsAlongShape: en una línea circular la última parada no salta a la primera pasada', () => {
  // Ida y vuelta por la misma calle: la última parada coincide con la primera.
  const loop = buildShape([-3.7, LAT0, ...corner, -3.7, LAT0]);
  const along = stopsAlongShape([{ lon: -3.7, lat: LAT0 }, { lon: corner[0], lat: LAT0 }, { lon: -3.7, lat: LAT0 }], loop);
  assert.ok(along[2] > 1990, `última parada a ${along[2]} m`);
});

test('stopsAlongShape descarta un trazado que no pasa por las paradas', () => {
  assert.equal(stopsAlongShape([{ lon: -3.7, lat: LAT0 }, { lon: -3.6, lat: LAT0 + 0.05 }], lShape()), null);
});
