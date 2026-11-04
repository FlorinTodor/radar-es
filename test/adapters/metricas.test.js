// Métricas para la monitorización: el formato de Prometheus, lo que cuentan la web, el MCP y las fuentes,
// que no digan nada de quién pregunta, y el puerto aparte donde se leen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrometheusMetrics } from '../../server/adapters/outbound/metrics/prometheus-metrics.js';
import { withLogCounts } from '../../server/adapters/outbound/logging/counting-logger.js';
import { createMetricsServer } from '../../server/adapters/inbound/http/metrics-server.js';
import { createHttpServer, routeLabel } from '../../server/adapters/inbound/http/http-server.js';
import { createMcpHandler } from '../../server/adapters/inbound/mcp/mcp.js';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';
import { assertPort, PORT_MEMBERS } from '../../server/application/ports.js';

const T = Date.UTC(2026, 10, 4, 18, 0);
// Cada línea que no es un comentario: nombre, etiquetas opcionales y un número.
const SAMPLE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? -?\d+(\.\d+)?(e[+-]?\d+)?$/;
const value = (text, series) => {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};
const silent = { info() {}, warn() {}, error() {} };

test('cumple el puerto de métricas y todo lo que escribe es formato de Prometheus válido', () => {
  const m = createPrometheusMetrics({ version: '1.2.3', now: () => T, startedAt: T - 60_000 });
  try {
    assertPort('Metrics', m, PORT_MEMBERS.Metrics);
    m.request({ route: '/api/live', method: 'GET', status: 200, seconds: 0.003 });
    m.mcp({ method: 'tools/call', tool: 'resumen', era: 'moderna', result: 'ok', seconds: 0.02 });
    m.sourceRead({ source: 'renfe-ld', ok: false, seconds: 1.5 });
    m.logged('error');
    const text = m.render({ sources: [{ id: 'renfe-ld', enabled: true, ok: false, interval: 20_000, count: 3, lastOk: T - 90_000 }], now: T });
    for (const line of text.trim().split('\n')) {
      if (!line.startsWith('#')) assert.match(line, SAMPLE, line);
    }
    assert.equal(value(text, 'radar_info{version="1.2.3"}'), 1);
    assert.equal(value(text, 'process_start_time_seconds'), Math.floor((T - 60_000) / 1000));
    assert.ok(value(text, 'process_resident_memory_bytes') > 0);
    assert.ok(value(text, 'nodejs_heap_size_limit_bytes') > 0);
    assert.equal(value(text, 'radar_log_messages_total{level="error"}'), 1);
  } finally {
    m.close();
  }
});

test('contadores e histogramas: las cubetas acumulan y el total cuenta todo', () => {
  const m = createPrometheusMetrics({ now: () => T });
  try {
    for (const seconds of [0.004, 0.03, 0.03, 7]) m.request({ route: '/api/live', method: 'GET', status: 200, seconds });
    m.request({ route: '/api/live', method: 'BREW', status: 405, seconds: 0.001 });
    const text = m.render({ now: T });
    assert.equal(value(text, 'radar_http_requests_total{route="/api/live",method="GET",status="200"}'), 4);
    assert.equal(value(text, 'radar_http_requests_total{route="/api/live",method="OTRO",status="405"}'), 1, 'métodos raros, juntos');
    assert.equal(value(text, 'radar_http_request_seconds_bucket{route="/api/live",le="0.005"}'), 2);
    assert.equal(value(text, 'radar_http_request_seconds_bucket{route="/api/live",le="0.05"}'), 4);
    assert.equal(value(text, 'radar_http_request_seconds_bucket{route="/api/live",le="5"}'), 4);
    assert.equal(value(text, 'radar_http_request_seconds_bucket{route="/api/live",le="+Inf"}'), 5);
    assert.equal(value(text, 'radar_http_request_seconds_count{route="/api/live"}'), 5);
    assert.equal(value(text, 'radar_http_request_seconds_sum{route="/api/live"}'), 7.065);
  } finally {
    m.close();
  }
});

test('las fuentes: activas, en pausa y cuánto llevan sin una lectura buena (desde el arranque si nunca la han tenido)', () => {
  const m = createPrometheusMetrics({ now: () => T, startedAt: T - 300_000 });
  try {
    const text = m.render({
      now: T,
      sources: [
        { id: 'renfe-ld', enabled: true, ok: true, interval: 20_000, count: 412, lastOk: T - 20_000 },
        { id: 'fgc', enabled: true, ok: false, interval: 30_000, count: 0, lastOk: null },
        { id: 'madrid-112', enabled: false, reason: 'En pausa', ok: null, interval: 600_000, lastOk: null },
      ],
    });
    assert.equal(value(text, 'radar_source_enabled{source="renfe-ld"}'), 1);
    assert.equal(value(text, 'radar_source_enabled{source="madrid-112"}'), 0);
    assert.equal(value(text, 'radar_source_up{source="renfe-ld"}'), 1);
    assert.equal(value(text, 'radar_source_up{source="fgc"}'), 0);
    assert.equal(value(text, 'radar_source_items{source="renfe-ld"}'), 412);
    assert.equal(value(text, 'radar_source_interval_seconds{source="fgc"}'), 30);
    assert.equal(value(text, 'radar_source_seconds_since_ok{source="renfe-ld"}'), 20);
    assert.equal(value(text, 'radar_source_seconds_since_ok{source="fgc"}'), 300, 'nunca ha leído bien: desde el arranque');
    assert.equal(value(text, 'radar_source_up{source="madrid-112"}'), undefined, 'una fuente en pausa no puede avisar de que falla');
  } finally {
    m.close();
  }
});

