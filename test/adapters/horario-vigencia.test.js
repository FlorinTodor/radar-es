// Hasta cuándo vale cada horario GTFS: el servidor lo saca de calendar.txt y calendar_dates.txt, avisa
// una vez en el registro cuando le quedan pocos días y la pestaña Fuentes lo enseña (y resalta si se acaba).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { packSchedule, parseSchedule, unpackSchedule } from '../../server/adapters/outbound/gtfs/gtfs-schedule.js';
import { SCHEDULE_ENDING_DAYS, daysLeft } from '../../server/domain/schedule.js';
import { fmtDateTime, scheduleValidity } from '../../public/js/format.js';
import { renderSources } from '../../public/js/panels.js';

// Miércoles 4 de noviembre de 2026, a las 13:00 de Madrid.
const NOW = Date.parse('2026-11-04T12:00:00Z');
const gtfs = ({ end, added = [], removed = [] }) => zipSync({
  'agency.txt': strToU8('agency_id,agency_name\nA,Operador\n'),
  'routes.txt': strToU8('route_id,agency_id,route_short_name,route_type\nL1,A,L1,1\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id\nL1,S,T1\n'),
  'calendar.txt': strToU8(`service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,${end}\n`),
  'calendar_dates.txt': strToU8(['service_id,date,exception_type', ...added.map((d) => `S,${d},1`), ...removed.map((d) => `S,${d},2`)].join('\n')),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\nA,Alfa,37.0,-6.0\nB,Beta,37.0,-5.99\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,12:55:00,12:55:00,A,1\nT1,13:05:00,13:05:00,B,2\n'),
});
const napOf = (zips) => ({ gtfs: async (id) => zips[id], updatedAt: async () => '2026-10-07T13:23:00' });
const days = { today: { ymd: '20261104', weekday: 2 }, yesterday: { ymd: '20261103', weekday: 1 } };

test('el último día con servicio: el fin del calendario o un día añadido después; los suprimidos no cuentan', async () => {
  const s = await parseSchedule(gtfs({ end: '20261119', added: ['20261201'], removed: ['20261231'] }), null, days);
  assert.equal(s.validUntil, '20261201');
  assert.equal(unpackSchedule(packSchedule(s).value).validUntil, '20261201', 'llega igual desde el hilo que lo lee');
  assert.equal((await parseSchedule(gtfs({ end: '20261119' }), null, days)).validUntil, '20261119');
});

test('días que le quedan: 0 el último día; negativo si ya pasó', () => {
  assert.equal(daysLeft('20261119', '20261104'), 15);
  assert.equal(daysLeft('20261104', '20261104'), 0);
  assert.equal(daysLeft('20261103', '20261104'), -1);
  assert.equal(daysLeft('20270101', '20261231'), 1, 'también al cambiar de año');
});

test('la fuente dice hasta cuándo vale su horario y avisa una vez en el registro si se acaba pronto', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const warned = [];
  const log = { info() {}, warn: (m) => warned.push(m), error() {} };
  const lejos = createGtfsScheduleSource({ nap: napOf({ 1: gtfs({ end: '20261119' }) }), http: {}, log, now: () => NOW },
    { id: 'metro-malaga', name: 'Metro de Málaga', operator: 'Metro de Málaga', ficheroId: 1, dataset: 1 });
  assert.equal((await lejos.fetch()).datasetValidUntil, '2026-11-19');
  assert.deepEqual(warned, [], `a ${SCHEDULE_ENDING_DAYS + 1} días todavía no se avisa`);

  const cerca = createGtfsScheduleSource({ nap: napOf({ 1: gtfs({ end: '20261110' }) }), http: {}, log, now: () => NOW },
    { id: 'metro-malaga', name: 'Metro de Málaga', operator: 'Metro de Málaga', ficheroId: 1, dataset: 1 });
  assert.equal((await cerca.fetch()).datasetValidUntil, '2026-11-10');
  await cerca.fetch();
  assert.equal(warned.length, 1, 'una sola vez, no en cada lectura');
  assert.match(warned[0], /Metro de Málaga: su horario vale hasta el 10\/11\/2026 \(quedan 6 días\)/);
});

test('en un grupo de horarios, el primero que se acaba y de qué operador es', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: napOf({ 1: gtfs({ end: '20261231' }), 2: gtfs({ end: '20261203' }) }), http: {}, now: () => NOW },
    { id: 'urbanos', name: 'Urbanos', mode: 'bus', feeds: [{ ficheroId: 1, dataset: 1, operator: 'Uno' }, { ficheroId: 2, dataset: 2, operator: 'Dos' }] });
  const r = await source.fetch();
  assert.equal(r.datasetValidUntil, '2026-12-03');
  assert.equal(r.datasetValidUntilOf, 'Dos');
});

test('la pestaña Fuentes: hasta cuándo vale cada horario, resaltado si se acaba; las fechas de otro año llevan el año', () => {
  assert.deepEqual(scheduleValidity('2026-11-19', NOW), { text: 'válido hasta el 19/11/2026', warn: null, expired: false });
  assert.deepEqual(scheduleValidity('2026-11-18', NOW), { text: 'válido hasta el 18/11/2026', warn: 'caduca en 14 días', expired: false });
  assert.equal(scheduleValidity('2026-11-05', NOW).warn, 'caduca mañana');
  assert.equal(scheduleValidity('2026-11-04', NOW).warn, 'hoy es su último día');
  assert.deepEqual(scheduleValidity('2026-11-03', NOW), { text: 'válido hasta el 03/11/2026', warn: 'horario caducado', expired: true });
  assert.equal(scheduleValidity(null, NOW), null);

  // El formato exacto (día con o sin cero delante, la coma) depende de la versión de ICU de Node.
  assert.match(fmtDateTime(Date.parse('2025-12-22T07:20:00Z'), NOW), /^22\/12\/2025,? 08:20$/, 'de otro año, con el año');
  assert.match(fmtDateTime(Date.parse('2026-10-07T11:23:00Z'), NOW), /^0?7\/10,? 13:23$/, 'de este año, sin');

  const el = { innerHTML: '' };
  renderSources(el, [
    { id: 'metro-malaga', name: 'Metro de Málaga', enabled: true, ok: true, interval: 30_000, datasetUpdated: Date.parse('2026-10-07T11:23:00Z'), datasetValidUntil: '2026-11-10' },
    { id: 'tram-alacant', name: "TRAM d'Alacant", enabled: true, ok: true, interval: 30_000, datasetUpdated: Date.parse('2025-12-22T07:20:00Z'), datasetValidUntil: '2026-12-31' },
    { id: 'urbanos', name: 'Urbanos', enabled: true, ok: true, interval: 60_000, datasetValidUntil: '2026-12-03', datasetValidUntilOf: 'Dos' },
  ], [], NOW);
  assert.match(el.innerHTML, /horario válido hasta el 10\/11\/2026<\/span><span class="status warn">caduca en 6 días/);
  assert.match(el.innerHTML, /horario actualizado el 22\/12\/2025,? 08:20/);
  assert.match(el.innerHTML, /horario válido hasta el 31\/12\/2026<\/span>\s*<span>cada/, 'sin aviso si le queda mucho');
  assert.match(el.innerHTML, /el primer horario que se acaba \(Dos\) es válido hasta el 03\/12\/2026/);
});
