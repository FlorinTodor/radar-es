import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeLink } from '../../server/domain/model.js';

test('safeLink sólo deja pasar enlaces http(s)', () => {
  assert.equal(safeLink('https://www.aemet.es/es/eltiempo/prediccion/avisos'), 'https://www.aemet.es/es/eltiempo/prediccion/avisos');
  assert.equal(safeLink(' http://www.gdacs.org/report.aspx?eventid=1 '), 'http://www.gdacs.org/report.aspx?eventid=1');
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeLink('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(safeLink('/relativo'), null);
  assert.equal(safeLink(''), null);
  assert.equal(safeLink(undefined), null);
  assert.equal(safeLink({ href: 'https://x' }), null);
});
