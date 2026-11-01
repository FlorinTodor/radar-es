// El cliente HTTP de las fuentes corta las respuestas que pasan del tope en vez de leerlas enteras.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpClient } from '../../server/adapters/outbound/http/http-client.js';

const MB = 1024 * 1024;
let server;
let base;
const sent = { chunked: 0 };
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/texto') return res.end('{"á":1}');
    if (req.url === '/grande') {
      res.writeHead(200, { 'Content-Length': String(3 * MB) });
      return res.end(Buffer.alloc(3 * MB));
    }
    // Sin Content-Length: 1 MB cada 10 ms hasta 50 MB, si nadie corta antes.
    res.writeHead(200);
    const timer = setInterval(() => {
      if (res.destroyed || sent.chunked >= 50) return clearInterval(timer), res.end();
      sent.chunked++;
      res.write(Buffer.alloc(MB));
    }, 10);
    res.on('close', () => clearInterval(timer));
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
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sent.chunked < 10, `el servidor llegó a mandar ${sent.chunked} MB`);
});
