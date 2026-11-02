// Lo común de los catálogos de estaciones (station-store.js): la copia en disco con versión y fecha,
// la renovación en segundo plano («incompleto → reintento a la hora») y la estación más cercana.
// Reloj inyectado: nada depende de la hora a la que se pasen las pruebas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distanceKm } from '../../server/domain/geo.js';
import { createStationStore, nearestStation } from '../../server/adapters/outbound/stations/station-store.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-02T12:00:00Z');

/** Generador de números pseudoaleatorios con semilla: los mismos puntos en cada pasada. */
function seeded(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

function bruteForce(stations, lat, lon, maxKm) {
  let best = null;
  let bestKm = Infinity;
  for (const s of stations) {
    const km = distanceKm(lat, lon, s.lat, s.lon);
    if (km < bestKm && km <= maxKm) { bestKm = km; best = s; }
  }
  return best ? { station: best, km: bestKm } : null;
}

test('la estación más cercana con prefiltro es la misma que sin él, también lejos del ecuador', () => {
  const random = seeded(42);
  // Estaciones de Canarias a Lyon y París (Renfe tiene estaciones en Francia).
  const stations = Array.from({ length: 3000 }, (_, i) => ({ code: String(i), lat: 27 + random() * 22, lon: -18 + random() * 22 }));
  let found = 0;
  for (let i = 0; i < 2000; i++) {
    const lat = 27 + random() * 22;
    const lon = -18 + random() * 22;
    const maxKm = [1, 10, 50, 150][i % 4];
    const expected = bruteForce(stations, lat, lon, maxKm);
    assert.deepEqual(nearestStation(stations, lat, lon, maxKm), expected, `${lat},${lon} a ${maxKm} km`);
    if (expected) found++;
  }
  assert.ok(found > 500, 'la comprobación encuentra estaciones, no sólo nulls');
  assert.equal(nearestStation([], 40, -3), null);
  // A 40° N, 0,6° de longitud son unos 51 km y 0,55°, unos 47: sin maxKm, el tope es 50 km.
  assert.equal(nearestStation([{ lat: 40, lon: -3.6 }], 40, -3), null);
  assert.equal(nearestStation([{ lat: 40, lon: -3.55 }], 40, -3)?.station.lon, -3.55);
});

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'estaciones-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Almacén con un reloj que se mueve a mano y una descarga que se controla desde la prueba. */
function makeStore(dir, { waitIfEmpty = false, version = 'v2', download } = {}) {
  const clock = { t: NOW };
  const messages = [];
  const finished = [];
  const log = {
    info: (msg) => { messages.push(['info', msg]); finished.shift()?.(); },
    warn: (msg) => {
      messages.push(['warn', msg]);
      if (/^\[prueba\] mal/.test(msg)) finished.shift()?.();
    },
  };
  const downloads = [];
  const store = createStationStore({
    cacheFile: pathToFileURL(join(dir, 'estaciones.json')),
    cacheDir: pathToFileURL(`${dir}/`),
    version,
    refreshMs: DAY,
    retryMs: HOUR,
    log,
    now: () => clock.t,
    waitIfEmpty,
    download: async (watched) => {
      downloads.push(clock.t);
      return download ? download(watched) : [{ code: 'a', name: 'Recién descargada', lat: 40, lon: -3 }];
    },
    saved: (count) => `[prueba] ${count} estaciones`,
    failed: (err, count) => `[prueba] mal (${err.message}); ${count} en caché`,
  });
  // Se cumple cuando la renovación en segundo plano apunta su resultado en el registro.
  const rebuilt = () => new Promise((resolve) => finished.push(resolve));
  return { store, clock, messages, downloads, rebuilt };
}

test('sin copia guardada: con waitIfEmpty se espera a la descarga; sin él, se rehace detrás', async (t) => {
  const dir = await tempDir(t);
  const waits = makeStore(dir, { waitIfEmpty: true });
  assert.equal(await waits.store.load(), 1);
  assert.equal(waits.store.stations.get('a').name, 'Recién descargada');
  const saved = JSON.parse(await readFile(join(dir, 'estaciones.json'), 'utf8'));
  assert.deepEqual(saved, { version: 'v2', savedAt: NOW, stations: [{ code: 'a', name: 'Recién descargada', lat: 40, lon: -3 }] });

  const dir2 = await tempDir(t);
  const behind = makeStore(dir2);
  const done = behind.rebuilt();
  assert.equal(await behind.store.load(), 0, 'no espera');
  await done;
  assert.equal(behind.store.stations.size, 1);
});

test('una copia de esta versión y de hace menos de un día se usa sin descargar; pasado el día, se renueva detrás', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'estaciones.json'), JSON.stringify({ version: 'v2', savedAt: NOW - 23 * HOUR, stations: [{ code: 'a', name: 'Guardada', lat: 40, lon: -3 }] }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, clock, downloads, rebuilt } = makeStore(dir, { download: async () => { await gate; return [{ code: 'a', name: 'Recién descargada', lat: 40, lon: -3 }]; } });
  assert.equal(await store.load(), 1);
  assert.equal(store.stations.get('a').name, 'Guardada');
  assert.deepEqual(downloads, []);
  clock.t += HOUR;
  const done = rebuilt();
  assert.equal(await store.load(), 1, 'mientras se renueva, la guardada');
  assert.equal(store.stations.get('a').name, 'Guardada');
  release();
  await done;
  assert.deepEqual(downloads, [NOW + HOUR]);
  assert.equal(store.stations.get('a').name, 'Recién descargada');
});

