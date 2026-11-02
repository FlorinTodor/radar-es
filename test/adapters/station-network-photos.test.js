// Datos de Wikidata y fotos para las estaciones de metro, tranvía y las demás redes: se emparejan por
// cercanía y nombre, y una foto no se repite ni se toma de otra estación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { URBAN_RAILWAY, loadNetworkStationExtras, matchWikidata, nearbyCandidates, parseWikidataArea, sameStationName, tidyAuthor }
  from '../../server/adapters/outbound/stations/station-extras.js';

const item = (id, lat, lon, labels, types, extra = {}) => ({ id, lat, lon, labels, types, images: [], codes: [], ...extra });
// Plaça de Catalunya: a pocos metros, la estación de metro, la de FGC y la de Renfe.
const ITEMS = [
  item('Qmetro', 41.3870, 2.1700, ['Catalunya'], ['metro']),
  item('Qfgc', 41.3868, 2.1697, ['Plaça de Catalunya', 'Barcelona-Plaça de Catalunya'], ['tren']),
  item('Qrenfe', 41.3866, 2.1695, ['Barcelona-Plaça de Catalunya'], ['tren'], { codes: ['78805'] }),
  item('Qlejos', 41.4100, 2.1900, ['Catalunya'], ['metro']),
];

test('cada estación toma el elemento de su tipo, cerca y con su nombre; nunca el de Renfe', () => {
  const stations = [
    { code: 'tmb:1', name: 'Catalunya', lat: 41.3871, lon: 2.1701, mode: 'metro' },
    { code: 'fgc:PC', name: 'Barcelona - Plaça Catalunya', lat: 41.3867, lon: 2.1696, mode: 'cercanias' },
  ];
  const m = matchWikidata(stations, ITEMS, new Set(['78805']));
  assert.equal(m.get('tmb:1').id, 'Qmetro');
  assert.equal(m.get('fgc:PC').id, 'Qfgc', 'el de Renfe (código 78805) está más cerca, pero es otra estación');
});

test('sin un nombre que encaje o a más de 300 m, no hay elemento; y un elemento no va a dos estaciones', () => {
  const stations = [
    { code: 'a:1', name: 'Universitat', lat: 41.3871, lon: 2.1701, mode: 'metro' },
    { code: 'a:2', name: 'Catalunya', lat: 41.3950, lon: 2.1800, mode: 'metro' }, // a ~1,2 km
    { code: 'b:1', name: 'Catalunya', lat: 41.3871, lon: 2.1701, mode: 'metro' },
    { code: 'c:1', name: 'Catalunya', lat: 41.3872, lon: 2.1702, mode: 'metro' },
  ];
  const m = matchWikidata(stations, ITEMS);
  assert.equal(m.has('a:1'), false);
  assert.equal(m.has('a:2'), false);
  assert.equal([m.get('b:1')?.id, m.get('c:1')?.id].filter((id) => id === 'Qmetro').length, 1);
});

test('nombres de la misma estación en distintas formas', () => {
  assert.ok(sameStationName('Sants Estació', 'Sants'));
  assert.ok(sameStationName('Zazpikaleak/Casco Viejo', 'Casco Viejo'));
  assert.ok(sameStationName('PINAR DE CHAMARTIN', 'Pinar de Chamartín'));
  assert.ok(!sameStationName('Universitat', 'Catalunya'));
});

test('autor sin restos de enlaces; si no los tiene, tal cual', () => {
  assert.equal(tidyAuthor('Matthew McLauchlin, [http://www.metrodemontreal.com/ metrodemontreal.com'), 'Matthew McLauchlin, metrodemontreal.com');
  assert.equal(tidyAuthor('[https://www.metrodemontreal.com/]'), 'https://www.metrodemontreal.com/');
  assert.equal(tidyAuthor('JPVL http://ferropedia.es/mediawiki/index.php/Usuario:JPVL'), 'JPVL http://ferropedia.es/mediawiki/index.php/Usuario:JPVL', 'la dirección que pone el autor se respeta');
  assert.equal(tidyAuthor('https://www.flickr.com/people/chatani/'), 'chatani');
  assert.equal(tidyAuthor('Miguel303xm~commonswiki'), 'Miguel303xm~commonswiki', 'los de Renfe no cambian');
});

