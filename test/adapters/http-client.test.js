// El cliente HTTP de las fuentes corta las respuestas que pasan del tope en vez de leerlas enteras.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpClient } from '../../server/adapters/outbound/http/http-client.js';

const MB = 1024 * 1024;
let server;
let base;
const sent = { chunked: 0 };
// Se cumple cuando el servidor ve cerrada la respuesta sin Content-Length: ya no puede mandar más.
let chunkedClosed;
const chunkedDone = new Promise((resolve) => { chunkedClosed = resolve; });
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/texto') return res.end('{"á":1}');
    if (req.url.startsWith('/post')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url.startsWith('/post/lento')) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 7 } }));
        }
        if (req.url === '/post/mueve') {
          res.writeHead(302, { Location: '/post/eco' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, type: req.headers['content-type'], body: JSON.parse(body) }));
      });
      return undefined;
    }
    if (req.url === '/grande') {
      res.writeHead(200, { 'Content-Length': String(3 * MB) });
      return res.end(Buffer.alloc(3 * MB));
    }
    // Sin Content-Length: 3 MB y la respuesta abierta. Si el cliente no cortara al pasar del tope, se
    // quedaría esperando más datos hasta su propio timeout y el test fallaría por el mensaje.
    res.writeHead(200);
    for (; sent.chunked < 3; sent.chunked++) res.write(Buffer.alloc(MB));
    res.on('close', chunkedClosed);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('dentro del tope devuelve el cuerpo tal cual: texto UTF-8, JSON y bytes', async () => {
  const http = createHttpClient();
  assert.equal(await http.text(`${base}/texto`), '{"á":1}');
  assert.deepEqual(await http.json(`${base}/texto`), { á: 1 });
  const bytes = await http.bytes(`${base}/grande`, { maxBytes: 4 * MB });
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 3 * MB);
});

test('si el Content-Length pasa del tope, falla sin descargar el cuerpo', async () => {
  await assert.rejects(createHttpClient().bytes(`${base}/grande`, { maxBytes: MB }), /Respuesta de más de 1 MB/);
});

test('sin Content-Length, corta la descarga en cuanto pasa del tope', async () => {
  await assert.rejects(createHttpClient().bytes(`${base}/sin-longitud`, { maxBytes: 2 * MB }), /Respuesta de más de 2 MB/);
  await chunkedDone; // el cliente ha cerrado la conexión
  assert.equal(sent.chunked, 3);
});

test('postJson manda JSON y devuelve JSON; si falla, el error lleva el estado y el cuerpo, y sólo dice el host', async () => {
  const http = createHttpClient();
  const ok = await http.postJson(`${base}/post/eco`, { texto: 'hola, ñ' });
  assert.deepEqual(ok, { method: 'POST', type: 'application/json', body: { texto: 'hola, ñ' } });
  const err = await http.postJson(`${base}/post/lento/bot123:SECRETO/sendMessage`, {}).catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.body.parameters.retry_after, 7);
  assert.equal(err.message, `HTTP 429 en 127.0.0.1:${new URL(base).port}`);
  assert.doesNotMatch(err.message, /SECRETO/);
  const moved = await http.postJson(`${base}/post/mueve`, {}).catch((e) => e);
  assert.equal(moved.status, 302, 'no sigue redirecciones');
});
