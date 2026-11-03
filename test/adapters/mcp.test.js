// Servidor MCP: el protocolo (JSON-RPC sin estado), cada herramienta con su atribución y la ruta POST /mcp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpHandler, McpBusy, PROTOCOL_VERSIONS } from '../../server/adapters/inbound/mcp/mcp.js';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

const T = Date.UTC(2026, 10, 3, 9, 0);
const vehicles = [
  { id: 'renfe-ld:03123', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'AVE', line: null, label: '3123', lat: 40.4, lon: -3.7,
    delay: 12, origin: 'Madrid-Puerta de Atocha', destination: 'Valencia-Joaquín Sorolla', next: 'Cuenca-Fernando Zóbel', nextEta: '2026-11-03T10:05' },
  { id: 'renfe-cercanias:C5-1', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', line: 'C-5', label: '25012', lat: 40.3, lon: -3.8,
    delay: 0, stopped: true, current: 'Móstoles', platform: '2' },
  { id: 'fgc:L6-9', source: 'fgc', mode: 'otros', operator: 'FGC', line: 'L6', label: 'L6', lat: 41.4, lon: 2.1, delay: null, estimated: true },
];
const events = [
  { id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'media', title: 'Accidente en la A-3', area: 'Cuenca', lat: 40, lon: -2, start: T - 3600_000 },
  { id: 'aemet:1', source: 'aemet', category: 'meteo', type: 'lluvia', severity: 'alta', level: 'naranja', title: 'Lluvias fuertes', area: 'Valencia', lat: 39.4, lon: -0.4 },
  { id: 'dgt:obra', source: 'dgt', category: 'carretera', type: 'roadMaintenance', severity: 'muy alta', title: 'Obras · A-6 km 9', lat: 40.4, lon: -3.8 },
  { id: 'renfe-avisos:1', source: 'renfe-avisos', category: 'ferroviario', type: 'aviso', severity: 'baja', title: 'Ascensor fuera de servicio', lat: 40.3, lon: -3.8 },
];
const health = [
  { id: 'renfe-ld', name: 'Renfe AV/LD/MD', kind: 'vehicles', enabled: true, ok: true, license: 'Origen de los datos: Renfe Operadora', url: 'https://data.renfe.com', lastOk: T },
  { id: 'renfe-cercanias', name: 'Renfe Cercanías', kind: 'vehicles', enabled: true, ok: true, license: 'Origen de los datos: Renfe Operadora', lastOk: T },
  { id: 'fgc', name: 'FGC', kind: 'vehicles', enabled: true, ok: false, error: 'HTTP 500', license: 'Font: FGC', lastOk: T - 600_000 },
  { id: 'dgt', name: 'DGT', kind: 'events', enabled: true, ok: true, license: 'Fuente: DGT', lastOk: T },
  { id: 'aemet', name: 'AEMET', kind: 'events', enabled: false, reason: 'Falta AEMET_API_KEY en .env', license: '© AEMET', lastOk: null },
  { id: 'renfe-avisos', name: 'Avisos de Renfe', kind: 'events', enabled: true, ok: true, license: 'Origen de los datos: Renfe Operadora', lastOk: T },
];
const stations = [
  { code: '35400', name: 'Móstoles', place: 'Móstoles', province: 'Madrid', lat: 40.3, lon: -3.8, cercanias: true },
  { code: '35401', name: 'Móstoles-El Soto', place: 'Móstoles', province: 'Madrid', lat: 40.31, lon: -3.88, cercanias: true },
  { code: 'fgc:PC', name: 'Plaça Catalunya', place: 'Barcelona', province: 'Barcelona', lat: 41.38, lon: 2.17, network: 'FGC', networkId: 'fgc', mode: 'otros' },
];
const query = {
  vehicles: ({ mode, minDelay } = {}) => vehicles.filter((v) => (!mode || v.mode === mode) && (minDelay === undefined || (v.delay ?? -1) >= minDelay)),
  events: ({ category } = {}) => events.filter((e) => !category || e.category === category),
  alerts: () => [{ id: 'a1', type: 'delay', severity: 'alta', title: 'AVE 3123 con 12 min', description: 'x', vehicleId: 'renfe-ld:03123', since: T }],
  health: () => health,
  metrics: () => ({}),
  kpis: () => ({ current: { vehicles: 3, byMode: { av: 1, cercanias: 1, otros: 1 }, delayed: 1, withDelayInfo: 2, medianDelay: 6, maxDelay: 12 }, history: [] }),
  stations: () => stations,
  station: (code) => stations.find((s) => s.code === code) ?? null,
};
const mcp = createMcpHandler({ query, about: { publicUrl: 'https://example.test' }, version: '9.9.9', now: () => T });
const call = (name, args = {}) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).result;

