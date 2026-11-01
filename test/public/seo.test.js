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
    query: {}, log: { error() {}, info() {}, warn() {} },
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

const pages = (await readdir(PUBLIC, { recursive: true })).filter((f) => f.endsWith('.html') && f !== '404.html').map((f) => f.split('\\').join('/'));
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
    assert.ok(html.includes(`<html lang="${file.startsWith('en') ? 'en' : 'es'}">`), 'idioma de la página');
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
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
  const site = graph.find((n) => n['@type'] === 'WebSite');
  const person = graph.find((n) => n['@type'] === 'Person');
  assert.equal(person['@id'], 'https://florintodor.dev/#persona', 'mismo identificador que el portafolio');
  assert.equal(site.creator['@id'], person['@id']);
  assert.equal(site.name, 'Radar España');
  assert.ok(site.alternateName.includes('radarespaña.es'));
  assert.equal(site.url, `${SITE}/`);
});

test('hreflang: cada página traducida apunta a la otra, y la otra le devuelve el enlace', async () => {
  const alternates = new Map();
  for (const file of pages) {
    const html = await readFile(`${PUBLIC}/${file}`, 'utf8');
    const links = Object.fromEntries([...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]));
    if (Object.keys(links).length) alternates.set(urlOf(file), links);
  }
  assert.ok(alternates.size >= 8, 'las 4 páginas en español y sus 4 en inglés');
  for (const [url, links] of alternates) {
    assert.ok(links.es && links.en && links['x-default'], `${url}: es, en y x-default`);
    assert.ok([links.es, links.en].includes(url), `${url} se incluye a sí misma`);
    for (const other of [links.es, links.en]) assert.deepEqual(alternates.get(other), links, `${other} devuelve los mismos enlaces que ${url}`);
  }
});
