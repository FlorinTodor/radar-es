// Lo que falla al cargar una parte (un horario de un grupo, una red de líneas, las fotos de las
// estaciones) se reintenta pronto y sólo esa parte; no se guarda como completo hasta el día siguiente.
// Todo con reloj simulado: no depende de lo rápida que sea la máquina.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { NETWORKS, createGtfsNetworkCatalog } from '../../server/adapters/outbound/network/gtfs-network-catalog.js';
import { RENFE_FILES, createRenfeStationCatalog } from '../../server/adapters/outbound/stations/renfe-station-catalog.js';
import { STATION_NETWORKS, createNetworkStationCatalog } from '../../server/adapters/outbound/stations/network-station-catalog.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-01T11:00:00Z'); // 12:00 en Madrid
const csv = (rows) => strToU8(rows.join('\n'));
const quiet = { info() {}, warn() {} };

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'reintentos-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// Un autobús que de 11:55 a 13:30 va entre dos paradas (sigue circulando en todo el test).
const busGtfs = () => zipSync({
  'agency.txt': csv(['agency_id,agency_name', 'A,Operador']),
  'routes.txt': csv(['route_id,agency_id,route_short_name,route_type', 'L1,A,L1,3']),
  'trips.txt': csv(['route_id,service_id,trip_id', 'L1,S,T1']),
  'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
  'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'A,Alfa,37.0,-6.0', 'B,Beta,37.0,-5.99']),
  'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'T1,11:55:00,11:55:00,A,1', 'T1,13:30:00,13:30:00,B,2']),
});

test('grupo de autobuses: el horario que falla se reintenta a los 10 min, y sólo ese', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = { 1: 0, 2: 0 };
  let napDown = true;
  const nap = {
    gtfs: async (id) => {
      calls[id]++;
      if (id === 2 && napDown) throw new Error('NAP no responde');
      return busGtfs();
    },
    updatedAt: async () => '2026-10-31T00:00:00',
  };
  const source = createGtfsScheduleSource({ nap, http: {}, log: quiet }, {
    id: 'bus-prueba', name: 'Prueba', mode: 'bus',
    feeds: [{ ficheroId: 1, dataset: 1, operator: 'Uno' }, { ficheroId: 2, dataset: 2, operator: 'Dos' }],
  });
  assert.deepEqual((await source.fetch()).vehicles.map((v) => v.operator), ['Uno'], 'mientras, el que sí ha cargado');
  t.mock.timers.tick(9 * MIN);
  await source.fetch();
  assert.deepEqual(calls, { 1: 1, 2: 1 }, 'antes de 10 min no se reintenta');
  napDown = false;
  t.mock.timers.tick(MIN);
  assert.deepEqual((await source.fetch()).vehicles.map((v) => v.operator).sort(), ['Dos', 'Uno']);
  assert.deepEqual(calls, { 1: 1, 2: 2 }, 'sólo el que falló');
  t.mock.timers.tick(30 * MIN);
  await source.fetch();
  assert.deepEqual(calls, { 1: 1, 2: 2 }, 'cargados los dos, ya no se relee hasta el día siguiente');
});

// Una red con una línea, para el catálogo de trazados.
const networkGtfs = () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_long_name,route_type,route_color', 'R1,L1,Una línea,1,2E7D32']),
  'trips.txt': csv(['route_id,service_id,trip_id,shape_id', 'R1,S,T1,sh']),
  'shapes.txt': csv(['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', 'sh,40.40,-3.70,1', 'sh,40.45,-3.65,2']),
});

test('líneas del mapa: las redes que fallan se reintentan en la siguiente recarga, también tras reiniciar', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = await tempDir(t);
  const [[firstId, firstName], [secondId, secondName]] = NETWORKS;
  const down = new Set(NETWORKS.map(([id]) => id).filter((id) => id !== firstId)); // sólo funciona la primera
  const asked = [];
  const nap = {
    enabled: true,
    gtfs: async (id) => { asked.push(id); if (down.has(id)) throw new Error('no disponible'); return networkGtfs(); },
  };
  const cache = { bytes: async () => { throw new Error('sin red'); } }; // el tranvía de Tenerife tampoco
  const make = () => createGtfsNetworkCatalog({ nap, cache, cacheDir: pathToFileURL(`${dir}/`), log: quiet });
  const catalog = make();
  await catalog.load();
  assert.deepEqual(catalog.lines().features.map((f) => f.properties.network), [firstName]);
  const saved = JSON.parse(await readFile(join(dir, 'trazados-red-v3.json'), 'utf8'));
  assert.equal(saved.failed.length, NETWORKS.length, 'apunta las que faltan (y Tenerife)');
  assert.equal(catalog.lines().failed, undefined, 'la lista de fallos no sale en /api/lines');

  // Siguiente recarga: sólo las que fallaron; ahora la segunda funciona.
  down.delete(secondId);
  asked.length = 0;
  t.mock.timers.tick(60 * MIN);
  await catalog.load();
  assert.ok(!asked.includes(firstId), 'la que ya estaba no se rehace');
  assert.deepEqual(catalog.lines().features.map((f) => f.properties.network), [firstName, secondName]);

  // Tras reiniciar, la copia guardada dice qué falta: se reintenta eso, no todo ni nada.
  asked.length = 0;
  await make().load();
  assert.ok(!asked.includes(firstId) && !asked.includes(secondId));
  assert.equal(asked.length, NETWORKS.length - 2);

  // Pasado un día se rehace todo.
  asked.length = 0;
  t.mock.timers.tick(24 * 60 * MIN);
  await catalog.load();
  assert.equal(asked.length, NETWORKS.length);
});

