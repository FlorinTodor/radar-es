// Paradas que Renfe aún da por próximas pero que el tren, según su GPS, ya ha dejado atrás.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopsLeftBehind } from '../../server/domain/route-ahead.js';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T16:00:00Z');
// Hacia el sur, a 0,01° de latitud (≈1,1 km) por minuto.
const southFrom = (lat0) => [0, 1, 2, 3, 4].map((m) => ({ t: T0 + m * MIN, lat: lat0 - m * 0.01, lon: -1.6 }));
const TUDELA = [-1.6, 42.06];
const ZARAGOZA = [-1.6, 41.65];

test('ya la ha pasado y se aleja de ella: fuera', () => {
  assert.equal(stopsLeftBehind(southFrom(42.0), [TUDELA, ZARAGOZA]), 1);
});

test('se acerca a ella (también un tren que cambia de sentido en esa estación): se queda', () => {
  assert.equal(stopsLeftBehind(southFrom(42.12), [TUDELA, ZARAGOZA]), 0);
  // Llega a la estación por el sur, por la misma vía por la que saldrá hacia el sur.
  const north = [0, 1, 2, 3, 4].map((m) => ({ t: T0 + m * MIN, lat: 41.98 + m * 0.01, lon: -1.6 }));
  assert.equal(stopsLeftBehind(north, [TUDELA, ZARAGOZA]), 0);
});

test('aún cerca de ella (acaba de salir), o parado: se queda', () => {
  assert.equal(stopsLeftBehind([{ t: T0, lat: 42.05, lon: -1.6 }, { t: T0 + MIN, lat: 42.045, lon: -1.6 }], [TUDELA, ZARAGOZA]), 0);
  assert.equal(stopsLeftBehind([{ t: T0, lat: 41.9, lon: -1.6 }, { t: T0 + MIN, lat: 41.9, lon: -1.6 }], [TUDELA, ZARAGOZA]), 0, 'parado: no se aleja');
});

test('nunca su destino, ni sin posiciones', () => {
  assert.equal(stopsLeftBehind(southFrom(42.0), [TUDELA]), 0);
  assert.equal(stopsLeftBehind([], [TUDELA, ZARAGOZA]), 0);
  assert.equal(stopsLeftBehind(undefined, [TUDELA]), 0);
});

test('sólo cuenta lo que se ha alejado en sus últimos 5 minutos', () => {
  // Hace 20 min estaba en Tudela; desde hace 5, parado a 30 km: no se ha alejado en la ventana.
  const track = [{ t: T0 - 20 * MIN, lat: 42.06, lon: -1.6 }, { t: T0 - 5 * MIN, lat: 41.79, lon: -1.6 }, { t: T0, lat: 41.79, lon: -1.6 }];
  assert.equal(stopsLeftBehind(track, [TUDELA, ZARAGOZA]), 0);
});
