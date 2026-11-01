// Fotos para las estaciones que no tienen en Wikidata: su categoría de Commons, la imagen libre de su
// artículo de Wikipedia o una foto de Commons hecha al lado que lleve su nombre. Siempre con licencia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadStationExtras, matchesStation, nameKey, pageImages, parseCommons, pickCategoryFile, pickNearby } from '../../server/adapters/outbound/stations/station-extras.js';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';

const silent = { warn() {}, info() {} };

test('la palabra propia del nombre: la más larga que no es «de», «estación»…', () => {
  assert.equal(nameKey('Madrid-Nuevos Ministerios'), 'ministerios');
  assert.equal(nameKey('Valdecilla la Marga'), 'valdecilla');
  assert.equal(nameKey('Callosa de Segura-Cox'), 'callosa');
  assert.equal(nameKey('Poo'), 'poo');
  assert.equal(nameKey('Vimbodí i Poblet'), 'vimbodi');
  assert.equal(nameKey('de la'), null);
});

test('cercanía: sólo fotos con el nombre de la estación y algo de tren, la más cercana', () => {
  const near = (...hits) => ({ query: { geosearch: hits.map(([title, dist]) => ({ title: `File:${title}`, dist })) } });
  assert.equal(pickNearby(near(['Viaje en tren Alicante-Murcia en julio de 2022 34.jpg', 31]), 'Callosa de Segura-Cox'), null);
  assert.equal(pickNearby(near(['Renfe 319.304 + 319.323 (31461093005).jpg', 90]), 'Puertollano'), null);
  assert.equal(pickNearby(near(['Iglesia de Agres.jpg', 20], ['Agres. Estació Renfe.JPG', 8]), 'Agres'), 'Agres. Estació Renfe.JPG');
  assert.equal(pickNearby(near(['Apeadero Valdecilla.jpg', 95]), 'Valdecilla la Marga'), 'Apeadero Valdecilla.jpg');
  assert.equal(pickNearby(near(['Vinaixa train station 2.jpg', 40], ['Vinaixa train station.jpg', 17]), 'Vinaixa'), 'Vinaixa train station.jpg');
  assert.equal(pickNearby(near(['Mapa estación de Tocina.svg', 5]), 'Tocina'), null, 'ni mapas ni dibujos');
});

test('un puente, un mapa o una calle no es la foto de la estación, salvo que la estación se llame así', () => {
  assert.equal(matchesStation('Estación_de_El_Pimpollar.jpg', 'El Pimpollar'), true);
  assert.equal(matchesStation('Puente ferroviario sobre el río Ebro, Arija.jpg', 'Arija'), false);
  assert.equal(matchesStation('Estación de Puente Genil-Herrera.jpg', 'Puente Genil-Herrera'), true);
  assert.equal(matchesStation('Estació del Pont de Vilomara.jpg', 'El Pont de Vilomara'), true);
  assert.equal(matchesStation('Paseo de la Estación en 1997. Callosa de Segura - panoramio.jpg', 'Callosa de Segura-Cox', { railway: true }), false);
  assert.equal(matchesStation('Estación Plaza del Rey 1.jpg', 'Plaza del Rey', { railway: true }), true);
});

test('imágenes de Wikipedia: cada una vuelve al título pedido aunque haya redirección', () => {
  const json = { query: {
    normalized: [{ from: 'estación de Udalla', to: 'Estación de Udalla' }],
    redirects: [{ from: 'Estación de Udalla', to: 'Estación de ferrocarril de Udalla' }],
    pages: [{ title: 'Estación de ferrocarril de Udalla', pageimage: 'Udalla_15.JPG' }, { title: 'Sin foto' }],
  } };
  assert.deepEqual([...pageImages(json)], [['estación de Udalla', 'Udalla 15.JPG']]);
});

test('categoría de Commons: mejor la foto con el nombre; si no, la primera foto; nunca un mapa', () => {
  const cat = (...files) => ({ query: { categorymembers: files.map((f) => ({ title: `File:${f}` })) } });
  assert.equal(pickCategoryFile(cat('Mapa de Bravo.png', 'Tren 1.jpg', 'Estación de Bravo.jpg'), 'Bravo'), 'Estación de Bravo.jpg');
  assert.equal(pickCategoryFile(cat('Plano.svg', 'Tren 1.jpg'), 'Bravo'), 'Tren 1.jpg');
  assert.equal(pickCategoryFile(cat('Plano.svg'), 'Bravo'), null);
});

