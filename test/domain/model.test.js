import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStationCode, plainText, plausibleDelay, plausibleTime, safeLink, typedSourceResult } from '../../server/domain/model.js';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';

test('safeLink sólo deja pasar enlaces http(s)', () => {
  assert.equal(safeLink('https://www.aemet.es/es/eltiempo/prediccion/avisos'), 'https://www.aemet.es/es/eltiempo/prediccion/avisos');
  assert.equal(safeLink(' http://www.gdacs.org/report.aspx?eventid=1 '), 'http://www.gdacs.org/report.aspx?eventid=1');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeLink('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeLink('/relativo'), null);
  assert.equal(safeLink(''), null);
  assert.equal(safeLink(undefined), null);
  assert.equal(safeLink({ href: 'https://x' }), null);
});

test('plausibleDelay descarta los retrasos imposibles que Renfe publica al cambiar de día', () => {
  assert.equal(plausibleDelay(0), 0);
  assert.equal(plausibleDelay(-5), -5, 'un poco de adelanto es normal');
  assert.equal(plausibleDelay(240), 240, 'cuatro horas de retraso pueden pasar');
  assert.equal(plausibleDelay(-60), -60);
  assert.equal(plausibleDelay(720), 720);
  assert.equal(plausibleDelay(-1436), null, '-86.160 s: retraso contra el horario del día siguiente');
  assert.equal(plausibleDelay(1008), null);
  assert.equal(plausibleDelay(-61), null);
  assert.equal(plausibleDelay(NaN), null);
  assert.equal(plausibleDelay(null), null);
});

test('isStationCode: 5 cifras de Renfe o «red:código» de las demás redes', () => {
  for (const ok of ['71801', '15211', 'fgc:PC', 'tmb:P.6660111', 'emt:1:2', `fgc:${'a'.repeat(64)}`]) {
    assert.equal(isStationCode(ok), true, ok);
  }
  for (const bad of ['1521', '152111', 'abcde', 'FGC:PC', 'fgc:', ':PC', 'fgc:a/b', 'fgc:a b', '../x', `fgc:${'a'.repeat(65)}`,
    '71801\n', ' 71801', '', null, undefined, 71801]) {
    assert.equal(isStationCode(bad), false, String(bad));
  }
});

test('la ingesta guarda sin retraso los vehículos con un retraso imposible', async () => {
  let saved;
  const vehicles = [{ id: 'a', delay: -1436, lat: 40, lon: -3 }, { id: 'b', delay: 4, lat: 40, lon: -3 }, { id: 'c', delay: null, lat: 40, lon: -3 }];
  const ingest = makeIngestSource({
    sources: [{ id: 'renfe-cercanias', fetch: async () => ({ vehicles }) }],
    situation: { saveResult: (id, result) => { saved = result; }, updateTracks: (update) => update(new Map()), saveFailure() {} },
    clock: { now: () => 1000 }, log: { warn() {} },
  });
  await ingest('renfe-cercanias');
  assert.deepEqual(saved.vehicles.map((v) => v.delay), [null, 4, null]);
});

// ---------- Lo que llega de las fuentes: cada campo con su tipo ----------

const NOW = Date.UTC(2026, 10, 5, 18, 0);
const nest = (levels, leaf = {}) => { let v = leaf; for (let i = 0; i < levels; i++) v = { k: v }; return v; };

test('plainText: un texto (recortado) o un número como texto; lo demás, null', () => {
  assert.equal(plainText('S2'), 'S2');
  assert.equal(plainText(''), '');
  assert.equal(plainText(8), '8');
  for (const bad of [NaN, Infinity, true, ['S8'], { k: 'S8' }, () => 'S8', Symbol('x'), 10n]) assert.equal(plainText(bad), null, String(typeof bad));
  const long = plainText('x'.repeat(10_000));
  assert.equal(long.length, 1000);
  assert.match(long, /^x+…$/);
  assert.equal(plainText('x'.repeat(30), 10), `${'x'.repeat(9)}…`);
});

test('plausibleTime: del año 2000 a diez años por delante; lo demás (y lo que Date no admite), null', () => {
  assert.equal(plausibleTime(NOW, NOW), NOW);
  assert.equal(plausibleTime(Date.UTC(2000, 0, 1), NOW), Date.UTC(2000, 0, 1));
  assert.equal(plausibleTime(Date.UTC(2035, 0, 1), NOW), Date.UTC(2035, 0, 1), 'el fin de unas obras dentro de unos años');
  for (const bad of [Date.UTC(1999, 11, 31), 1000, 0, -1e17, 1e13, 1e16, 9e18, NaN, Infinity, '2026-11-05', null]) {
    assert.equal(plausibleTime(bad, NOW), null, String(bad));
  }
});

test('typedSourceResult: los registros normales pasan igual, sin tocar lo que devolvió la fuente', () => {
  const vehicle = { id: 'renfe-c:23456', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C3', label: '23456', lat: 40.4, lon: -3.69,
    delay: 2, origin: 'Aranjuez', destination: 'El Escorial', current: null, next: 'Atocha', nextEta: '2026-11-05T19:03:00', platform: '4', area: 'Madrid',
    shape: '10_C3', end: [-4.12, 40.58], fixTime: NOW - 20_000, stopped: false, ahead: true, stops: true, farFromStop: 2.1 };
  const event = { id: 'aemet:1:0', category: 'meteo', type: 'tormentas', level: 'amarillo', severity: 'media', title: 'Aviso amarillo por tormentas · Litoral',
    description: 'Tormentas con granizo.', area: 'Litoral', lat: 39.4, lon: -0.4, issued: NOW - 3600_000, start: NOW, end: NOW + 3600_000,
    geometry: { type: 'MultiPolygon', coordinates: [[[[-0.5, 39.3], [-0.3, 39.3], [-0.3, 39.5], [-0.5, 39.3]]]] }, url: 'https://www.aemet.es/x' };
  const cancelled = { id: 'renfe-cancelado:1', category: 'cancelacion', type: 'cancelado', severity: 'media', title: 'C3 23456 cancelado', lat: null, lon: null,
    seen: NOW - 60_000, expires: NOW + 3600_000, trip: { operator: 'Renfe', stops: [{ name: 'Aranjuez', time: '18:40', lat: 40.03, lon: -3.6 }], lineNotices: [{ text: 'Obras.' }] } };
  const input = { vehicles: [vehicle], events: [event, cancelled], sourceTime: NOW - 5000, datasetUpdated: NOW - 86_400_000, datasetUpdatedBy: { AMB: NOW - 86_400_000 } };
  const before = structuredClone(input);
  const { result, dropped } = typedSourceResult(input, NOW);
  assert.equal(dropped, 0);
  assert.deepEqual(result, before);
  assert.deepEqual(input, before, 'devuelve una copia');
  assert.notEqual(result.vehicles[0], vehicle);
});

test('typedSourceResult: textos que no lo son, valores anidados, posiciones y ids que no valen', () => {
  const deep = JSON.parse(`${'['.repeat(10_000)}${']'.repeat(10_000)}`); // JSON.stringify no puede volver a escribirlo
  const ok = { mode: 'cercanias', lat: 41.4, lon: 2.14 };
  const { result, dropped } = typedSourceResult({ vehicles: [
    { ...ok, id: 'fgc:1', line: 8, label: nest(10_000), origin: deep, destination: true, rollingStock: 'x'.repeat(2000), extra: nest(40), end: [2.1, 'x'] },
    { ...ok, id: 'fgc:2', lon: deep },
    { ...ok, id: 'fgc:3', lon: '2.14' },
    { ...ok, id: 'fgc:4', lat: 95 },
    { ...ok, id: 'fgc:5', lat: null },
    { ...ok, id: nest(3) },
    { ...ok },
    { ...ok, id: 'x'.repeat(1001) },
    { ...ok, id: 7, end: [2.2, 41.5], extra: nest(5) },
    null,
    'fgc:6',
  ], events: [
    { id: 'e1', title: 'Corte', lat: deep, lon: 2, description: 'd'.repeat(30_000), credit: 'c'.repeat(600), type: { a: 1 }, url: 'javascript:alert(1)', geometry: nest(40) },
    { id: 'e2', title: nest(10), lat: 40, lon: -3 },
    { id: 'e3', title: 12, lat: 40, lon: -3, lat2: 40.1, lon2: Infinity },
    { id: 'e4' },
  ] }, NOW);
  assert.equal(dropped, 10, 'los vehículos sin posición válida o sin id, y el suceso con un título que no es texto');
  assert.doesNotThrow(() => JSON.stringify(result));
  const [v1, v7] = result.vehicles;
  assert.deepEqual([v1.line, v1.label, v1.origin, v1.destination, v1.end], ['8', null, null, null, null]);
  assert.equal(v1.rollingStock.length, 1000);
  assert.equal('extra' in v1, false, 'un campo que anida más de lo que admiten las rutas, fuera');
  assert.deepEqual([v7.id, v7.end, v7.extra], ['7', [2.2, 41.5], nest(5)], 'lo que anida poco sí se queda');
  const [e1, e3, e4] = result.events;
  assert.deepEqual([e1.lat, e1.lon, e1.type, e1.url, 'geometry' in e1], [null, null, null, null, false]);
  assert.equal(e1.description.length, 20_000);
  assert.equal(e1.credit.length, 600, 'una atribución larga (la de los grupos de autobuses pasa de 500) se queda entera');
  assert.deepEqual([e3.title, e3.lat, e3.lon, e3.lat2, e3.lon2], ['12', 40, -3, null, null]);
  assert.deepEqual(e4, { id: 'e4' }, 'lo que no trae, no se añade');
});

test('typedSourceResult: los instantes fuera de rango, null; el end de un vehículo es un punto y se queda', () => {
  const { result } = typedSourceResult({
    vehicles: [{ id: 'auvasa:1', lat: 41.65, lon: -4.72, fixTime: 9e18, end: [-4.7, 41.6] }, { id: 'auvasa:2', lat: 41.65, lon: -4.72, fixTime: NOW - 30_000 }],
    events: [{ id: 'emt:1', title: 'Desvío', start: 1e16, end: 1e13, issued: -1e17, updated: NOW - 60_000 }],
    sourceTime: 1e16, datasetUpdated: 1000, datasetUpdatedFrom: NOW - 86_400_000, datasetUpdatedBy: { AMB: 9e18, Euskotren: NOW - 86_400_000, Otro: nest(10) },
  }, NOW);
  assert.deepEqual(result.vehicles.map((v) => [v.fixTime, v.end]), [[null, [-4.7, 41.6]], [NOW - 30_000, undefined]]);
  const [e] = result.events;
  assert.deepEqual([e.start, e.end, e.issued, e.updated], [null, null, null, NOW - 60_000]);
  assert.deepEqual([result.sourceTime, result.datasetUpdated, result.datasetUpdatedFrom], [null, null, NOW - 86_400_000]);
  assert.deepEqual(result.datasetUpdatedBy, { Euskotren: NOW - 86_400_000 });
});