test('respuesta de Wikidata por zona: coordenadas, tipos, nombres, fotos y datos', () => {
  const json = { results: { bindings: [{
    st: { value: 'http://www.wikidata.org/entity/Q123' },
    c: { value: 'Point(2.17 41.387)' },
    types: { value: 'http://www.wikidata.org/entity/Q928830|http://www.wikidata.org/entity/Q22808404' },
    labels: { value: 'Catalunya|Catalunya (metro)' },
    imgs: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Estaci%C3%B3%20Catalunya.jpg' },
    codes: { value: '' },
    a: { value: 'http://www.wikidata.org/entity/Q24192067' },
    opened: { value: '1924-12-30T00:00:00Z' },
    wiki: { value: 'https://es.wikipedia.org/wiki/Estaci%C3%B3n_de_Catalu%C3%B1a' },
  }, { st: { value: 'http://www.wikidata.org/entity/Q9' }, c: { value: 'sin coordenadas' } }] } };
  assert.deepEqual(parseWikidataArea(json), [{
    id: 'Q123', lat: 41.387, lon: 2.17, types: ['metro'], labels: ['Catalunya', 'Catalunya (metro)'],
    images: ['Estació Catalunya.jpg'], codes: [], accessible: true, opened: 1924,
    wikipedia: 'https://es.wikipedia.org/wiki/Estaci%C3%B3n_de_Catalu%C3%B1a',
  }]);
});

test('fotos de cerca con palabras de metro y tranvía; las de autobús, no', () => {
  const json = { query: { geosearch: [
    { title: 'File:Tranvía de Zaragoza - Plaza España.jpg', dist: 40 },
    { title: 'File:Parada de autobús Plaza España.jpg', dist: 10 },
    { title: 'File:Metro Plaza España andén.jpg', dist: 25 },
  ] } };
  assert.deepEqual(nearbyCandidates(json, 'Plaza España', URBAN_RAILWAY).map((c) => c.file),
    ['Metro Plaza España andén.jpg', 'Tranvía de Zaragoza - Plaza España.jpg']);
  assert.deepEqual(nearbyCandidates(json, 'Plaza España').map((c) => c.file), ['Metro Plaza España andén.jpg'],
    'con las palabras de Renfe, como siempre: «andén» sí, «tranvía» no');
});

/** Caché falsa: responde por el principio de la URL. */
function fakeCache(routes) {
  return {
    async bytes(url) {
      const hit = routes.find(([prefix]) => url.startsWith(prefix));
      if (!hit) throw new Error(`sin respuesta para ${url}`);
      return new TextEncoder().encode(JSON.stringify(typeof hit[1] === 'function' ? hit[1](url) : hit[1]));
    },
  };
}
const commonsPage = (file, author = 'Ana') => ({
  title: `File:${file}`,
  imageinfo: [{ thumburl: `https://upload.wikimedia.org/x/640px-${encodeURIComponent(file)}`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' }, Artist: { value: author } } }],
});
const commons = (url) => {
  const titles = decodeURIComponent(url.split('titles=')[1]).split('|').map((t) => t.replace(/^File:/, ''));
  return { query: { pages: Object.fromEntries(titles.map((f, i) => [i, commonsPage(f)])) } };
};
const area = (rows) => ({ results: { bindings: rows.map(([id, lon, lat, label, img]) => ({
  st: { value: `http://www.wikidata.org/entity/${id}` }, c: { value: `Point(${lon} ${lat})` },
  types: { value: 'http://www.wikidata.org/entity/Q928830' }, labels: { value: label },
  imgs: { value: img ? `http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(img)}` : '' },
})) } });

test('una foto que ya usa Renfe o que Wikidata da a otra estación no se usa', async () => {
  const stations = [
    { code: 'm:1', name: 'Abando', lat: 43.2610, lon: -2.9270, mode: 'metro' },
    { code: 'm:2', name: 'Moyua', lat: 43.2630, lon: -2.9350, mode: 'metro' },
  ];
  const cache = fakeCache([
    ['https://query.wikidata.org/', area([['Qa', -2.9271, 43.2611, 'Abando', 'Abando Renfe.jpg'], ['Qx', -2.9351, 43.2631, 'Plaza Moyua', 'Moyua geltokia.jpg']])],
    ['https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo', commons],
    // Sin elemento propio para Moyua: busca cerca y encuentra la foto que Wikidata le da a otro (Qx).
    ['https://commons.wikimedia.org/w/api.php?format=json&action=query&list=geosearch', { query: { geosearch: [{ title: 'File:Moyua geltokia.jpg', dist: 5 }] } }],
    ['https://commons.wikimedia.org/w/api.php?format=json&action=query&list=categorymembers', { query: { categorymembers: [] } }],
  ]);
  const extras = await loadNetworkStationExtras({
    cache, log: { warn() {} }, maxAgeMs: 1, stations, usedFiles: new Set(['Abando Renfe.jpg']), nearbyBudgetMs: 5_000,
  });
  assert.equal(extras.get('m:1')?.photo, undefined, 'la de Abando ya la enseña la estación de Renfe');
  // Moyua encaja por nombre con Qx («Plaza Moyua»): esa foto es suya por Wikidata.
  assert.match(extras.get('m:2')?.photo?.page ?? '', /Moyua%20geltokia/);
});
