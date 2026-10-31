import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goatcounterUrl, loadConfig, publicUrl } from '../../server/config.js';

test('goatcounterUrl acepta la URL de recuento y rechaza lo demás', () => {
  assert.equal(goatcounterUrl('https://radares.goatcounter.com/count'), 'https://radares.goatcounter.com/count');
  assert.equal(goatcounterUrl('  https://radares.goatcounter.com/count\n'), 'https://radares.goatcounter.com/count');
  assert.equal(goatcounterUrl(undefined), null);
  assert.equal(goatcounterUrl(''), null);
  assert.equal(goatcounterUrl('http://radares.goatcounter.com/count'), null);
  assert.equal(goatcounterUrl('https://radares.goatcounter.com/'), null);
  assert.equal(goatcounterUrl('javascript:alert(1)//count'), null);
});

test('sin GOATCOUNTER_URL el contador queda desactivado', () => {
  assert.equal(loadConfig({}).about.goatcounter, null);
  assert.equal(loadConfig({ GOATCOUNTER_URL: 'https://radares.goatcounter.com/count' }).about.goatcounter,
    'https://radares.goatcounter.com/count');
});

test('publicUrl acepta sólo URL http(s) y se queda con el origen (en punycode)', () => {
  assert.equal(publicUrl('https://xn--radarespaa-19a.es'), 'https://xn--radarespaa-19a.es');
  assert.equal(publicUrl('https://radarespaña.es/'), 'https://xn--radarespaa-19a.es');
  assert.equal(publicUrl(' https://xn--radarespaa-19a.es/legal \n'), 'https://xn--radarespaa-19a.es');
  assert.equal(publicUrl('radarespaña.es'), null, 'sin esquema: el servidor arranca igual, sin redirección de www');
  assert.equal(publicUrl('javascript:alert(1)'), null);
  assert.equal(publicUrl(undefined), null);
  assert.equal(publicUrl(''), null);
});