test('etiquetas escapadas y, si un fallo metiera valores sin fin, como mucho 2.000 series por métrica', () => {
  const m = createPrometheusMetrics({ now: () => T });
  try {
    m.mcp({ method: 'tools/call', tool: 'a"b\\c\nd', era: 'antigua', result: 'ok' });
    for (let i = 0; i < 2_100; i++) m.request({ route: `/r${i}`, method: 'GET', status: 200, seconds: 0 });
    const text = m.render({ now: T });
    assert.ok(text.includes('tool="a\\"b\\\\c\\nd"'));
    assert.equal(text.split('\n').filter((l) => l.startsWith('radar_http_requests_total{')).length, 2_000);
    assert.equal(value(text, 'radar_metrics_dropped_total{metric="radar_http_requests_total"}'), 100);
  } finally {
    m.close();
  }
});

test('memoria del contenedor según su cgroup; fuera de un contenedor con límite, nada', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cgroup-'));
  try {
    writeFileSync(join(dir, 'memory.current'), '734003200\n');
    writeFileSync(join(dir, 'memory.max'), '1073741824\n');
    writeFileSync(join(dir, 'memory.peak'), '808452096\n');
    writeFileSync(join(dir, 'memory.stat'), 'file 200000000\nanon 488636416\nkernel 1000\n');
    const m = createPrometheusMetrics({ now: () => T, cgroupDir: dir });
    const text = m.render({ now: T });
    m.close();
    assert.equal(value(text, 'radar_container_memory_bytes'), 734003200);
    assert.equal(value(text, 'radar_container_memory_anon_bytes'), 488636416);
    assert.equal(value(text, 'radar_container_memory_peak_bytes'), 808452096);
    assert.equal(value(text, 'radar_container_memory_limit_bytes'), 1073741824);
    const none = createPrometheusMetrics({ now: () => T, cgroupDir: join(dir, 'no-existe') });
    assert.doesNotMatch(none.render({ now: T }), /radar_container_memory/);
    none.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ruta para las métricas: sin lo que se ha pedido, y lo que no es la API, por tipo', () => {
  const routes = { '/api/live': {}, '/api/health': {}, '/api/lines/sources': {} };
  const label = (url, extra) => routeLabel(url, { routes, vendorPrefixes: ['/vendor/maplibre/'], ...extra });
  assert.equal(label('/api/live?x=1'), '/api/live');
  assert.equal(label('/api/lines/sources'), '/api/lines/sources');
  assert.equal(label('/api/stations/71801'), '/api/stations/:code');
  assert.equal(label('/api/stops/renfe-ld%3A03123'), '/api/stops/:id');
  assert.equal(label('/api/ahead/x'), '/api/ahead/:id');
  assert.equal(label('/api/tracks/x'), '/api/tracks/:id');
  assert.equal(label('/api/burnt-areas?bbox=1,2,3,4'), '/api/burnt-areas');
  assert.equal(label('/api/inventada'), '/api/otra');
  assert.equal(label('/mcp'), '/mcp');
  assert.equal(label('/tiles/ign/7/62/48.png'), '/tiles');
  assert.equal(label('/vendor/maplibre/maplibre-gl.js'), '/vendor');
  assert.equal(label('/legal'), 'pagina');
  assert.equal(label('/'), 'pagina');
  assert.equal(label('/js/app.js'), 'fichero');
  assert.equal(label('/api/live', { www: true }), 'www');
});

test('el registro cuenta avisos y errores en las métricas y escribe lo mismo', () => {
  const counted = [];
  const written = [];
  const log = withLogCounts({ info: (m) => written.push(['info', m]), warn: (m) => written.push(['warn', m]), error: (m) => written.push(['error', m]) },
    { logged: (level) => counted.push(level) });
  log.info('a');
  log.warn('b');
  log.error('c');
  assert.deepEqual(counted, ['warn', 'error']);
  assert.deepEqual(written, [['info', 'a'], ['warn', 'b'], ['error', 'c']]);
});

