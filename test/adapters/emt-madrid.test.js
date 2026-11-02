// Avisos de EMT Madrid con las claves de nuestra aplicación en MobilityLabs: se entra una vez, se
// reutiliza el token hasta que caduca y las claves nunca salen en un error. Claves y token de mentira.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEmtMadridAlertsSource } from '../../server/adapters/outbound/sources/emt-madrid.js';

const { transit_realtime: rt } = createRequire(import.meta.url)('gtfs-realtime-bindings');
const NOW = Date.parse('2026-11-02T12:00:00Z');
const ENV = { EMT_MADRID_CLIENT_ID: 'id-de-prueba', EMT_MADRID_PASSKEY: 'clave-de-prueba' };
const feed = () => rt.FeedMessage.encode(rt.FeedMessage.fromObject({
  header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000 },
  entity: [1, 2].map((n) => ({ id: `a${n}`, alert: { // el mismo aviso, repetido por cada línea afectada
    effect: 'DETOUR', headerText: { translation: [{ text: 'Desvío por obras', language: 'es' }] },
    descriptionText: { translation: [{ text: 'Calle Mayor cortada', language: 'es' }] },
  } })),
})).finish();

/** EMT de mentira: cuenta los logins y exige el token vigente. */
function fakeEmt({ tokenSec = 86_400, code = '00' } = {}) {
  const calls = { login: [], alerts: [] };
  let valid = null;
  let n = 0;
  return {
    calls,
    expire() { valid = null; },
    http: {
      async json(url, { headers }) {
        calls.login.push({ url, headers });
        if (code !== '00') return { code, description: 'Credenciales no válidas', data: [] };
        valid = `token-${++n}`;
        return { code: '00', description: `Register user: x with token: ${valid}`, data: [{ accessToken: valid, tokenSecExpiration: tokenSec }] };
      },
      async bytes(url, { headers }) {
        calls.alerts.push(headers.accessToken);
        if (headers.accessToken !== valid) throw new Error('HTTP 401 en openapi.emtmadrid.es');
        return feed();
      },
    },
  };
}

test('entra con X-ClientId y passKey, y lee los avisos con su token (sin repetidos)', async () => {
  const emt = fakeEmt();
  const source = createEmtMadridAlertsSource({ http: emt.http, env: ENV, now: () => NOW });
  assert.deepEqual(source.requires, ['EMT_MADRID_CLIENT_ID', 'EMT_MADRID_PASSKEY']);
  assert.match(source.license, /Powered by EMT de Madrid/);
  const result = await source.fetch();
  assert.equal(emt.calls.login[0].url, 'https://openapi.emtmadrid.es/v1/mobilitylabs/user/login/');
  assert.deepEqual(emt.calls.login[0].headers, { 'X-ClientId': 'id-de-prueba', passKey: 'clave-de-prueba' });
  assert.deepEqual(emt.calls.alerts, ['token-1']);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].title, 'EMT Madrid · Desvío por obras');
  assert.equal(result.sourceTime, NOW);
});

test('el token se reutiliza hasta poco antes de caducar; después se entra otra vez', async () => {
  let t = NOW;
  const emt = fakeEmt({ tokenSec: 3_600 });
  const source = createEmtMadridAlertsSource({ http: emt.http, env: ENV, now: () => t });
  await source.fetch();
  t += 50 * 60_000;
  await source.fetch();
  assert.equal(emt.calls.login.length, 1, 'a los 50 min sigue valiendo');
  t += 6 * 60_000; // quedan menos de 5 min: se renueva antes de usarlo
  await source.fetch();
  assert.equal(emt.calls.login.length, 2);
});

test('si EMT da el token por caducado antes de tiempo, se entra otra vez y se reintenta', async () => {
  const emt = fakeEmt();
  const source = createEmtMadridAlertsSource({ http: emt.http, env: ENV, now: () => NOW });
  await source.fetch();
  emt.expire();
  const result = await source.fetch();
  assert.equal(result.events.length, 1);
  assert.deepEqual(emt.calls.alerts, ['token-1', 'token-1', 'token-2']);
});

test('con claves rechazadas, el error no lleva ni las claves ni nada de la respuesta', async () => {
  const emt = fakeEmt({ code: '80' });
  const source = createEmtMadridAlertsSource({ http: emt.http, env: ENV, now: () => NOW });
  await assert.rejects(source.fetch(), (err) => {
    assert.match(err.message, /no acepta las claves de MobilityLabs \(código 80\)/);
    assert.doesNotMatch(err.message, /prueba|Credenciales/);
    return true;
  });
});