test('carga completa: Wikidata, categoría, Wikipedia y cercanía, y sin licencia no hay foto', async () => {
  const STATIONS = ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((name, i) => ({ code: `1000${i}`, name, lat: 40 + i, lon: -3 }));
  const v = (value) => ({ value });
  const responses = (url) => {
    const u = new URL(url);
    if (u.host === 'query.wikidata.org') return { results: { bindings: [
      { code: v('10000'), img: v('http://commons.wikimedia.org/wiki/Special:FilePath/Alfa%20estaci%C3%B3n.jpg') },
      { code: v('10001'), cat: v('Bravo railway station') },
      { code: v('10002'), wp: v('https://es.wikipedia.org/wiki/Estaci%C3%B3n_de_Charlie') },
    ] } };
    const q = u.searchParams;
    if (q.get('list') === 'categorymembers') return { query: { categorymembers: [{ title: 'File:Mapa.svg' }, { title: 'File:Bravo andenes.jpg' }] } };
    if (q.get('prop') === 'pageimages') return { query: { pages: [{ title: 'Estación de Charlie', pageimage: 'Estación_de_Charlie.jpg' }] } };
    if (q.get('list') === 'geosearch') {
      const lat = Number(q.get('gscoord').split('|')[0]);
      const hits = { 43: ['Viaje en tren 34.jpg', 'Apeadero de Delta.jpg'], 44: ['Iglesia de Echo.jpg'], 45: ['Estación de Foxtrot.jpg'] }[lat] ?? [];
      return { query: { geosearch: hits.map((h, i) => ({ title: `File:${h}`, dist: 10 + i })) } };
    }
    if (q.get('prop') === 'imageinfo') {
      const pages = q.get('titles').split('|').map((title, i) => ({
        title,
        imageinfo: [{ thumburl: `https://upload.wikimedia.org/${i}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/${title}`,
          extmetadata: title === 'File:Estación de Foxtrot.jpg' ? {} : { Artist: v('Ana'), LicenseShortName: v('CC BY 4.0') } }],
      }));
      return { query: { pages } };
    }
    throw new Error(`petición inesperada ${url}`);
  };
  const cache = { bytes: async (url) => new TextEncoder().encode(JSON.stringify(responses(url))) };
  const extras = await loadStationExtras({ cache, log: silent, maxAgeMs: 1, stations: STATIONS, nearbyBudgetMs: 10_000 });
  const photo = (code) => extras.get(code)?.photo?.page.split('/wiki/').pop() ?? null;
  assert.equal(photo('10000'), 'File:Alfa estación.jpg', 'la de Wikidata');
  assert.equal(photo('10001'), 'File:Bravo andenes.jpg', 'de su categoría');
  assert.equal(photo('10002'), 'File:Estación de Charlie.jpg', 'de su artículo');
  assert.equal(photo('10003'), 'File:Apeadero de Delta.jpg', 'la de al lado con su nombre');
  assert.equal(photo('10004'), null, 'una iglesia cercana no vale');
  assert.equal(photo('10005'), null, 'sin licencia, no hay foto');
  assert.equal(extras.get('10001').category, undefined, 'la categoría no sale en la ficha');
});