test('una copia de otra versión (o sin versión) se recalcula aunque sea de hoy', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'estaciones.json'), JSON.stringify({ savedAt: NOW, stations: [{ code: 'a', name: 'Sin versión', lat: 40, lon: -3 }] }));
  const { store, downloads, rebuilt } = makeStore(dir);
  const done = rebuilt();
  await store.load();
  await done;
  assert.equal(downloads.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, 'estaciones.json'), 'utf8')).version, 'v2');
});

test('si algo avisa mientras se rehace, se usa lo conseguido y se reintenta a la hora, no al día siguiente', async (t) => {
  const dir = await tempDir(t);
  const { store, clock, downloads, messages, rebuilt } = makeStore(dir, {
    waitIfEmpty: true,
    download: async (log) => {
      log.warn('[prueba] Wikidata no responde');
      return [{ code: 'a', name: 'Sin fotos', lat: 40, lon: -3 }];
    },
  });
  await store.load();
  assert.equal(store.stations.get('a').name, 'Sin fotos');
  assert.deepEqual(messages.map(([level]) => level), ['warn', 'info'], 'el aviso llega al registro de verdad');
  assert.equal(JSON.parse(await readFile(join(dir, 'estaciones.json'), 'utf8')).savedAt, NOW - DAY + HOUR);
  clock.t += HOUR - 1;
  await store.load();
  assert.equal(downloads.length, 1, 'antes de la hora, no');
  clock.t += 1;
  const done = rebuilt();
  await store.load();
  await done;
  assert.equal(downloads.length, 2, 'a la hora, otra vez');
});

test('una descarga vacía o que falla no borra lo que hay y lo apunta en el registro', async (t) => {
  const dir = await tempDir(t);
  let reply = () => [];
  const { store, clock, messages, rebuilt } = makeStore(dir, { waitIfEmpty: true, download: async () => reply() });
  assert.equal(await store.load(), 0);
  assert.deepEqual(messages.at(-1), ['warn', '[prueba] mal (lista vacía); 0 en caché']);

  reply = () => [{ code: 'a', name: 'Buena', lat: 40, lon: -3 }];
  await store.load();
  assert.equal(store.stations.size, 1);

  clock.t += DAY;
  reply = () => { throw new Error('HTTP 503'); };
  const done = rebuilt();
  await store.load();
  await done;
  assert.deepEqual(messages.at(-1), ['warn', '[prueba] mal (HTTP 503); 1 en caché']);
  assert.equal(store.stations.get('a').name, 'Buena');
});

test('mientras se renueva, otra llamada a load() no lanza una segunda descarga', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'estaciones.json'), JSON.stringify({ version: 'v1', savedAt: NOW, stations: [{ code: 'a', name: 'Vieja', lat: 40, lon: -3 }] }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { store, downloads, rebuilt } = makeStore(dir, { download: async () => { await gate; return [{ code: 'a', name: 'Nueva', lat: 40, lon: -3 }]; } });
  const done = rebuilt();
  await store.load();
  await store.load();
  assert.equal(downloads.length, 1);
  release();
  await done;
  assert.equal(store.stations.get('a').name, 'Nueva');
  assert.equal(store.nearest(40.001, -3).station.code, 'a', 'nearest busca en las estaciones del almacén');
});
