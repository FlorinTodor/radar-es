// e·sios (Red Eléctrica): demanda real y programada de cada sistema aislado, con los datos tal y como
// llegan de su API (también la hora de Canarias, que trae una hora de menos). Sin red ni esperas: http
// falso y el reloj de la fuente fijado (`now`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESIOS_SYSTEMS, createEsiosSource, parseEsiosDemand } from '../../server/adapters/outbound/sources/esios.js';
import { GRID_METRICS, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { SISTEMAS_AISLADOS } from '../../server/domain/lugares.js';

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
  const palma = systems.find((s) => s.id === 'la-palma');
  assert.deepEqual(palma, { id: 'la-palma', name: 'La Palma', real: 0, programmed: 21, recentMax: 20.7, at: Date.parse('2026-11-02T06:40:00Z') },
    'el corte fue a las 06:42 hora canaria (UTC), no a las 05:40 UTC');
  const ceuta = systems.find((s) => s.id === 'ceuta');
  assert.equal(ceuta.at, Date.parse('2026-11-02T06:40:00Z'), 'Ceuta y Melilla ya vienen bien');
  assert.ok(!systems.some((s) => s.name === 'Tenerife - La Gomera'), 'el sistema que suma dos islas no se repite');
  assert.ok(!systems.some((s) => s.name === 'Baleares'), 'Baleares sólo tiene la programada');
});

test('sin demanda programada para ese momento, programmed queda a null', () => {
  const [s] = parseEsiosDemand({ indicator: { values: [value(49, 'Melilla', '2026-11-02T06:40:00Z', 27.9)] } }, { indicator: { values: [] } });
  assert.equal(s.programmed, null);
  assert.deepEqual(parseEsiosDemand(null, null), []);
});

test('la fuente pide su token en una cabecera (nunca en la URL) y lo declara en `requires`', async () => {
  const calls = [];
  const http = { json: async (url, opts) => { calls.push({ url, opts }); return url.includes('/1740?') ? REAL : PROGRAMMED; } };
  const src = createEsiosSource({ http, env: { ESIOS_TOKEN: 'token-de-prueba' }, now: () => Date.parse('2026-11-02T06:45:00Z') });
  // Lo que la desactiva sin token es el registro de fuentes al ver `requires`: aquí sólo se comprueba que lo declara.
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

test('un dato vacío (null o "") no es 0 MW: no cuenta como apagón', () => {
  const real = { indicator: { values: [
    value(8797, 'Tenerife', '2026-11-02T05:35:00Z', 381.4),
    value(8797, 'Tenerife', '2026-11-02T05:40:00Z', null),
    value(8799, 'La Gomera', '2026-11-02T05:40:00Z', ''),
  ] } };
  const programmed = { indicator: { values: [value(8797, 'Tenerife', '2026-11-02T05:35:00Z', null), value(8797, 'Tenerife', '2026-11-02T05:40:00Z', 383)] } };
  const systems = parseEsiosDemand(real, programmed);
  const tenerife = systems.find((s) => s.name === 'Tenerife');
  assert.equal(tenerife.real, 381.4, 'el último dato bueno, no el vacío');
  assert.equal(tenerife.programmed, null, 'la programada vacía de ese momento tampoco es 0');
  assert.ok(!systems.some((s) => s.name === 'La Gomera'), 'un sistema sólo con datos vacíos no sale');
});

test('cada sistema de e·sios tiene su sitio en el dominio (SISTEMAS_AISLADOS), por su clave y no por el nombre', () => {
  for (const [geoId, id] of ESIOS_SYSTEMS) {
    const place = SISTEMAS_AISLADOS.find((p) => p.id === id);
    assert.ok(place, `geo_id ${geoId} → ${id} no está en SISTEMAS_AISLADOS`);
    assert.ok(Number.isFinite(place.lat) && Number.isFinite(place.lon), id);
  }
  assert.equal(new Set(ESIOS_SYSTEMS.values()).size, ESIOS_SYSTEMS.size, 'dos geo_id no pueden ir al mismo sistema');
});

test('la métrica lleva la atribución de Red Eléctrica y la hora del dato, y su id es el que lee la regla', async () => {
  const http = { json: async (url) => (url.includes('/1740?') ? REAL : PROGRAMMED) };
  const src = createEsiosSource({ http, env: { ESIOS_TOKEN: 'x' }, now: () => Date.parse('2026-11-02T06:45:00Z') });
  assert.equal(src.id, GRID_METRICS.aislados);
  const { metrics } = await src.fetch();
  assert.equal(metrics.credit, 'Fuente: Red Eléctrica (e·sios)');
  assert.equal(metrics.at, Date.parse('2026-11-02T06:40:00Z'));
  assert.ok(metrics.systems.every((s) => Number.isFinite(s.at)), 'y cada sistema, la hora de su dato');
  // De la fuente a la regla, por la clave del dominio: el apagón de La Palma sale en La Palma.
  const ctx = {
    now: Date.parse('2026-11-02T06:50:00Z'), vehicles: [], tracks: new Map(), events: [], health: [], kpis: { vehicles: 0 }, kpiHistory: [],
    nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS, metrics: { [src.id]: metrics },
  };
  const [alert] = isolatedGridBlackouts(ctx);
  assert.equal(alert.id, 'red-aislada:la-palma');
  assert.equal(alert.title, 'Posible apagón total en La Palma: demanda a 0 MW');
  assert.deepEqual([alert.lat, alert.lon], [28.68, -17.86]);
});
