import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEmscSismosSource } from '../../server/adapters/outbound/sources/emsc-sismos.js';
import { withoutRepeatedQuakes } from '../../server/domain/sismos.js';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const feature = (props) => ({ type: 'Feature', properties: { evtype: 'ke', magtype: 'ml', depth: 7.6, ...props } });
// Respuesta real del 4-nov-2026 (enjambre de Granada), recortada.
const DOC = {
  type: 'FeatureCollection',
  features: [
    feature({ unid: '20261104_0000133', time: '2026-11-04T10:40:44.07Z', flynn_region: 'SPAIN', lat: 37.0767, lon: -3.6033, auth: 'IGN', mag: 1.6 }), // del IGN: sale de su fuente
    feature({ unid: '20261104_0000035', time: '2026-11-04T03:23:55.5Z', flynn_region: 'SPAIN', lat: 37.08, lon: -3.57, auth: 'EMSC', mag: 2.5 }),
    feature({ unid: '20261103_0000200', time: '2026-11-03T18:08:57Z', flynn_region: 'CANARY ISLANDS, SPAIN REGION', lat: 28.1, lon: -16.0, auth: 'EMSC', mag: 3.1, depth: -12 }),
    feature({ unid: '20261102_0000001', time: '2026-11-02T09:00:00Z', flynn_region: 'SPAIN', lat: 40.4, lon: -3.7, auth: 'EMSC', mag: 1.8, evtype: 'qb' }), // voladura
    feature({ unid: 'mal id con espacios', time: '2026-11-02T09:00:00Z', lat: 40, lon: -3, mag: 2 }),
    feature({ unid: '20261102_0000002', time: 'no es una fecha', lat: 40, lon: -3, mag: 2 }),
    feature({ unid: '20261102_0000003', time: '2026-11-02T09:00:00Z', flynn_region: 'SOME NEW REGION', lat: 41, lon: 2, auth: 'XYZ', mag: 1.9 }),
  ],
};
// Regiones que no dicen bien el sitio o que no estaban traducidas.
const MORE = [
  feature({ unid: '20261103_0000214', time: '2026-11-03T05:21:00Z', flynn_region: 'STRAIT OF GIBRALTAR', lat: 36.6062, lon: -7.2136, auth: 'EMSC', mag: 2.3 }),
  feature({ unid: '20261103_0000120', time: '2026-11-03T10:23:00Z', flynn_region: 'NEAR SOUTH COAST OF FRANCE', lat: 43.7746, lon: 3.3095, auth: 'ReNaSS', mag: 2.1 }),
  feature({ unid: '20261104_0000099', time: '2026-11-04T03:00:00Z', flynn_region: 'WEST OF GIBRALTAR', lat: 36.44, lon: -9.94, auth: 'LDG', mag: 2.4 }),
];

test('EMSC: los terremotos pequeños de los dos últimos días que no localiza el IGN, en español y marcados de respaldo; sin voladuras ni datos rotos', async () => {
  let asked = null;
  const http = { json: async (url) => { asked = url; return { ...DOC, features: [...DOC.features, ...MORE] }; } };
  const { events } = await createEmscSismosSource({ http, now: () => NOW }).fetch();

  const q = new URL(asked);
  assert.equal(q.searchParams.get('starttime'), '2026-11-02T12:00:00', 'los dos días que se muestran');
  assert.equal(q.searchParams.get('minmag'), '1.5');
  assert.equal(q.searchParams.get('format'), 'json');

  assert.deepEqual(events.map((e) => e.id), ['emsc:20261104_0000035', 'emsc:20261103_0000200', 'emsc:20261102_0000003',
    'emsc:20261103_0000214', 'emsc:20261103_0000120', 'emsc:20261104_0000099'], 'sin el que localiza el IGN');
  const [granada, canarias, otra, estrecho, francia, oeste] = events;
  assert.equal(granada.title, 'Terremoto M2.5 · España');
  assert.equal(granada.category, 'sismo');
  assert.equal(granada.severity, 'baja');
  assert.equal(granada.backup, true);
  assert.equal(granada.start, Date.parse('2026-11-04T03:23:55.5Z'));
  assert.equal(granada.url, 'https://www.seismicportal.eu/eventdetails.html?unid=20261104_0000035');
  assert.match(granada.description, /a 8 km de profundidad \(España\), el 4\/11\/26, 4:23\. Localizado por el EMSC/);
  assert.equal(canarias.title, 'Terremoto M3.1 · Canarias');
  assert.equal(canarias.severity, 'media');
  assert.match(canarias.description, /a 12 km de profundidad \(Canarias\), el 3\/11\/26, 18:08 \(hora de Canarias\)\./);
  assert.equal(otra.title, 'Terremoto M1.9 · Some New Region', 'una región sin traducir sale tal cual');
  assert.match(otra.description, /Localizado por XYZ/);
  // La región «STRAIT OF GIBRALTAR» va del golfo de Cádiz a Almería: no se dice que es en el Estrecho.
  assert.equal(estrecho.title, 'Terremoto M2.3 · Golfo de Cádiz, Estrecho o Alborán');
  assert.equal(francia.title, 'Terremoto M2.1 · Costa sur de Francia');
  assert.match(francia.description, /Localizado por el ReNaSS \(Francia\)/);
  assert.equal(oeste.title, 'Terremoto M2.4 · Atlántico, al oeste del Estrecho');
  assert.match(oeste.description, /Localizado por el LDG-CEA \(Francia\)/);
});