test('initialize: acepta la versión del cliente si la conoce; si no, ofrece la más reciente', () => {
  const ok = mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(ok.result.protocolVersion, '2025-06-18');
  assert.deepEqual(ok.result.capabilities, { tools: { listChanged: false } });
  assert.equal(ok.result.serverInfo.version, '9.9.9');
  const other = mcp({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(other.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('notificaciones sin respuesta; método desconocido y mensaje roto con su error JSON-RPC', () => {
  assert.equal(mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(mcp({ jsonrpc: '2.0', id: 3, method: 'resources/list' }).error.code, -32601);
  assert.equal(mcp({ jsonrpc: '2.0', id: 4, method: 'toString' }).error.code, -32601);
  assert.equal(mcp({ id: 5, method: 'ping' }).error.code, -32600);
  assert.equal(mcp([]).error.code, -32600);
  assert.deepEqual(mcp({ jsonrpc: '2.0', id: 6, method: 'ping' }).result, {});
});

test('tools/list: todas de sólo lectura, con su esquema de argumentos', () => {
  const { tools } = mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result;
  assert.deepEqual(tools.map((t) => t.name), ['buscar_trenes', 'buscar_estaciones', 'estacion', 'incidencias', 'alertas', 'resumen', 'estado_fuentes']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
  }
});

test('argumentos fuera de esquema y herramientas que no existen: error de parámetros', () => {
  const bad = (name, args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).error?.code;
  assert.equal(bad('buscar_trenes', { mode: 'avion' }), -32602);
  assert.equal(bad('buscar_trenes', { minDelay: -5 }), -32602);
  assert.equal(bad('buscar_trenes', { limit: 1000 }), -32602);
  assert.equal(bad('buscar_trenes', { text: 'x'.repeat(500) }), -32602);
  assert.equal(bad('buscar_trenes', { otro: 1 }), -32602);
  assert.equal(bad('buscar_estaciones', {}), -32602);
  assert.equal(bad('borrar_todo', {}), -32602);
  assert.equal(bad('constructor', {}), -32602);
});

test('buscar_trenes: por número, sin tildes, y con la atribución de su fuente', () => {
  const r = call('buscar_trenes', { text: 'valencia sorolla' });
  assert.equal(r.structuredContent.total, 1);
  const [v] = r.structuredContent.vehicles;
  assert.equal(v.label, '3123');
  assert.equal(v.delay, 12);
  assert.deepEqual(r.structuredContent.sources, [{ source: 'renfe-ld', name: 'Renfe AV/LD/MD', attribution: 'Origen de los datos: Renfe Operadora', url: 'https://data.renfe.com', updatedAt: new Date(T).toISOString() }]);
  assert.match(r.structuredContent.note, /no es una web oficial/);
  assert.equal(r.structuredContent.moreInfo, 'https://example.test/legal#fuentes');
  assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
});

test('buscar_trenes: retraso mínimo y tipo; los de más retraso primero; límite', () => {
  assert.deepEqual(call('buscar_trenes', { minDelay: 5 }).structuredContent.vehicles.map((v) => v.label), ['3123']);
  assert.deepEqual(call('buscar_trenes', { mode: 'cercanias' }).structuredContent.vehicles.map((v) => v.line), ['C-5']);
  const all = call('buscar_trenes', { limit: 2 }).structuredContent;
  assert.equal(all.total, 3);
  assert.deepEqual(all.vehicles.map((v) => v.label), ['3123', '25012']);
  assert.equal(call('buscar_trenes', { text: 'L6' }).structuredContent.vehicles[0].estimated, true);
});

test('buscar_estaciones: primero el nombre exacto, también por población', () => {
  assert.deepEqual(call('buscar_estaciones', { text: 'mostoles' }).structuredContent.stations.map((s) => s.code), ['35400', '35401']);
  const bcn = call('buscar_estaciones', { text: 'Barcelona' }).structuredContent.stations;
  assert.deepEqual(bcn.map((s) => [s.code, s.network]), [['fgc:PC', 'FGC']]);
});

test('estacion: trenes parados y avisos de Renfe; código desconocido, error que el modelo puede leer', () => {
  const r = call('estacion', { code: '35400' }).structuredContent;
  assert.equal(r.station.name, 'Móstoles');
  assert.deepEqual(r.stopped.map((v) => [v.line, v.platform]), [['C-5', '2']]);
  assert.deepEqual(r.notices.map((e) => e.title), ['Ascensor fuera de servicio']);
  assert.deepEqual(r.sources.map((s) => s.source).sort(), ['renfe-avisos', 'renfe-cercanias']);
  for (const code of ['99999', '../etc']) {
    const missing = call('estacion', { code });
    assert.equal(missing.isError, true, code);
    assert.match(missing.content[0].text, /buscar_estaciones/);
  }
});

test('incidencias: las obras en carretera, sólo si se piden (como en el mapa)', () => {
  assert.ok(!call('incidencias').structuredContent.events.some((e) => e.id === 'dgt:obra'));
  assert.deepEqual(call('incidencias', { roadWorks: true, limit: 1 }).structuredContent.events.map((e) => e.id), ['dgt:obra']);
  assert.equal(mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'incidencias', arguments: { roadWorks: 'sí' } } }).error.code, -32602);
});

test('incidencias: de más a menos grave, por categoría, texto y gravedad mínima', () => {
  assert.deepEqual(call('incidencias').structuredContent.events.map((e) => e.id), ['aemet:1', 'dgt:1', 'renfe-avisos:1']);
  assert.deepEqual(call('incidencias', { category: 'carretera' }).structuredContent.events.map((e) => e.id), ['dgt:1']);
  assert.deepEqual(call('incidencias', { text: 'cuenca' }).structuredContent.events.map((e) => e.id), ['dgt:1']);
  assert.deepEqual(call('incidencias', { minSeverity: 'alta' }).structuredContent.events.map((e) => e.id), ['aemet:1']);
  assert.equal(call('incidencias', { category: 'carretera' }).structuredContent.events[0].start, new Date(T - 3600_000).toISOString());
});

test('alertas, resumen y estado de las fuentes', () => {
  assert.equal(call('alertas').structuredContent.alerts[0].vehicles, 1);
  const r = call('resumen').structuredContent;
  assert.equal(r.delayedAtLeast5Min, 1);
  assert.equal(r.activeAlerts, 1);
  assert.equal(r.sourcesOk, 4);
  assert.equal(r.sourcesEnabled, 5);
  const fuentes = call('estado_fuentes').structuredContent.sources;
  assert.equal(fuentes.find((s) => s.id === 'aemet').reason, 'Falta AEMET_API_KEY en .env');
  assert.equal(fuentes.find((s) => s.id === 'fgc').attribution, 'Font: FGC');
});

test('las respuestas se guardan el ttl de su herramienta; el texto sin tildes ni mayúsculas comparte copia', () => {
  let t = T;
  let reads = 0;
  const counted = { ...query, vehicles: (f) => { reads++; return query.vehicles(f); } };
  const cached = createMcpHandler({ query: counted, now: () => t });
  const ask = (args) => cached({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'buscar_trenes', arguments: args } }).result;
  const first = ask({ text: 'Valencia', limit: 5 });
  assert.deepEqual(ask({ limit: 5, text: 'valéncia' }), first);
  assert.equal(reads, 1);
  ask({ text: 'Valencia', limit: 6 });
  assert.equal(reads, 2);
  t += 5_000; // ttl de buscar_trenes
  ask({ text: 'Valencia', limit: 5 });
  assert.equal(reads, 3);
});

test('presupuesto: sólo lo gasta lo que hay que calcular; sin fichas, McpBusy; un error de la herramienta lo devuelve', () => {
  let tokens = 1;
  let refunds = 0;
  const budget = { take: () => (tokens > 0 ? (tokens--, true) : false), refund: () => { tokens++; refunds++; } };
  const fresh = createMcpHandler({ query, now: () => T });
  const ask = (name, args) => fresh({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { budget });
  assert.equal(ask('estacion', { code: '99999' }).result.isError, true);
  assert.equal(refunds, 1);
  ask('alertas', {});
  assert.equal(tokens, 0);
  ask('alertas', {}); // guardada
  assert.deepEqual(fresh({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { budget }).result.tools.length, 7);
  assert.throws(() => ask('resumen', {}), McpBusy);
});

// ---------- POST /mcp ----------

let server;
let base;
let clock = T;
before(async () => {
  server = createHttpServer({ query, mcp, log: { error() {}, info() {}, warn() {} }, publicDir: '/nonexistent', vendorDirs: {}, now: () => clock });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (body, headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('POST /mcp: responde en JSON, sin caché ni indexar; una notificación, 202 vacío', async () => {
  const res = await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'buscar_trenes', arguments: { text: '3123' } } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
  const body = await res.json();
  assert.equal(body.id, 7);
  assert.equal(body.result.structuredContent.vehicles[0].label, '3123');

  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');
});

test('/mcp: GET 405; JSON roto, tipo de contenido o versión del protocolo que no son, error', async () => {
  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await post('{no es json')).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
});

test('/mcp: mensaje demasiado grande, 413; las demás rutas siguen sin aceptar POST', async () => {
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { relleno: 'x'.repeat(100_000) } })).status, 413);
  assert.equal((await fetch(`${base}/api/health`, { method: 'POST' })).status, 405);
});

test('/mcp: con el presupuesto gastado, 429 con Retry-After; lo ya guardado y ping siguen; con el tiempo vuelve', async () => {
  clock += 60_000; // cubo lleno
  // Cada límite es una variante nueva que hay que calcular.
  const trains = (limit, id = limit) => post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'buscar_trenes', arguments: { limit } } });
  const statuses = [];
  for (let limit = 1; limit <= 40; limit++) statuses.push((await trains(limit)).status);
  assert.ok(statuses.includes(429));
  const busy = await trains(45);
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '2');
  assert.equal((await busy.json()).id, 45);
  assert.equal((await trains(1, 'otra vez')).status, 200); // ya guardada: no gasta
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' })).status, 200);
  clock += 10_000;
  assert.equal((await trains(50)).status, 200);
});
