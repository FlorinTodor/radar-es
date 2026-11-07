import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { FGC_DAILY_QUOTA, FGC_INTERVAL_MS } from '../../server/adapters/outbound/sources/fgc.js';

const root = new URL('../../', import.meta.url);
const pem = readFileSync(new URL('server/certs/intermedios.pem', root), 'utf8');
const certs = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map((m) => new X509Certificate(m[0]));

test('el intermedio de GlobalSign que no envía AMB está y es el que debe', () => {
  const gs = certs.find((c) => /CN=GlobalSign RSA OV SSL CA 2018/.test(c.subject));
  assert.ok(gs, 'falta el intermedio de GlobalSign');
  assert.equal(gs.fingerprint256, 'B6:76:FF:A3:17:9E:88:12:09:3A:1B:5E:AF:EE:87:6A:E7:A6:AA:F2:31:07:8D:AD:1B:FB:21:CD:28:93:76:4A');
  assert.match(gs.issuer, /CN=GlobalSign/);
  assert.ok(gs.ca, 'debe ser un certificado de autoridad');
});

test('los intermedios siguen vigentes (si caduca uno, hay que cambiarlo)', () => {
  for (const c of certs) assert.ok(Date.parse(c.validTo) > Date.now(), `caducado: ${c.subject}`);
});

test('la imagen y el arranque local cargan los intermedios', () => {
  assert.match(readFileSync(new URL('Dockerfile', root), 'utf8'), /^ENV NODE_EXTRA_CA_CERTS=\/app\/server\/certs\/intermedios\.pem$/m);
  assert.match(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts.start, /NODE_EXTRA_CA_CERTS=server\/certs\/intermedios\.pem /);
});

test('FGC: producción y pruebas juntas no agotan su cupo diario', () => {
  const lectores = 2; // producción y pruebas leen desde la misma IP
  assert.ok(lectores * 86_400_000 / FGC_INTERVAL_MS <= FGC_DAILY_QUOTA * 0.8, 'deja al menos un 20 % de margen');
});
