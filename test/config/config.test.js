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

test('bot de Telegram: sin un token con forma de token no hay bot; el usuario sólo si es de bot; nunca el token en about', () => {
  assert.equal(loadConfig({}).telegram, null);
  assert.equal(loadConfig({}).about.telegram, null);
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: 'no-es-un-token' }).telegram, null);
  const token = '123456789:AAHfakefakefakefakefakefakefake_-12';
  const c = loadConfig({ TELEGRAM_BOT_TOKEN: ` ${token} `, TELEGRAM_BOT_USERNAME: '@RadarEspanaBot' });
  assert.deepEqual(c.telegram, { token, username: 'RadarEspanaBot', webUrl: 'https://radarespana.es' });
  assert.deepEqual(c.about.telegram, { bot: 'RadarEspanaBot' });
  assert.doesNotMatch(JSON.stringify(c.about), /AAHfake/, 'el token no va a /api/about');
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: 'RadarEspana' }).telegram.username, null, 'un usuario de bot acaba en «bot»');
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: 'RadarEspana' }).about.telegram, null);
  assert.equal(loadConfig({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEB_URL: 'https://xn--radarespaa-19a.es/' }).telegram.webUrl, 'https://xn--radarespaa-19a.es');
});