test('cada lectura de una fuente cuenta, buena o fallida, con lo que ha tardado', async () => {
  let t = T;
  const reads = [];
  const ingest = makeIngestSource({
    sources: [
      { id: 'buena', fetch: async () => { t += 1500; return { vehicles: [] }; } },
      { id: 'mala', fetch: async () => { t += 250; throw new Error('HTTP 503'); } },
    ],
    situation: { saveResult() {}, saveFailure() {}, updateTracks: (f) => f(new Map()) },
    clock: { now: () => t },
    log: silent,
    metrics: { sourceRead: (r) => reads.push(r) },
  });
  await ingest('buena');
  await ingest('mala');
  assert.deepEqual(reads, [{ source: 'buena', ok: true, seconds: 1.5 }, { source: 'mala', ok: false, seconds: 0.25 }]);
});

// ---------- La web y el MCP cuentan lo que atienden ----------

const health = [{ id: 'renfe-ld', name: 'Renfe', kind: 'vehicles', enabled: true, ok: true, license: 'Renfe', lastOk: T }];
const query = {
  health: () => health, vehicles: () => [], events: () => [], alerts: () => [], metrics: () => ({}),
  kpis: () => ({ current: null, history: [] }), stations: () => [], station: () => null,
};
const requests = [];
const messages = [];
let server;
let base;
before(async () => {
  const mcp = createMcpHandler({ query, about: { publicUrl: 'https://example.test' }, version: '1.0.0', now: () => T });
  server = createHttpServer({
    query, mcp, log: silent, publicDir: '/nonexistent', vendorDirs: {}, now: () => T, about: { publicUrl: 'https://example.test' },
    metrics: { request: (r) => requests.push(r), mcp: (m) => messages.push(m) },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// La métrica se apunta al cerrar la respuesta: se espera a que llegue.
const settle = async (list, n) => {
  for (let i = 0; i < 50 && list.length < n; i++) await new Promise((r) => setImmediate(r));
};
const post = (body, headers = {}) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('la web: cada petición con su ruta sin parámetros, su código y su tiempo', async () => {
  requests.length = 0;
  await (await fetch(`${base}/api/health`)).text();
  await (await fetch(`${base}/api/stations/71801`)).text();
  await (await fetch(`${base}/api/nada`)).text();
  await settle(requests, 3);
  assert.deepEqual(requests.map(({ route, method, status }) => [route, method, status]), [
    ['/api/health', 'GET', 200], ['/api/stations/:code', 'GET', 404], ['/api/otra', 'GET', 404],
  ]);
  for (const r of requests) assert.ok(r.seconds >= 0 && r.seconds < 5);
});

test('el MCP: método, herramienta, versión y cómo acaba; lo que no existe va a «otro» u «otra»', async () => {
  messages.length = 0;
  await (await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'estado_fuentes', arguments: {} } })).text();
  await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inventada', arguments: {} } })).text();
  await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'estacion', arguments: { codigo: 7 } } })).text();
  await (await post({ jsonrpc: '2.0', id: 4, method: 'x/y' })).text();
  const modern = { jsonrpc: '2.0', id: 5, method: 'server/discover', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } };
  await (await post(modern, { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' })).text();
  await (await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).text();
  await (await post({ jsonrpc: '2.0', id: 6, method: 'ping' }, { Origin: 'https://otra.example' })).text();
  await (await fetch(`${base}/mcp`)).text();
  const rows = messages.map(({ method, tool, era, result }) => [method, tool, era, result]);
  assert.deepEqual(rows, [
    ['tools/call', 'estado_fuentes', 'antigua', 'ok'],
    ['tools/call', 'otra', 'antigua', 'parametros_no_validos'],
    ['tools/call', 'estacion', 'antigua', 'error_herramienta'],
    ['otro', '', 'antigua', 'metodo_desconocido'],
    ['server/discover', '', 'moderna', 'ok'],
    ['notificacion', '', 'antigua', 'notificacion'],
    ['ninguno', '', 'antigua', 'origen'],
    ['ninguno', '', 'antigua', 'metodo_http'],
  ]);
  assert.ok(messages[0].seconds >= 0, 'lo que tarda una herramienta');
  assert.equal(messages[6].seconds, undefined, 'lo rechazado no llega a calcular nada');
});

test('el puerto de las métricas: sólo GET /metrics, en texto de Prometheus y sin caché', async () => {
  let fail = false;
  const errors = [];
  const metricsServer = createMetricsServer({
    render: () => {
      if (fail) throw new Error('roto');
      return 'radar_info{version="1"} 1\n';
    },
    log: { ...silent, error: (m) => errors.push(m) },
  });
  await new Promise((resolve) => metricsServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${metricsServer.address().port}`;
  try {
    const ok = await fetch(`${url}/metrics`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /^text\/plain; version=0\.0\.4/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(await ok.text(), 'radar_info{version="1"} 1\n');
    assert.equal((await fetch(`${url}/api/health`)).status, 404);
    assert.equal((await fetch(`${url}/metrics`, { method: 'POST' })).status, 405);
    fail = true;
    assert.equal((await fetch(`${url}/metrics`)).status, 500);
    assert.match(errors[0], /\[métricas\] Error: roto/);
  } finally {
    metricsServer.close();
  }
});
