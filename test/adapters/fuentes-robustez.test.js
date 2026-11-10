import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlText, lookup } from '../../server/adapters/outbound/sources/parse.js';
import { createInMemorySituation } from '../../server/adapters/outbound/persistence/in-memory-situation.js';
import { createFgcSource } from '../../server/adapters/outbound/sources/fgc.js';
import { vehiclesFromFeed } from '../../server/adapters/outbound/sources/gtfs-rt.js';
import { createMcpHandler } from '../../server/adapters/inbound/mcp/mcp.js';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';
import { makeQuerySituation } from '../../server/application/use-cases/query-situation.js';

test('lookup no devuelve propiedades heredadas aunque la fuente mande «__proto__» o «constructor»', () => {
  const SEVERITY = { high: 'alta' };
  assert.equal(lookup(SEVERITY, 'high'), 'alta');
  assert.equal(lookup(SEVERITY, '__proto__'), undefined);
  assert.equal(lookup(SEVERITY, 'constructor'), undefined);
  assert.equal(lookup(SEVERITY, 'toString'), undefined);
  assert.equal(lookup(SEVERITY, undefined), undefined);
  assert.equal(lookup(SEVERITY, null), undefined);
});

test('el estado público de las fuentes no enseña rutas del servidor ni claves de la URL', () => {
  const situation = createInMemorySituation();
  situation.registerSource({ id: 'a', name: 'A', kind: 'events', interval: 1000, url: 'https://x.example/datos?api_key=SECRETO' }, { enabled: true });
  situation.registerSource({ id: 'b', name: 'B', kind: 'events', interval: 1000, url: 'https://x.example/b.json', page: 'https://datos.example/ficha' }, { enabled: true });
  situation.saveFailure('a', new Error("EACCES: permission denied, open '/app/data/cache/a.zip'"), 1);
  situation.saveFailure('b', new Error('HTTP 500 en https://x.example/app/b.json'), 1);
  const [a, b] = situation.health();
  assert.equal(a.error, "EACCES: permission denied, open '[ruta interna]'");
  assert.doesNotMatch(a.url, /SECRETO/);
  assert.equal(b.error, 'HTTP 500 en https://x.example/app/b.json', 'las URL no se tocan');
  assert.equal(b.url, 'https://datos.example/ficha', 'se enlaza la ficha pública del conjunto si la hay');
});

// ---------- Registros mal formados: la ingesta los deja con su tipo (domain/model.js, typedSourceResult) ----------

const T0 = Date.UTC(2026, 10, 5, 18, 0);

/** Las fuentes, la ingesta, el estado, las consultas y el MCP de verdad, con el reloj en T0. */
async function readAll(sources) {
  const situation = createInMemorySituation();
  for (const s of sources) situation.registerSource(s, { enabled: true });
  const warnings = [];
  const ingest = makeIngestSource({ sources, situation, clock: { now: () => T0 }, log: { warn: (m) => warnings.push(m) } });
  const read = [];
  for (const s of sources) read.push(await ingest(s.id));
  const query = makeQuerySituation({ situation, stations: { all: () => [], get: () => null, nearest: () => null }, network: { lines: () => null }, clock: { now: () => T0 } });
  const mcp = createMcpHandler({ query, now: () => T0 });
  const tool = (name, args = {}) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { situation, query, tool, read, warnings };
}

