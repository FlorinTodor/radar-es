// El aviso legal lleva el titular y el contacto en el propio HTML, sin depender de JavaScript
// (LSSI, art. 10): el servidor los rellena al servir la página.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aboutFiller, createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

const PAGE = `<p>Titular: <span data-about="owner">[pendiente de completar]</span>. Contacto:
  <span data-about="contact">[pendiente de completar]</span>.</p>
<p>Para retirar una foto, escribe a <span data-about="contact">[pendiente de completar]</span>.</p>`;

async function serve(t, about) {
  const dir = await mkdtemp(join(tmpdir(), 'legal-'));
  await writeFile(join(dir, 'legal.html'), PAGE);
  const server = createHttpServer({ query: {}, log: { error() {} }, publicDir: dir, vendorDirs: {}, about });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('/legal sale con el titular y el contacto ya escritos, y el correo como enlace', async (t) => {
  const base = await serve(t, { owner: 'Ana Pérez', contact: 'ana@example.org' });
  const res = await fetch(`${base}/legal`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<span data-about="owner">Ana Pérez<\/span>/);
  assert.equal(html.match(/<a href="mailto:ana@example.org">ana@example.org<\/a>/g)?.length, 2, 'en el contacto y en la retirada de fotos');
  assert.doesNotMatch(html, /pendiente de completar/);
  const again = await fetch(`${base}/legal`, { headers: { 'If-None-Match': res.headers.get('etag') } });
  assert.equal(again.status, 304);
});

test('sin titular ni contacto en .env, la página va tal cual', async (t) => {
  const base = await serve(t, {});
  assert.equal(await (await fetch(`${base}/legal`)).text(), PAGE);
  assert.equal(aboutFiller({}), null);
});

test('lo que viene de .env se escapa: no puede meter HTML en la página', () => {
  const html = aboutFiller({ owner: '<script>x</script>', contact: 'a"b@example.org' })(PAGE);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /mailto:a&quot;b@example.org/);
  assert.doesNotMatch(html, /<script>/);
});

test('otro titular, otra firma: el navegador no se queda con la versión anterior', () => {
  assert.notEqual(aboutFiller({ owner: 'Ana' }).tag, aboutFiller({ owner: 'Eva' }).tag);
});
