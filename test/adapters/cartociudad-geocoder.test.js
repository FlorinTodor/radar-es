// Geocodificador de CartoCiudad (contrato Geocoder de los adaptadores): el pueblo de un aviso → sus coordenadas, sin
// confundirlo con otro del mismo nombre en otra comunidad. Con respuestas como las reales; sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCartoCiudadGeocoder, GEOCODER_MEMBERS } from '../../server/adapters/outbound/geo/cartociudad-geocoder.js';
import { assertPort } from '../../server/application/ports.js';

const candidate = (extra) => ({ lat: 0, lng: 0, province: 'La Rioja', comunidadAutonomaCode: '17', ...extra });
// Respuestas de /candidates (sin coordenadas, como las reales) y de /find.
function fakeHttp({ candidates = {}, find = {}, fail = false } = {}) {
  const calls = [];
  return {
    calls,
    json: async (url) => {
      calls.push(url);
      if (fail) throw new Error('HTTP 503 en www.cartociudad.es');
      const u = new URL(url);
      if (u.pathname.endsWith('/candidates')) return candidates[u.searchParams.get('q')] ?? [];
      return find[u.searchParams.get('id')] ?? {};
    },
  };
}

test('cumple el contrato Geocoder', () => {
  assert.doesNotThrow(() => assertPort('Geocoder', createCartoCiudadGeocoder({ http: fakeHttp() }), GEOCODER_MEMBERS));
});

test('prefiere la entidad de población de esa comunidad, con su nombre exacto', async () => {
  const http = fakeHttp({
    candidates: {
      Ventrosa: [
        candidate({ id: '26164', type: 'Municipio', muni: 'Ventrosa', address: 'Ventrosa' }),
        candidate({ id: '1700000197', type: 'poblacion', muni: 'Ventrosa', poblacion: 'Ventrosa', address: 'Ventrosa, Ventrosa' }),
        candidate({ id: '9', type: 'callejero', muni: 'Ventrosa', address: 'Calle Mayor' }),
      ],
    },
    find: { 1700000197: { lat: 42.1568, lng: -2.8503 } },
  });
  const geo = createCartoCiudadGeocoder({ http });
  assert.deepEqual(await geo.locate('Ventrosa', { region: '17' }), { name: 'Ventrosa', lat: 42.1568, lon: -2.8503 });
  assert.match(http.calls[1], /\/find\?q=Ventrosa%2C%20Ventrosa&type=poblacion&id=1700000197$/);
});

test('no confunde pueblos con el mismo nombre en otra comunidad o provincia', async () => {
  const http = fakeHttp({
    candidates: {
      Espera: [candidate({ id: '1', type: 'poblacion', poblacion: 'Espera', muni: 'Espera', province: 'Cádiz', comunidadAutonomaCode: '01' })],
      'San Pedro': [candidate({ id: '2', type: 'poblacion', poblacion: 'San Pedro', province: 'Albacete', comunidadAutonomaCode: '08' })],
    },
    find: { 1: { lat: 36.87, lng: -5.8 }, 2: { lat: 38.8, lng: -2.2 } },
  });
  const geo = createCartoCiudadGeocoder({ http });
  assert.equal(await geo.locate('Espera', { region: '17' }), null, 'Espera está en Andalucía, no en La Rioja');
  assert.deepEqual(await geo.locate('Espera', { region: '01' }), { name: 'Espera', lat: 36.87, lon: -5.8 });
  assert.equal(await geo.locate('San Pedro', { region: '08', province: 'Toledo' }), null);
  assert.equal(await geo.locate('Espe', { region: '01' }), null, 'sólo nombres exactos (sin tildes ni mayúsculas)');
});

test('cada lugar se pregunta una vez (también los que no existen); un fallo de red se vuelve a intentar', async () => {
  const http = fakeHttp({ candidates: { Trebujena: [candidate({ id: '3', type: 'Municipio', muni: 'Trebujena', comunidadAutonomaCode: '01' })] }, find: { 3: { lat: 36.87, lng: -6.17 } } });
  const geo = createCartoCiudadGeocoder({ http });
  await geo.locate('Trebujena', { region: '01' });
  await geo.locate('trebujena', { region: '01' });
  await geo.locate('Comité Asesor', { region: '01' });
  await geo.locate('Comité Asesor', { region: '01' });
  assert.equal(http.calls.length, 3, 'Trebujena: candidatos + find; el que no existe, sólo candidatos y una vez');

  const down = fakeHttp({ fail: true });
  const warnings = [];
  const geo2 = createCartoCiudadGeocoder({ http: down, log: { warn: (m) => warnings.push(m) } });
  await assert.rejects(geo2.locate('Ventrosa', { region: '17' }), /HTTP 503/, 'un fallo de red no es «no existe»');
  await assert.rejects(geo2.locate('Ventrosa', { region: '17' }), /HTTP 503/);
  assert.equal(down.calls.length, 2, 'no se guarda un fallo de red');
  assert.match(warnings[0], /\[cartociudad\] Ventrosa: HTTP 503/);
});

test('descarta coordenadas fuera de España o el 0,0 con el que a veces responde', async () => {
  const http = fakeHttp({
    candidates: { Rara: [candidate({ id: '4', type: 'poblacion', poblacion: 'Rara' })] },
    find: { 4: { lat: 0, lng: 0 } },
  });
  assert.equal(await createCartoCiudadGeocoder({ http }).locate('Rara'), null);
});

test('placeAt: el municipio y la provincia de un punto (respuesta real de Dílar); en el mar, null; cada punto una vez', async () => {
  const calls = [];
  const replies = {
    '37.07670': JSON.stringify({ id: '01.18.MUN_180680080753', province: 'Granada', muni: 'Dílar', type: 'portal', address: 'ALEGRE', poblacion: 'Dílar' }),
    '36.40000': '', // en el mar CartoCiudad responde vacío
  };
  let fail = false;
  const http = {
    text: async (url) => {
      calls.push(url);
      if (fail) throw new Error('HTTP 503 en www.cartociudad.es');
      return replies[new URL(url).searchParams.get('lat')] ?? '{"muni": 7}';
    },
  };
  const geo = createCartoCiudadGeocoder({ http });
  assert.deepEqual(await geo.placeAt(37.0767, -3.6033), { muni: 'Dílar', province: 'Granada' });
  assert.match(calls[0], /\/reverseGeocode\?lat=37\.07670&lon=-3\.60330$/);
  assert.equal(await geo.placeAt(36.4, -7.9), null);
  assert.equal(await geo.placeAt(38.5, -1.2), null, 'sin un municipio de texto, null');
  assert.equal(await geo.placeAt(0, 0), null, 'fuera de España ni se pregunta');
  assert.equal(await geo.placeAt(Number.NaN, 2), null);
  assert.equal(calls.length, 3);
  await geo.placeAt(37.07671, -3.60331); // el mismo sitio, a unos metros
  await geo.placeAt(36.4, -7.9);
  assert.equal(calls.length, 3, 'lo ya preguntado no se repite, tampoco que en el mar no hay municipio');
  fail = true;
  await assert.rejects(geo.placeAt(39.47, -0.38), /503/);
});
