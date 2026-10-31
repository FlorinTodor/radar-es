import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';

// Comprobaciones de SEO de las páginas públicas: así una página nueva no se publica sin título,
// descripción, canonical ni entrada en el sitemap.
const PUBLIC = fileURLToPath(new URL('../../public', import.meta.url));
const SITE = 'https://xn--radarespaa-19a.es';

let server;
let base;
before(async () => {
  server = createHttpServer({
    query: {}, bus: { subscribe: () => () => {} }, log: { error() {}, info() {}, warn() {} },
    publicDir: PUBLIC, vendorDirs: {}, about: { publicUrl: SITE },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (path) => fetch(base + path, { redirect: 'manual' });

test('robots.txt, sitemap.xml y el manifest se sirven con su tipo', async () => {
  assert.match((await get('/robots.txt')).headers.get('content-type'), /^text\/plain/);
  assert.match((await get('/sitemap.xml')).headers.get('content-type'), /^application\/xml/);
  assert.match((await get('/site.webmanifest')).headers.get('content-type'), /^application\/manifest\+json/);
});

const pages = (await readdir(PUBLIC)).filter((f) => f.endsWith('.html') && f !== '404.html');
const sitemap = await readFile(`${PUBLIC}/sitemap.xml`, 'utf8');
const robots = await readFile(`${PUBLIC}/robots.txt`, 'utf8');
const urlOf = (file) => `${SITE}/${file === 'index.html' ? '' : file.replace(/\.html$/, '')}`;

for (const file of pages) {
  test(`SEO de ${file}: título, descripción, canonical, h1, Open Graph y sitemap`, async () => {
    const html = await readFile(`${PUBLIC}/${file}`, 'utf8');
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    const description = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
    assert.ok(title && title.length <= 65, `título de hasta 65 caracteres (${title?.length})`);
    assert.ok(description && description.length >= 70 && description.length <= 200, `descripción de 70 a 200 caracteres (${description?.length})`);
    assert.match(html, /<html lang="es">/);
    assert.ok(html.includes(`<link rel="canonical" href="${urlOf(file)}">`), 'canonical con la URL limpia');
    assert.ok(html.includes(`<meta property="og:url" content="${urlOf(file)}">`), 'og:url igual que la canonical');
    assert.match(html, /<meta property="og:image" content="https:\/\/xn--radarespaa-19a\.es\/og\.png">/);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, 'un solo h1');
    assert.ok(sitemap.includes(`<loc>${urlOf(file)}</loc>`), 'está en el sitemap');
    assert.doesNotMatch(html, /href="\/[^"]*\.html/, 'enlaces internos sin .html (evitan una redirección)');
    for (const json of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(json[1]);
  });
}

test('el sitemap sólo enlaza páginas que existen y robots.txt lo anuncia', () => {
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs.toSorted(), pages.map(urlOf).toSorted());
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, 'm'));
});

test('la portada declara el nombre del sitio para los buscadores', async () => {
  const html = await readFile(`${PUBLIC}/index.html`, 'utf8');
  const site = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(site['@type'], 'WebSite');
  assert.equal(site.name, 'Radar España');
  assert.ok(site.alternateName.includes('radarespaña.es'));
  assert.equal(site.url, `${SITE}/`);
});