test('EMSC: el municipio lo pone CartoCiudad, unos pocos nuevos en cada lectura; si no responde, la región', async () => {
  const asked = [];
  const geocoder = {
    placeAt: async (lat, lon) => {
      asked.push([lat, lon]);
      if (lat > 40) throw new Error('HTTP 503 en www.cartociudad.es');
      return lat === 37.08 ? { muni: 'Granada', province: 'Granada' } : lat > 37 ? { muni: 'Dílar', province: 'Granada' } : null;
    },
  };
  const source = createEmscSismosSource({ http: { json: async () => DOC }, now: () => NOW, geocoder });
  const first = await source.fetch();
  const title = (r, id) => r.events.find((e) => e.id === id).title;
  assert.equal(title(first, 'emsc:20261104_0000035'), 'Terremoto M2.5 · Granada', 'capital: sin repetir la provincia');
  assert.match(first.events[0].description, /profundidad cerca de Granada, el /);
  assert.equal(title(first, 'emsc:20261103_0000200'), 'Terremoto M3.1 · Canarias', 'en el mar no hay municipio: la región');
  assert.equal(title(first, 'emsc:20261102_0000003'), 'Terremoto M1.9 · Some New Region', 'CartoCiudad falla: la región');
  assert.equal(asked.length, 3, 'por el del IGN no se pregunta');

  // En la siguiente lectura no se vuelve a preguntar lo ya sabido (tampoco que en el mar no hay municipio);
  // el que falló, sí.
  await source.fetch();
  assert.equal(asked.length, 4);
  assert.deepEqual(asked[3], [41, 2]);
});

test('EMSC: una respuesta sin terremotos o rara no rompe la lectura', async () => {
  for (const doc of [{}, { features: null }, { features: [null, 1, 'x'] }, null]) {
    const { events } = await createEmscSismosSource({ http: { json: async () => doc }, now: () => NOW }).fetch();
    assert.deepEqual(events, []);
  }
});

test('un terremoto que publican el IGN y el EMSC sale una vez, el del IGN; los que sólo tiene el EMSC se quedan', () => {
  const T = Date.parse('2026-11-01T19:41:42Z');
  const ign = { id: 'ign:1', category: 'sismo', magnitude: 2.6, lat: 36.4, lon: -7.9, start: T };
  const mismoEmsc = { id: 'emsc:1', category: 'sismo', magnitude: 2.7, lat: 36.45, lon: -7.85, start: T + 2_000, backup: true };
  const granada = { id: 'emsc:2', category: 'sismo', magnitude: 1.6, lat: 37.08, lon: -3.6, start: T, backup: true };
  const mismoSitioOtraHora = { id: 'emsc:3', category: 'sismo', magnitude: 1.9, lat: 36.4, lon: -7.9, start: T + 10 * 60_000, backup: true };
  const trafico = { id: 'dgt:1', category: 'carretera', lat: 36.4, lon: -7.9, start: T, backup: true };

  assert.deepEqual(withoutRepeatedQuakes([ign, mismoEmsc, granada, mismoSitioOtraHora, trafico]).map((e) => e.id),
    ['ign:1', 'emsc:2', 'emsc:3', 'dgt:1']);
  assert.deepEqual(withoutRepeatedQuakes([mismoEmsc, granada]).map((e) => e.id), ['emsc:1', 'emsc:2'], 'sin el del IGN, se quedan');
  const sinRespaldo = [ign, trafico];
  assert.equal(withoutRepeatedQuakes(sinRespaldo), sinRespaldo, 'sin terremotos de respaldo, la misma lista');
});
