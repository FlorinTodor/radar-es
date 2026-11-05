// Caso de uso keep-tracks: qué historial se guarda (no el de los autobuses estimados ni el de vehículos
// que ya no están) y cuándo se recupera (sólo una copia de esta versión). Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeKeepTracks } from '../../server/application/use-cases/keep-tracks.js';

const T0 = Date.UTC(2026, 10, 5, 10, 0);
const point = (lat) => ({ t: T0 - 60_000, lat, lon: -3, delay: null });
const quiet = { info() {}, warn() {}, error() {} };

function situationWith(vehicles, tracks = new Map()) {
  return { vehicles: () => vehicles, tracks: () => tracks, updateTracks: (update) => update(tracks) };
}
function memoryStore() {
  let saved = null;
  return { load: async () => structuredClone(saved), save: async (s) => { saved = structuredClone(s); }, get saved() { return saved; } };
}

test('guarda el historial de los vehículos del mapa, menos el de los autobuses con posición estimada', async () => {
  const tracks = new Map([['tren', [point(40)]], ['bus-gps', [point(41)]], ['bus-estimado', [point(42)]], ['ya-no-esta', [point(43)]]]);
  const situation = situationWith([
    { id: 'tren', mode: 'cercanias' }, { id: 'bus-gps', mode: 'bus' }, { id: 'bus-estimado', mode: 'bus', estimated: true },
  ], tracks);
  const store = memoryStore();
  let pauses = 0;
  await makeKeepTracks({ situation, store, clock: { now: () => T0 }, log: quiet, pause: async () => { pauses++; } }).save();
  assert.equal(pauses, 0, 'pocos: de una vez');
  assert.deepEqual(store.saved.ids, ['tren', 'bus-gps']);
  assert.equal(store.saved.savedAt, T0);
  assert.equal(store.saved.version, 1);
});

test('al arrancar recupera lo guardado y lo dice; una copia de otra versión, o ninguna, no', async () => {
  const store = memoryStore();
  await makeKeepTracks({ situation: situationWith([{ id: 'tren', mode: 'md' }], new Map([['tren', [point(40)]]])), store, clock: { now: () => T0 }, log: quiet }).save();

  const tracks = new Map();
  const info = [];
  const keep = makeKeepTracks({ situation: situationWith([], tracks), store, clock: { now: () => T0 + 90_000 }, log: { ...quiet, info: (m) => info.push(m) } });
  assert.equal(await keep.restore(), 1);
  assert.equal(tracks.get('tren')[0].lat, 40);
  assert.deepEqual(info, ['[estelas] recuperado el historial de 1 vehículos (guardado hace 90 s)']);

  await store.save({ ...store.saved, version: 0 });
  assert.equal(await makeKeepTracks({ situation: situationWith([], new Map()), store, clock: { now: () => T0 }, log: quiet }).restore(), 0);
  assert.equal(await makeKeepTracks({ situation: situationWith([], new Map()), store: { load: async () => null }, clock: { now: () => T0 }, log: quiet }).restore(), 0);
});

test('muchos historiales: por partes, cediendo el turno entre una y otra, y la copia sale entera', async () => {
  const vehicles = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, mode: 'cercanias' }));
  const tracks = new Map(vehicles.map((v, i) => [v.id, [point(40 + i / 1000)]]));
  const store = memoryStore();
  let pauses = 0;
  await makeKeepTracks({ situation: situationWith(vehicles, tracks), store, clock: { now: () => T0 }, log: quiet, pause: async () => { pauses++; } }).save();
  assert.equal(pauses, 2, '400 en partes de 150');
  assert.equal(store.saved.ids.length, 400);
  assert.equal(store.saved.points.length, 400 * 6);
  assert.equal(store.saved.points[6 * 399 + 1], 40.399);
});
