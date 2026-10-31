import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plausibleDelay, safeLink } from '../../server/domain/model.js';
import { makeIngestSource } from '../../server/application/use-cases/ingest-source.js';

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

test('plausibleDelay descarta los retrasos imposibles que Renfe publica al cambiar de día', () => {
  assert.equal(plausibleDelay(0), 0);
  assert.equal(plausibleDelay(-5), -5, 'un poco de adelanto es normal');
  assert.equal(plausibleDelay(240), 240, 'cuatro horas de retraso pueden pasar');
  assert.equal(plausibleDelay(-60), -60);
  assert.equal(plausibleDelay(720), 720);
  assert.equal(plausibleDelay(-1436), null, '-86.160 s: retraso contra el horario del día siguiente');
  assert.equal(plausibleDelay(1008), null);
  assert.equal(plausibleDelay(-61), null);
  assert.equal(plausibleDelay(NaN), null);
  assert.equal(plausibleDelay(null), null);
});

test('la ingesta guarda sin retraso los vehículos con un retraso imposible', async () => {
  let saved;
  const vehicles = [{ id: 'a', delay: -1436, lat: 40, lon: -3 }, { id: 'b', delay: 4, lat: 40, lon: -3 }, { id: 'c', delay: null, lat: 40, lon: -3 }];
  const ingest = makeIngestSource({
    sources: [{ id: 'renfe-cercanias', fetch: async () => ({ vehicles }) }],
    situation: { saveResult: (id, result) => { saved = result; }, tracks: () => new Map(), saveFailure() {} },
    publisher: { publish() {} }, clock: { now: () => 1000 }, log: { warn() {} },
  });
  await ingest('renfe-cercanias');
  assert.deepEqual(saved.vehicles.map((v) => v.delay), [null, 4, null]);
});
