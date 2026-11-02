// e·sios (Red Eléctrica): demanda real y programada de cada sistema aislado, con los datos tal y como
// llegan de su API (también la hora de Canarias, que trae una hora de menos). Sin red ni esperas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEsiosSource, parseEsiosDemand } from '../../server/adapters/outbound/sources/esios.js';

const value = (geo_id, geo_name, utc, v) => ({ geo_id, geo_name, value: v, datetime_utc: utc, datetime: utc.replace('Z', '.000+01:00') });
// Así llegó el apagón de La Palma del 2-11-2026 (05:35 y 05:40 «UTC» = 06:35 y 06:40 hora canaria).
const REAL = { indicator: { id: 1740, values: [
  value(8798, 'La Palma', '2026-11-02T05:35:00Z', 20.7),
  value(8798, 'La Palma', '2026-11-02T05:40:00Z', 0),
  value(8797, 'Tenerife', '2026-11-02T05:40:00Z', 380.2),
  value(8831, 'Tenerife - La Gomera', '2026-11-02T05:40:00Z', 389.1),
  value(12, 'Ceuta', '2026-11-02T06:40:00Z', 29.3),
] } };
const PROGRAMMED = { indicator: { id: 1741, values: [
  value(8798, 'La Palma', '2026-11-02T05:40:00Z', 21.0),
  value(8797, 'Tenerife', '2026-11-02T05:40:00Z', 383.0),
  value(8823, 'Baleares', '2026-11-02T06:40:00Z', 586),
  value(12, 'Ceuta', '2026-11-02T06:40:00Z', 30),
] } };

test('último dato de cada sistema con su demanda programada; Canarias, con su hora de verdad', () => {
  const systems = parseEsiosDemand(REAL, PROGRAMMED);
  const palma = systems.find((s) => s.name === 'La Palma');
  assert.deepEqual(palma, { id: 8798, name: 'La Palma', real: 0, programmed: 21, recentMax: 20.7, at: Date.parse('2026-11-02T06:40:00Z') },
    'el corte fue a las 06:42 hora canaria (UTC), no a las 05:40 UTC');
  const ceuta = systems.find((s) => s.name === 'Ceuta');
  assert.equal(ceuta.at, Date.parse('2026-11-02T06:40:00Z'), 'Ceuta y Melilla ya vienen bien');
  assert.ok(!systems.some((s) => s.name === 'Tenerife - La Gomera'), 'el sistema que suma dos islas no se repite');
  assert.ok(!systems.some((s) => s.name === 'Baleares'), 'Baleares sólo tiene la programada');
});

test('sin demanda programada para ese momento, programmed queda a null', () => {
  const [s] = parseEsiosDemand({ indicator: { values: [value(49, 'Melilla', '2026-11-02T06:40:00Z', 27.9)] } }, { indicator: { values: [] } });
  assert.equal(s.programmed, null);
  assert.deepEqual(parseEsiosDemand(null, null), []);
});

test('la fuente pide su token en una cabecera (nunca en la URL) y se desactiva sin él', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T06:45:00Z') });
  const calls = [];
  const http = { json: async (url, opts) => { calls.push({ url, opts }); return url.includes('/1740?') ? REAL : PROGRAMMED; } };
  const src = createEsiosSource({ http, env: { ESIOS_TOKEN: 'token-de-prueba' } });
  assert.deepEqual(src.requires, ['ESIOS_TOKEN']);
  const { metrics, sourceTime } = await src.fetch();
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.opts.headers['x-api-key'], 'token-de-prueba');
    assert.ok(!c.url.includes('token-de-prueba'));
    assert.match(c.url, /^https:\/\/api\.esios\.ree\.es\/indicators\/174[01]\?start_date=2026-11-02T03:45:00Z&end_date=2026-11-02T07:00:00Z$/);
  }
  assert.ok(!src.url.includes('token') && !src.page.includes('token'));
  assert.equal(metrics.systems.length, 3);
  assert.equal(sourceTime, Date.parse('2026-11-02T06:40:00Z'));
  assert.match(src.license, /^Fuente: Red Eléctrica \(e·sios\)\. Uso informativo, sin fines comerciales/);
});

test('lo que consumía hace poco: las dos últimas horas en hora real, no lo que se haya leído', () => {
  const values = [value(12, 'Ceuta', '2026-11-02T03:30:00Z', 45), value(12, 'Ceuta', '2026-11-02T04:45:00Z', 31), value(12, 'Ceuta', '2026-11-02T06:40:00Z', 0)];
  const [ceuta] = parseEsiosDemand({ indicator: { values } }, { indicator: { values: [] } });
  assert.equal(ceuta.recentMax, 31, 'el 45 de hace más de dos horas no cuenta');
});
