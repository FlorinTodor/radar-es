// Un fichero que no se puede leer corta esa respuesta, pero no el servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

// Como root (al construir la imagen) se puede leer todo: no hay forma de provocar el error.
test('un error al leer un fichero ya anunciado no cierra el proceso', { skip: process.getuid?.() === 0 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'publico-'));
  await writeFile(join(dir, 'ok.css'), 'body{}');
  await writeFile(join(dir, 'roto.css'), 'body{}');
  await chmod(join(dir, 'roto.css'), 0o000);
  const server = createHttpServer({ query: {}, log: { error() {}, info() {}, warn() {} }, publicDir: dir, vendorDirs: {}, about: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const uncaught = [];
  const onError = (err) => uncaught.push(err);
  process.on('uncaughtException', onError);
  try {
    await assert.rejects(fetch(`${base}/roto.css`).then((r) => r.text()), 'la respuesta se corta');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(uncaught, []);
    assert.equal(await (await fetch(`${base}/ok.css`)).text(), 'body{}', 'y el servidor sigue');
  } finally {
    process.off('uncaughtException', onError);
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