test('caché: una respuesta que no valida (error dentro de un 200) no se guarda y se usa la copia anterior', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-cache-'));
  try {
    let body = '{"ok":1}';
    const http = { bytes: async () => new TextEncoder().encode(body) };
    const cache = createFileCache({ http, dir: pathToFileURL(`${dir}/`), log: silent });
    const validate = (b) => { if (JSON.parse(new TextDecoder().decode(b)).error) throw new Error('ocupado'); };
    assert.equal(new TextDecoder().decode(await cache.bytes('https://x', 'a.json', 0, { validate })), '{"ok":1}');
    body = '{"error":{"code":"cirrussearch-too-busy-error"}}';
    assert.equal(new TextDecoder().decode(await cache.bytes('https://x', 'a.json', 0, { validate })), '{"ok":1}');
    await assert.rejects(cache.bytes('https://x', 'b.json', 0, { validate }), /ocupado/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('autor: el texto de atribución que pide el autor; si no, su nombre, sin avisos ni tablas', async () => {
  const { commonsAuthor } = await import('../../server/adapters/outbound/stations/station-extras.js');
  const v = (value) => ({ value });
  assert.equal(commonsAuthor({ Artist: v('pere prlpz'), Attribution: v('Pere López') }), 'Pere López');
  assert.equal(commonsAuthor({ Artist: v('Enrique Íñiguez Rodríguez (<a href="//commons.wikimedia.org/wiki/User:Qoan">Qoan</a>)'),
    Attribution: v('Enrique Íñiguez Rodríguez') }), 'Enrique Íñiguez Rodríguez');
  assert.equal(commonsAuthor({ Artist: v('Héctor S. Marqueño'), Attribution: v('<a href="//commons.wikimedia.org/wiki/User:Espanish_AlB">Espanish AlB</a>') }), 'Espanish AlB');
  assert.equal(commonsAuthor({ Artist: v('No machine-readable author provided. Chixoy assumed (based on copyright claims).') }), 'Chixoy');
  const table = '<table><tr><td><a href="//commons.wikimedia.org/wiki/File:Flag.gif"><img src="x"></a></td><td><a href="//commons.wikimedia.org/wiki/User:Kolforn">Kolforn</a> (Kolforn) '
    + "I'd appreciate if you could mail me (Kolforn@gmail.com) if you want to use this picture out of the Wikimedia project scope.</td></tr></table>";
  assert.equal(commonsAuthor({ Artist: v(table) }), 'Kolforn', 'ni el correo ni el aviso');
  assert.equal(commonsAuthor({ Artist: v('Mdiagom'), Attribution: v('I, Mdiagom') }), 'Mdiagom');
  assert.equal(commonsAuthor({ Artist: v('Luis Miguel Bugallo Sánchez http://commons.wikimedia.org/wiki/User:Lmbuga'),
    Attribution: v('http://commons.wikimedia.org/wiki/User:Lmbuga') }), 'Luis Miguel Bugallo Sánchez http://commons.wikimedia.org/wiki/User:Lmbuga');
  assert.equal(commonsAuthor({ Attribution: v('\u200bWikipedia user PepedoCouto') }), 'Wikipedia user PepedoCouto');
  const lmbuga = '<p>Luis Miguel Bugallo Sánchez\n</p>\n<dl><dd><a class="external free" href="https://commons.wikimedia.org/wiki/User:Lmbuga">'
    + 'http://commons.wikimedia.org/wiki/User:Lmbuga</a></dd>\n<dd><a class="external free" href="https://gl.wikipedia.org/wiki/Usuario:Lmbuga">http://gl.wikipedia.org/wiki/Usuario:Lmbuga</a></dd></dl>';
  assert.equal(commonsAuthor({ Artist: v(lmbuga) }), 'Luis Miguel Bugallo Sánchez');
  assert.equal(commonsAuthor({}), '');
});

test('licencias: sin autor sólo valen CC0 y dominio público; las fotos sólo GFDL no se usan', () => {
  const v = (value) => ({ value });
  const page = (title, extmetadata) => ({ title: `File:${title}`, imageinfo: [{ thumburl: `https://upload.wikimedia.org/${title}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}`, extmetadata }] });
  const out = parseCommons({ query: { pages: [
    page('a.jpg', { LicenseShortName: v('CC BY-SA 3.0') }),
    page('b.jpg', { LicenseShortName: v('CC0') }),
    page('c.jpg', { LicenseShortName: v('Public domain') }),
    page('d.jpg', { LicenseShortName: v('GFDL'), Artist: v('Ana') }),
    page('e.jpg', { LicenseShortName: v('CC BY-SA 3.0'), Attribution: v('Willtron') }),
  ] } });
  assert.deepEqual([...out.keys()], ['b.jpg', 'c.jpg', 'e.jpg']);
  assert.equal(out.get('b.jpg').author, 'Autor desconocido');
  assert.equal(out.get('e.jpg').author, 'Willtron');
});
