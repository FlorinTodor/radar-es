import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from '../../server/adapters/inbound/http/http-server.js';

test('la CSP no permite scripts en línea ni marcos de otras webs', () => {
  const csp = securityHeaders({})['Content-Security-Policy'];
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /goatcounter|gc\.zgo\.at/);
});

test('con GoatCounter configurado se permite sólo su script y su servidor de recuento', () => {
  const csp = securityHeaders({ goatcounter: 'https://radares.goatcounter.com/count' })['Content-Security-Policy'];
  assert.match(csp, /script-src 'self' https:\/\/gc\.zgo\.at;/);
  assert.match(csp, /connect-src [^;]*https:\/\/radares\.goatcounter\.com/);
});