test('un registro de FGC con valores anidados 10.000 niveles no deja sin directo a todas las fuentes', async () => {
  // JSON.parse lee cualquier profundidad; JSON.stringify no puede volver a escribir unos 4.000 niveles.
  const deepObject = () => JSON.parse(`${'{"k":'.repeat(10_000)}{}${'}'.repeat(10_000)}`);
  const deepList = () => JSON.parse(`${'['.repeat(10_000)}${']'.repeat(10_000)}`);
  const base = { geo_point_2d: { lat: 41.4, lon: 2.14 }, ut: '211', lin: 'S2', origen: 'PC', desti: 'SC', estacionat_a: 'GR', en_hora: 'True' };
  const results = [
    base,
    { ...base, ut: '212', lin: deepObject() },
    { ...base, ut: deepObject(), id: 'x' },
    { ...base, ut: '214', origen: deepObject(), desti: deepObject(), estacionat_a: deepObject() },
    { ...base, ut: '215', geo_point_2d: { lat: 41.4, lon: deepList() } },
    { ...base, ut: '216', lin: 8 },
    { ...base, ut: '217', lin: ['S8'] },
  ];
  const fgc = createFgcSource({ http: { json: async () => ({ results }) }, nap: { enabled: false } });
  const other = { id: 'renfe-ld', kind: 'vehicles', fetch: async () => ({ vehicles: [
    { id: 'renfe-ld:18001', mode: 'md', operator: 'Renfe', service: 'MD', line: 'MD', label: '18001', lat: 40.34, lon: -1.1, delay: 3, destination: 'Teruel' },
  ] }) };
  const { query, tool, read, warnings } = await readAll([fgc, other]);
  assert.deepEqual(read, [true, true]);

  const live = JSON.parse(JSON.stringify(query.live())); // con el valor anidado tal cual, RangeError: /api/live en 500
  const byId = new Map(live.vehicles.map((v) => [v.id, v]));
  assert.deepEqual(byId.get('fgc:211'), { ...byId.get('fgc:211'), line: 'S2', label: '211', origin: 'PC', destination: 'SC', current: 'GR' }, 'el registro bueno, igual');
  assert.deepEqual([byId.get('fgc:212').line, byId.get('fgc:212').label], [null, '212']);
  assert.equal(byId.get('fgc:[object Object]').label, null);
  assert.deepEqual(['origin', 'destination', 'current'].map((k) => byId.get('fgc:214')[k]), [null, null, null]);
  assert.equal(byId.has('fgc:215'), false, 'sin una longitud numérica, el vehículo se descarta');
  assert.equal(byId.get('fgc:216').line, '8', 'un número, como texto (el mapa llama a line.startsWith)');
  assert.equal(byId.get('fgc:217').line, null);
  assert.ok(byId.has('renfe-ld:18001'), 'las demás fuentes siguen en el directo');
  for (const v of live.vehicles) for (const k of ['line', 'label', 'origin', 'destination', 'current']) assert.ok((v[k] ?? null) === null || typeof v[k] === 'string', `${v.id}.${k}`);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[fgc\] 1 registros mal formados/);

  for (const args of [{ mode: 'cercanias' }, { text: 'teruel' }, { text: 'S2' }]) {
    const reply = tool('buscar_trenes', args);
    assert.equal(reply.result.isError, undefined, JSON.stringify(args));
    assert.doesNotThrow(() => JSON.stringify(reply));
  }
});

