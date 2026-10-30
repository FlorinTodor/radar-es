import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goatcounterUrl, loadConfig } from '../../server/config.js';

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