const latin1 = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const STATIONS_CSV = latin1([
  '"CODIGO";"DESCRIPCION";"LATITUD";"LONGITUD";"DIRECION";"CP";"POBLACION";"PROVINCIA";"PAIS";"CERCANIAS";"ANCHO MÉTRICO";"COMUN"',
  '"15211";"OVIEDO";"43.3663577";"-5.8548380";"Calle Uría";"33012";"OVIEDO";"ASTURIAS";"ESPAÑA";"SI";"NO";""',
].join('\r\n'));

test('estaciones: si faltan fotos o fichas (Wikimedia no responde), el catálogo se rehace a la hora, no al día siguiente', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = await tempDir(t);
  let downloads = 0;
  const stops = zipSync({ 'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', '15211,Oviedo,43.3663577,-5.8548380']) });
  const files = { [RENFE_FILES.stations]: STATIONS_CSV, [RENFE_FILES.cercanias]: stops, [RENFE_FILES.largaDistancia]: stops };
  const cache = { bytes: async (url) => {
    if (url === RENFE_FILES.stations) downloads++;
    if (!files[url]) throw new Error('Wikimedia no responde');
    return files[url];
  } };
  let done;
  const log = { info: () => done?.(), warn() {} };
  const rebuilt = () => new Promise((resolve) => { done = resolve; });
  const catalog = createRenfeStationCatalog({ cache, cacheDir: pathToFileURL(`${dir}/`), log });
  await catalog.load(); // sin copia: espera
  assert.equal(downloads, 1);
  t.mock.timers.tick(59 * MIN);
  await catalog.load();
  assert.equal(downloads, 1, 'antes de la hora, no');
  t.mock.timers.tick(MIN);
  const again = rebuilt();
  await catalog.load(); // con copia: se rehace detrás
  await again;
  assert.equal(downloads, 2, 'a la hora, se rehace');
});

test('estaciones de otras redes: si falla una red o Wikimedia, el catálogo se rehace a la hora', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const dir = await tempDir(t);
  const metro = zipSync({
    'routes.txt': csv(['route_id,route_short_name,route_long_name,route_type', 'L1,L1,Línea 1,1']),
    'trips.txt': csv(['route_id,service_id,trip_id', 'L1,S,v1']),
    'stop_times.txt': csv(['trip_id,stop_sequence,stop_id,arrival_time', 'v1,1,a,08:00:00', 'v1,2,b,08:03:00']),
    'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station', 'a,Alfa,41.38,2.17,1,', 'b,Beta,41.39,2.18,1,']),
  });
  let reads = 0;
  const first = STATION_NETWORKS[0].ficheroId;
  const nap = {
    gtfs: async (id) => { if (id === first) reads++; if (id !== first) throw new Error('no disponible'); return metro; },
    updatedAt: async () => null,
  };
  const cache = { bytes: async () => { throw new Error('Wikimedia no responde'); } };
  let done;
  const log = { info: () => done?.(), warn() {} };
  const rebuilt = () => new Promise((resolve) => { done = resolve; });
  const catalog = createNetworkStationCatalog({ nap, cache, cacheDir: pathToFileURL(`${dir}/`), log });
  let again = rebuilt();
  await catalog.load(); // sin copia: se calcula detrás
  await again;
  assert.equal(reads, 1);
  assert.ok(catalog.all().length > 0, 'con lo que sí se ha conseguido');
  t.mock.timers.tick(59 * MIN);
  await catalog.load();
  assert.equal(reads, 1, 'antes de la hora, no');
  t.mock.timers.tick(MIN);
  again = rebuilt();
  await catalog.load();
  await again;
  assert.equal(reads, 2, 'a la hora, se rehace');
});
