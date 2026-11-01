// El stream SSE antiguo (/api/stream) sigue enviando lo mismo, ahora a través del caso de uso
// watchSituation y no del bus.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';
import { makeWatchSituation } from '../../server/application/use-cases/watch-situation.js';
import { createInProcessEventBus } from '../../server/adapters/outbound/events/in-process-event-bus.js';

const bus = createInProcessEventBus();
let listeners = 0;
const events = {
  publish: bus.publish,
  subscribe(topic, handler) {
    listeners++;
    const off = bus.subscribe(topic, handler);
    return () => { listeners--; off(); };
  },
};
const query = {
  snapshot: ({ buses }) => ({ generatedAt: 1, buses }),
  sourcePayload: (id, { buses }) => ({ id, buses }),
  resolvedAlerts: () => [],
  health: () => [],
};

let server;
let port;
before(async () => {
  server = createHttpServer({
    query, watchSituation: makeWatchSituation({ events, query }), log: { error() {}, info() {}, warn() {} },
    publicDir: '/nonexistent', vendorDirs: {},
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

/** Espera (como mucho 1 s) a que se cumpla una condición. */
async function until(condition) {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  return condition();
}

/** Abre /api/stream y devuelve los eventos SSE según llegan. */
function openStream(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let buffer = '';
      const waiting = [];
      const received = [];
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = block.match(/^event: (.+)$/m)?.[1];
          if (!event) continue;
          received.push({ event, data: JSON.parse(block.match(/^data: (.+)$/m)[1]) });
          waiting.shift()?.();
        }
      });
      const next = async () => {
        while (!received.length) await new Promise((r) => waiting.push(r));
        return received.shift();
      };
      resolve({ res, next, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

test('/api/stream envía la foto inicial, los cambios de cada fuente y las alertas', async () => {
  const stream = await openStream('/api/stream?buses=1');
  try {
    assert.equal(stream.res.statusCode, 200);
    assert.match(stream.res.headers['content-type'], /^text\/event-stream/);
    assert.deepEqual(await stream.next(), { event: 'snapshot', data: { generatedAt: 1, buses: true } });
    bus.publish('source.updated', { id: 'renfe' });
    assert.deepEqual(await stream.next(), { event: 'source', data: { id: 'renfe', buses: true } });
    bus.publish('alerts.updated', { alerts: [], kpis: { vehicles: 3 } });
    assert.deepEqual(await stream.next(), { event: 'alerts', data: { alerts: [], kpis: { vehicles: 3 }, resolved: [] } });
  } finally {
    stream.close();
  }
  assert.ok(await until(() => listeners === 0), 'al cerrar se deja de escuchar');
});

test('sin ?buses=1 la fuente llega sin autobuses, y al cerrar se deja de escuchar', async () => {
  const stream = await openStream('/api/stream');
  try {
    await stream.next(); // snapshot
    assert.equal(listeners, 3);
    bus.publish('source.updated', { id: 'emt' });
    assert.deepEqual(await stream.next(), { event: 'source', data: { id: 'emt', buses: false } });
  } finally {
    stream.close();
  }
  assert.ok(await until(() => listeners === 0), 'al cerrar se deja de escuchar');
});
