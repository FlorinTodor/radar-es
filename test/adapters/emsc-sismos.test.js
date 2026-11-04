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
    feature({ unid: '20261104_0000133', time: '2026-11-04T10:40:44.07Z', flynn_region: 'SPAIN', lat: 37.0767, lon: -3.6033, auth: 'IGN', mag: 1.6 }),
    feature({ unid: '20261104_0000035', time: '2026-11-04T03:23:55.5Z', flynn_region: 'SPAIN', lat: 37.08, lon: -3.57, auth: 'EMSC', mag: 2.5 }),
    feature({ unid: '20261103_0000200', time: '2026-11-03T18:08:57Z', flynn_region: 'CANARY ISLANDS, SPAIN REGION', lat: 28.1, lon: -16.0, auth: 'IGN', mag: 3.1, depth: -12 }),
    feature({ unid: '20261102_0000001', time: '2026-11-02T09:00:00Z', flynn_region: 'SPAIN', lat: 40.4, lon: -3.7, auth: 'IGN', mag: 1.8, evtype: 'qb' }), // voladura
    feature({ unid: 'mal id con espacios', time: '2026-11-02T09:00:00Z', lat: 40, lon: -3, mag: 2 }),
    feature({ unid: '20261102_0000002', time: 'no es una fecha', lat: 40, lon: -3, mag: 2 }),
    feature({ unid: '20261102_0000003', time: '2026-11-02T09:00:00Z', flynn_region: 'SOME NEW REGION', lat: 41, lon: 2, auth: 'XYZ', mag: 1.9 }),
  ],
};

test('EMSC: los terremotos pequeños de los dos últimos días, en español y marcados de respaldo; sin voladuras ni datos rotos', async () => {
  let asked = null;
  const http = { json: async (url) => { asked = url; return DOC; } };
  const { events } = await createEmscSismosSource({ http, now: () => NOW }).fetch();

  const q = new URL(asked);
  assert.equal(q.searchParams.get('starttime'), '2026-11-02T12:00:00', 'los dos días que se muestran');
  assert.equal(q.searchParams.get('minmag'), '1.5');
  assert.equal(q.searchParams.get('format'), 'json');

  assert.deepEqual(events.map((e) => e.id), ['emsc:20261104_0000133', 'emsc:20261104_0000035', 'emsc:20261103_0000200', 'emsc:20261102_0000003']);
  const [granada, dilar, canarias, otra] = events;
  assert.equal(granada.title, 'Terremoto M1.6 · España');
  assert.equal(granada.category, 'sismo');
  assert.equal(granada.severity, 'baja');
  assert.equal(granada.backup, true);
  assert.equal(granada.start, Date.parse('2026-11-04T10:40:44.07Z'));
  assert.equal(granada.url, 'https://www.seismicportal.eu/eventdetails.html?unid=20261104_0000133');
  assert.match(granada.description, /a 8 km de profundidad .*Localizado por el Instituto Geográfico Nacional \(IGN\)/);
  assert.match(dilar.description, /Localizado por el EMSC/);
  assert.equal(canarias.title, 'Terremoto M3.1 · Canarias');
  assert.equal(canarias.severity, 'media');
  assert.match(canarias.description, /a 12 km de profundidad/);
  assert.equal(otra.title, 'Terremoto M1.9 · Some New Region', 'una región sin traducir sale tal cual');
  assert.match(otra.description, /Localizado por XYZ/);
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
  assert.equal(title(first, 'emsc:20261104_0000133'), 'Terremoto M1.6 · Dílar (Granada)');
  assert.match(first.events[0].description, /profundidad cerca de Dílar \(Granada\), el /);
  assert.equal(title(first, 'emsc:20261104_0000035'), 'Terremoto M2.5 · Granada', 'capital: sin repetir la provincia');
  assert.equal(title(first, 'emsc:20261103_0000200'), 'Terremoto M3.1 · Canarias', 'en el mar no hay municipio: la región');
  assert.equal(title(first, 'emsc:20261102_0000003'), 'Terremoto M1.9 · Some New Region', 'CartoCiudad falla: la región');
  assert.equal(asked.length, 4);

  // En la siguiente lectura no se vuelve a preguntar lo ya sabido (tampoco que en el mar no hay municipio);
  // el que falló, sí.
  await source.fetch();
  assert.equal(asked.length, 5);
  assert.deepEqual(asked[4], [41, 2]);
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
