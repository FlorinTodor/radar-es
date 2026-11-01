// Datos extra de las estaciones: Wikidata por código de estación, foto con autor y licencia de
// Commons y fichas de Renfe; la accesibilidad de Renfe manda sobre la de Wikidata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommons, parseWikidata, sheetCodes } from '../../server/adapters/outbound/stations/station-extras.js';
import { withExtras } from '../../server/adapters/outbound/stations/renfe-station-catalog.js';

const v = (value) => ({ value });

test('Wikidata: código de 5 cifras, accesibilidad, foto, año, vías y Wikipedia; el primer valor gana', () => {
  const json = { results: { bindings: [
    { code: v('5100'), acc: v('http://www.wikidata.org/entity/Q24192069'), img: v('http://commons.wikimedia.org/wiki/Special:FilePath/Estaci%C3%B3n_de_Llanes.jpg'),
      open: v('1905-07-23T00:00:00Z'), tracks: v('3'), wp: v('https://es.wikipedia.org/wiki/Estaci%C3%B3n_de_Llanes') },
    { code: v('5100'), img: v('http://commons.wikimedia.org/wiki/Special:FilePath/Otra.jpg'), tracks: v('4') },
    { code: v('60000'), acc: v('http://www.wikidata.org/entity/Q24192068'), wp: v('https://en.wikipedia.org/wiki/Atocha') },
    { code: v('Madrid') },
  ] } };
  const out = parseWikidata(json);
  assert.deepEqual(out.get('05100'), {
    accessible: false, image: 'Estación de Llanes.jpg', opened: 1905, tracks: 3, wikipedia: 'https://es.wikipedia.org/wiki/Estaci%C3%B3n_de_Llanes',
  });
  assert.deepEqual(out.get('60000'), { accessible: 'partial' }); // sólo la Wikipedia en español
  assert.equal(out.size, 2);
});

test('Commons: foto con autor y licencia en texto; sin licencia no hay foto', () => {
  const json = { query: {
    normalized: [{ from: 'File:Estación_de_Llanes.jpg', to: 'File:Estación de Llanes.jpg' }],
    pages: {
      1: { title: 'File:Estación de Llanes.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/a.jpg?utm_source=commons.wikimedia.org', descriptionurl: 'https://commons.wikimedia.org/wiki/File:a',
        extmetadata: { Artist: v('<a href="//x">Pepe &amp; Ana</a>'), LicenseShortName: v('CC BY-SA 4.0'), LicenseUrl: v('https://creativecommons.org/licenses/by-sa/4.0') } }] },
      2: { title: 'File:Sin licencia.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/b.jpg', extmetadata: {} }] },
    },
  } };
  const out = parseCommons(json);
  assert.deepEqual([...out.keys()], ['Estación_de_Llanes.jpg']);
  assert.deepEqual(out.get('Estación_de_Llanes.jpg'), {
    url: 'https://upload.wikimedia.org/a.jpg', page: 'https://commons.wikimedia.org/wiki/File:a', author: 'Pepe & Ana',
    license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  });
});

test('fichas de Renfe: los códigos de los PDF enlazados en sus listados', () => {
  const csv = 'CÓDIGO;DESCRIPCION;Fichas\n05102;SAN XOAN;https://data.renfe.com/files/estaciones/FichaEstacion05102.pdf\n05103;X;\n';
  assert.deepEqual([...sheetCodes(csv)], ['05102']);
});

test('la accesibilidad de Renfe manda; la de Wikidata cubre las que no tienen dato, y cada una dice su fuente', () => {
  const stations = [{ code: '15211', accessible: true }, { code: '75101', accessible: null }, { code: '22401', accessible: null }];
  const extras = new Map([['15211', { accessible: false, opened: 1874 }], ['75101', { accessible: 'partial', sheet: 'x.pdf' }]]);
  assert.deepEqual(withExtras(stations, extras), [
    { code: '15211', accessible: true, accessibleSource: 'Renfe', opened: 1874 },
    { code: '75101', accessible: 'partial', accessibleSource: 'Wikidata', sheet: 'x.pdf' },
    { code: '22401', accessible: null, accessibleSource: null },
  ]);
});
