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
  assert.deepEqual(palma, {
    id: 'la-palma', name: 'La Palma', real: 0, programmed: 21, recentMax: 20.7, readMax: 20.7,
    previous: { real: 20.7, at: Date.parse('2026-11-02T06:35:00Z') }, at: Date.parse('2026-11-02T06:40:00Z'),
  },
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
    // Seis horas reales: siete en la hora de e·sios, que pone la de Canarias una hora por detrás.
    assert.match(c.url, /^https:\/\/api\.esios\.ree\.es\/indicators\/174[01]\?start_date=2026-11-01T23:45:00Z&end_date=2026-11-02T07:00:00Z$/);
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
  // Con el segundo dato a cero de La Palma (la regla pide dos seguidos).
  const real = { indicator: { values: [...REAL.indicator.values, value(8798, 'La Palma', '2026-11-02T05:45:00Z', 0)] } };
  const http = { json: async (url) => (url.includes('/1740?') ? real : PROGRAMMED) };
  const src = createEsiosSource({ http, env: { ESIOS_TOKEN: 'x' }, now: () => Date.parse('2026-11-02T06:50:00Z') });
  assert.equal(src.id, GRID_METRICS.aislados);
  const { metrics } = await src.fetch();
  assert.equal(metrics.credit, 'Fuente: Red Eléctrica (e·sios)');
  assert.equal(metrics.at, Date.parse('2026-11-02T06:45:00Z'));
  assert.ok(metrics.systems.every((s) => Number.isFinite(s.at)), 'y cada sistema, la hora de su dato');
  // De la fuente a la regla, por la clave del dominio: el apagón de La Palma sale en La Palma.
  const ctx = {
    now: Date.parse('2026-11-02T06:55:00Z'), vehicles: [], tracks: new Map(), events: [], health: [], kpis: { vehicles: 0 }, kpiHistory: [],
    nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS, metrics: { [src.id]: metrics },
  };
  const [alert] = isolatedGridBlackouts(ctx);
  assert.equal(alert.id, 'red-aislada:la-palma');
  assert.equal(alert.title, 'Posible apagón total en La Palma: demanda a 0 MW');
  assert.deepEqual([alert.lat, alert.lon], [28.68, -17.86]);
});

// La Palma el 2-11-2026, de 00:00 a 10:30 en la hora de e·sios (una hora menos que la real), un dato
// cada 5 minutos: así lo publicó Red Eléctrica (indicadores 1740 y 1741).
const LA_PALMA_REAL = '21.7,20.4,20.3,20.1,20.0,19.8,19.6,19.6,19.4,19.4,19.3,19.1,19.0,19.0,19.1,19.0,19.4,19.1,19.0,18.9,18.8,18.6,18.7,17.6,18.0,18.0,18.6,18.7,18.1,18.2,18.1,18.0,18.0,17.9,18.2,17.9,17.9,18.5,18.8,12.9,12.5,12.1,14.6,16.8,16.3,18.0,17.6,18.6,18.5,18.3,18.3,17.9,17.9,17.7,17.8,18.0,18.5,18.9,18.9,19.3,18.7,18.9,18.9,19.1,19.7,19.9,20.6,20.7,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,1.0,1.4,2.4,2.1,3.1,4.4,5.8,6.8,7.1,7.3,9.9,14.0,17.8,20.4,21.5,24.0,29.3,32.3,34.9,36.1,36.0,35.9,34.2,33.6,32.9,32.2,32.0,32.3,33.0,32.7,31.6,31.3,31.6,31.5';
const LA_PALMA_PROGRAMMED = '21.9,'.repeat(12) + '19.6,'.repeat(12) + '19.0,'.repeat(12) + '17.9,'.repeat(12) + '18.8,'.repeat(12) + '19.6,'.repeat(12)
  + '0.0,'.repeat(12) + '6.6,'.repeat(12) + '9.0,'.repeat(12) + '24.2,'.repeat(12) + '30.6,'.repeat(7);
const series = (csv) => csv.split(',').filter(Boolean).map(Number);

test('el apagón de La Palma, dato a dato: una sola alerta, desde el segundo dato a cero hasta que vuelve más de la mitad', () => {
  const stamp = (i) => new Date(Date.parse('2026-11-02T00:00:00Z') + i * 5 * 60_000).toISOString().replace('.000', '');
  const real = series(LA_PALMA_REAL).map((v, i) => value(8798, 'La Palma', stamp(i), v));
  const programmed = series(LA_PALMA_PROGRAMMED).map((v, i) => value(8798, 'La Palma', stamp(i), v));
  const timeline = [];
  for (let i = 1; i < real.length; i++) {
    // Lo que había publicado e·sios 10 minutos después de cada dato (seis horas hacia atrás).
    const known = real.slice(Math.max(0, i - 72), i + 1);
    const systems = parseEsiosDemand({ indicator: { values: known } }, { indicator: { values: programmed } });
    const at = systems[0].at;
    const ctx = {
      now: at + 10 * 60_000, vehicles: [], tracks: new Map(), events: [], health: [], kpis: { vehicles: 0 }, kpiHistory: [],
      nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS, metrics: { [GRID_METRICS.aislados]: { systems } },
    };
    const [alert] = isolatedGridBlackouts(ctx);
    timeline.push({ hora: new Date(at).toISOString().slice(11, 16), alerta: alert?.severity ?? null });
  }
  const on = timeline.filter((t) => t.alerta);
  assert.equal(on[0].hora, '06:45', 'hora canaria (= UTC): el corte fue a las 06:42 y el segundo dato a cero es el de las 06:45');
  assert.equal(on[0].alerta, 'muy alta');
  assert.equal(on.at(-1).hora, '09:10', 'a las 09:15 consume 5,8 MW de 9 programados: más de la mitad');
  const first = timeline.indexOf(on[0]);
  assert.ok(timeline.slice(first, first + on.length).every((t) => t.alerta), 'sin cortes en medio: no se cierra y se vuelve a abrir');
  assert.ok(!timeline.slice(0, first).some((t) => t.alerta), 'el bajón de las 04:15 (12,1 MW de 17,9) no es un apagón');
});