test('instantes fuera de rango (GTFS-RT, avisos): null al guardarlos; el MCP sigue respondiendo y el end de un vehículo no se toca', async () => {
  // 9e15 s → 9e18 ms y 1e16 ms: números finitos, pero new Date(ms).toISOString() lanza RangeError.
  const feed = { header: { timestamp: 1e13 }, entity: [
    { id: 'e1', vehicle: { vehicle: { id: '501', label: '501' }, trip: { routeId: 'L1' }, position: { latitude: 41.65, longitude: -4.72 }, timestamp: 9e15 } },
    { id: 'e2', vehicle: { vehicle: { id: '502', label: '502' }, trip: { routeId: 'L2' }, position: { latitude: 41.66, longitude: -4.73 }, timestamp: T0 / 1000 - 30 } },
  ] };
  const auvasa = { id: 'auvasa', kind: 'vehicles', fetch: async () => ({
    vehicles: vehiclesFromFeed(feed, { id: 'auvasa', mode: 'bus', operator: 'AUVASA', now: T0 }), sourceTime: feed.header.timestamp * 1000,
  }) };
  const cercanias = { id: 'renfe-cercanias', kind: 'vehicles', fetch: async () => ({ vehicles: [
    { id: 'renfe-c:23456', mode: 'cercanias', operator: 'Renfe', line: 'C3', label: '23456', lat: 40.4, lon: -3.69, delay: 0, end: [-3.6372, 40.5373], fixTime: 1e16 },
  ], sourceTime: T0 - 20_000 }) };
  const emt = { id: 'emt-madrid', kind: 'events', fetch: async () => ({ events: [
    { id: 'emt-madrid:a1', category: 'carretera', type: 'aviso', severity: 'alta', title: 'EMT Madrid · Desvío', lat: 40.41, lon: -3.7, start: T0 - 3600_000, end: 1e16, issued: 9e18, updated: -1e17 },
  ], sourceTime: 9e18 }) };
  const { situation, tool } = await readAll([auvasa, cercanias, emt]);

  const vehicles = new Map(situation.vehicles().map((v) => [v.id, v]));
  assert.equal(vehicles.get('auvasa:501').fixTime, null);
  assert.equal(vehicles.get('auvasa:502').fixTime, T0 - 30_000, 'uno creíble, igual');
  assert.equal(vehicles.get('renfe-c:23456').fixTime, null);
  assert.deepEqual(vehicles.get('renfe-c:23456').end, [-3.6372, 40.5373], 'el end de un vehículo es su destino [lon, lat], no un instante');
  const [e] = situation.events();
  assert.deepEqual([e.start, e.end, e.issued, e.updated], [T0 - 3600_000, null, null, null]);
  assert.deepEqual(situation.health().map((h) => [h.id, h.sourceTime]), [['auvasa', null], ['renfe-cercanias', T0 - 20_000], ['emt-madrid', null]]);

  for (const [name, args] of [['buscar_trenes', { text: 'auvasa' }], ['buscar_trenes', { mode: 'cercanias' }], ['incidencias', {}], ['estado_fuentes', {}]]) {
    const reply = tool(name, args); // con los instantes tal cual, iso() lanzaba «Invalid time value»
    assert.ok(reply.result && !reply.result.isError, `${name} ${JSON.stringify(args)}`);
  }
});

test('htmlText con «<», «<!--» o «<script» sin cerrar a miles: termina y no se come el texto normal', () => {
  // Antes, cada apertura sin cerrar volvía a recorrer el resto del texto (cuadrático): con estos ~200 KB
  // tardaba segundos, y con los MB de un feed, horas. Ahora una etiqueta empieza por «<» + letra, «/», «!» o
  // «?», y un comentario o un script sin cerrar llegan hasta el final, como en un navegador.
  assert.equal(htmlText('<!--'.repeat(50_000)), '');
  assert.equal(htmlText('<script'.repeat(30_000)), '');
  assert.equal(htmlText('<a'.repeat(100_000)), '');
  assert.equal(htmlText(`Aviso${'<'.repeat(200_000)}`), `Aviso${'<'.repeat(200_000)}`);
  // Con HTML normal, lo mismo que antes.
  assert.equal(htmlText('Temperaturas < 0 ºC en cumbres'), 'Temperaturas < 0 ºC en cumbres');
  assert.equal(htmlText('<p>Aviso por <b>lluvias</b> en <a href="https://x.invalid/a">Gran Canaria</a>.</p><p>Segundo</p>'), 'Aviso por lluvias en Gran Canaria .\nSegundo');
  assert.equal(htmlText('<!-- c -->texto<script>var a=1<2;</script> fin'), 'texto fin');
  assert.equal(htmlText('<STYLE>p{}</STYLE><h2>Título</h2><ul><li>uno</li><li>dos</li></ul><BR/>y'), 'Título\nuno\ndos\ny');
  assert.equal(htmlText('<?xml version="1.0"?><!DOCTYPE html>Lluvias &lt;b&gt;fuertes&lt;/b&gt; &amp;oacute;'), 'Lluvias <b>fuertes</b> ó');
});
