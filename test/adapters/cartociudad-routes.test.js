import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCartoCiudadRoads, decodePolyline, encodePolyline, routeFromResponse, simplify } from '../../server/adapters/outbound/geo/cartociudad-routes.js';

const log = { info() {}, warn() {}, error() {} };
const A = [-0.6984, 38.2669];
const B = [-0.6900, 38.2700];
// Una ruta de A a B como la devuelve CartoCiudad (polilínea con 5 decimales), con un punto intermedio.
const geomAB = encodePolyline([-0.69838, 38.26692, -0.6950, 38.2705, -0.69005, 38.26998]);

test('polilínea: el ejemplo de la documentación de Google, y nuestra codificación de ida y vuelta', () => {
  assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@').map((x) => Math.round(x * 1e5) / 1e5), [-120.2, 38.5, -120.95, 40.7, -126.453, 43.252]);
  const line = [-3.70379, 40.41678, -3.68833, 40.45301];
  assert.deepEqual(decodePolyline(encodePolyline(line)), line);
  assert.throws(() => decodePolyline('_p~iF~ps|U_'), /cortada/);
});

test('simplify: quita lo que casi no se aparta de la recta y deja las curvas', () => {
  const straight = [0, 40, 0.0001, 40.0001, 0.0002, 40.0002, 0.001, 40.001];
  assert.deepEqual(simplify(straight, 15), [0, 40, 0.001, 40.001]);
  const bent = [0, 40, 0.0005, 40.002, 0.001, 40];
  assert.equal(simplify(bent, 15).length, 6);
});

test('respuesta de CartoCiudad: vale si empieza y acaba cerca de las paradas y no da una vuelta enorme', () => {
  const road = routeFromResponse({ found: 'true', geom: geomAB }, A, B);
  assert.deepEqual([road[0], road[1]].map((x) => +x.toFixed(4)), A, 'empieza en la parada');
  assert.deepEqual([...road.slice(-2)].map((x) => +x.toFixed(4)), B, 'y acaba en la otra');
  assert.equal(routeFromResponse({ found: 'false' }, A, B), null);
  assert.equal(routeFromResponse({ found: 'true', geom: geomAB }, A, [-0.6, 38.3]), null, 'acaba lejos de la parada');
  const loop = encodePolyline([-0.69838, 38.26692, -0.5, 38.5, -0.69005, 38.26998]);
  assert.equal(routeFromResponse({ found: 'true', geom: loop }, A, B), null, 'una vuelta de 60 km para un tramo de 800 m');
  assert.equal(routeFromResponse({ found: 'true', geom: '~' }, A, B), null, 'polilínea rota');
});

/** Un cliente HTTP de prueba: responde con lo que diga `reply` y apunta lo que se le pide. */
function fakeHttp(reply) {
  const asked = [];
  return { asked, json: async (url) => { asked.push(url); return reply(url); } };
}

test('pide un tramo cada vez, con su separación mínima, y lo guarda; uno sin ruta queda como sin carretera', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-carreteras-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const http = fakeHttp((url) => (url.includes(`dest=${B[1]},${B[0]}`) ? { found: 'true', geom: geomAB } : { found: 'false' }));
  const roads = createCartoCiudadRoads({ http, dir: pathToFileURL(`${dir}/`), log, now: () => clock, minGapMs: 1000 });
  assert.equal(roads.segment(A, B), undefined, 'aún no se sabe: se pide');
  assert.equal(roads.segment(B, A), undefined);
  assert.equal(roads.segment(A, B), undefined, 'pedirlo otra vez no lo duplica');
  assert.deepEqual(roads.stats(), { known: 0, failed: 0, pending: 2 });
  assert.equal(await roads.pump(), true);
  assert.equal(await roads.pump(), false, 'antes de un segundo no pide el siguiente');
  clock += 1000;
  assert.equal(await roads.pump(), true);
  assert.equal(http.asked.length, 2);
  assert.match(http.asked[0], /orig=38\.2669,-0\.6984&dest=38\.27,-0\.69&locale=es&vehicle=CAR/);
  assert.ok(roads.segment(A, B) instanceof Float32Array);
  assert.equal(roads.segment(B, A), null, 'sin ruta');
  assert.equal(roads.version(), 1);

  await roads.save();
  const again = createCartoCiudadRoads({ http: fakeHttp(() => assert.fail('no debe pedir nada')), dir: pathToFileURL(`${dir}/`), log, now: () => clock });
  await again.load();
  assert.deepEqual([...again.segment(A, B)].map((x) => +x.toFixed(4)), [...roads.segment(A, B)].map((x) => +x.toFixed(4)));
  assert.equal(again.segment(B, A), null, 'también se recuerda que no tenía ruta');
  // Pasada una semana, el que no tenía ruta se vuelve a pedir.
  clock += 8 * 24 * 3600_000;
  assert.equal(again.segment(B, A), undefined);
});

test('si CartoCiudad no responde, el tramo se queda y se espera cada vez más antes de volver a pedir', async () => {
  let clock = 0;
  let down = true;
  const http = { json: async () => { if (down) throw new Error('ECONNRESET'); return { found: 'true', geom: geomAB }; } };
  const warned = [];
  const roads = createCartoCiudadRoads({ http, dir: pathToFileURL('/nonexistent/'), log: { ...log, warn: (m) => warned.push(m) }, now: () => clock, minGapMs: 0 });
  roads.segment(A, B);
  assert.equal(await roads.pump(), false);
  assert.equal(roads.stats().pending, 1, 'el tramo sigue pendiente');
  assert.equal(warned.length, 1);
  clock += 30_000;
  assert.equal(await roads.pump(), false, 'antes de un minuto, nada');
  clock += 31_000;
  await roads.pump(); // segundo fallo: ahora espera dos minutos
  clock += 61_000;
  assert.equal(await roads.pump(), false);
  down = false;
  clock += 61_000;
  assert.equal(await roads.pump(), true);
  assert.ok(roads.segment(A, B));
});

test('guardar sin cambios no escribe, y un fallo al escribir no lanza', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-carreteras-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'fichero'), 'x'); // una carpeta dentro de un fichero: no se puede crear (ENOTDIR)
  const warned = [];
  const roads = createCartoCiudadRoads({ http: fakeHttp(() => ({ found: 'true', geom: geomAB })), dir: pathToFileURL(`${dir}/fichero/carpeta/`), log: { ...log, warn: (m) => warned.push(m) }, minGapMs: 0 });
  await roads.save();
  assert.equal(warned.length, 0);
  roads.segment(A, B);
  await roads.pump();
  await roads.save();
  assert.equal(warned.length, 1);
});
