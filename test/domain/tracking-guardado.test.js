// Historial guardado: lo que se guarda vuelve igual, sin lo que ya ha salido de la ventana de 45 min,
// sin pisar un historial nuevo y sin usar una copia que no tenga la forma esperada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPacked, packTracks, restoreTracks, recordPositions, stationarySince } from '../../server/domain/tracking.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 10, 0);

test('lo guardado vuelve igual: retraso desconocido, hora de GPS y última vez visto', () => {
  const tracks = new Map([
    ['renfe-c:1', [{ t: T0 - 5 * MIN, lat: 40.1, lon: -3.1, delay: 2, fix: T0 - 5 * MIN - 3000 }, { t: T0 - MIN, lat: 40.2, lon: -3.2, delay: 3, seen: T0 }]],
    ['metro:2', [{ t: T0 - 2 * MIN, lat: 41.1, lon: 2.1, delay: null }]],
    ['bus:3', [{ t: T0, lat: 42, lon: -8, delay: null }]],
  ]);
  const packed = packTracks([...tracks].filter(([id]) => id !== 'bus:3'));
  assert.deepEqual(packed.ids, ['renfe-c:1', 'metro:2']);
  const back = new Map();
  assert.equal(restoreTracks(back, structuredClone(packed), T0), 2, 'también tras pasar por disco (structuredClone, como v8)');
  assert.deepEqual(back.get('renfe-c:1'), tracks.get('renfe-c:1'));
  assert.deepEqual(back.get('metro:2'), tracks.get('metro:2'));
  assert.equal(back.has('bus:3'), false);
});

test('al recuperar, fuera lo que ya no entra en los 45 min y los que llevan más de 45 min sin verse', () => {
  const tracks = new Map([
    ['viejo', [{ t: T0 - 60 * MIN, lat: 40, lon: -3, delay: 0 }, { t: T0 - 50 * MIN, lat: 40.1, lon: -3, delay: 0 }]],
    ['parado', [{ t: T0 - 60 * MIN, lat: 40, lon: -3, delay: 0, seen: T0 - MIN }]],
    ['largo', [{ t: T0 - 50 * MIN, lat: 40, lon: -3, delay: 0 }, { t: T0 - 40 * MIN, lat: 40.1, lon: -3, delay: 0 }, { t: T0 - MIN, lat: 40.2, lon: -3, delay: 1 }]],
  ]);
  const back = new Map();
  restoreTracks(back, packTracks(tracks), T0);
  assert.deepEqual([...back.keys()], ['parado', 'largo']);
  assert.equal(back.get('parado').length, 1, 'parado desde hace una hora: su único punto sigue (es desde cuándo está parado)');
  assert.deepEqual(back.get('largo').map((p) => p.t), [T0 - 40 * MIN, T0 - MIN]);
});

test('no pisa el historial de un vehículo que ya tiene uno, y una copia mal formada no se usa', () => {
  const saved = packTracks(new Map([['a', [{ t: T0 - MIN, lat: 40, lon: -3, delay: 0 }]], ['b', [{ t: T0 - MIN, lat: 41, lon: -3, delay: 0 }]]]));
  const tracks = new Map([['a', [{ t: T0, lat: 39, lon: -4, delay: 5 }]]]);
  assert.equal(restoreTracks(tracks, saved, T0), 1);
  assert.equal(tracks.get('a')[0].lat, 39);
  assert.equal(tracks.get('b')[0].lat, 41);
  const empty = new Map();
  assert.equal(restoreTracks(empty, null, T0), 0);
  assert.equal(restoreTracks(empty, { ...saved, points: saved.points.subarray(6) }, T0), 0, 'cortada');
  assert.equal(restoreTracks(empty, { ...saved, ids: ['a'] }, T0), 0);
  assert.equal(restoreTracks(empty, { ids: saved.ids, lengths: [1, 1], points: [...saved.points] }, T0), 0, 'sin arrays tipados');
  assert.equal(empty.size, 0);
});

test('tras recuperarlo, el historial sigue: la estela no empieza de cero y el tren que no se mueve sigue parado desde antes', () => {
  const v = (lat, delay) => ({ id: 'renfe-c:1', mode: 'cercanias', lat, lon: -3.7, delay });
  const before = new Map();
  recordPositions(before, [v(40.40, 1)], T0 - 10 * MIN);
  recordPositions(before, [v(40.41, 1)], T0 - 5 * MIN);
  recordPositions(before, [v(40.42, 2)], T0 - MIN);
  // Otro servidor arranca con la copia y lee el tren un minuto después.
  const after = new Map();
  restoreTracks(after, structuredClone(packTracks(before)), T0);
  recordPositions(after, [v(40.43, 2)], T0);
  assert.deepEqual(after.get('renfe-c:1').map((p) => p.lat), [40.40, 40.41, 40.42, 40.43]);

  const stopped = new Map();
  recordPositions(stopped, [v(40.5, 0)], T0 - 12 * MIN);
  recordPositions(stopped, [v(40.5, 0)], T0 - MIN);
  const restarted = new Map();
  restoreTracks(restarted, structuredClone(packTracks(stopped)), T0);
  recordPositions(restarted, [v(40.5, 0)], T0);
  assert.equal(stationarySince(restarted.get('renfe-c:1'), 0.15), T0 - 12 * MIN, 'parado desde hace 12 min, no desde el arranque');
});

test('empaquetado por partes y juntado, lo mismo que de una vez', () => {
  const tracks = new Map(Array.from({ length: 7 }, (_, i) => [`v${i}`, Array.from({ length: i + 1 }, (__, j) => ({ t: T0 - j * MIN, lat: 40 + i, lon: -3 - j, delay: j % 2 ? null : j }))]));
  const all = [...tracks];
  const joined = joinPacked([packTracks(all.slice(0, 3)), packTracks(all.slice(3, 5)), packTracks(all.slice(5))]);
  assert.deepEqual(joined, packTracks(tracks));
});
