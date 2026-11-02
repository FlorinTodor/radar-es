// «Hoy» es el día de Madrid, no el de UTC: entre las 00:00 y la 01:00 (las 02:00 en verano) de Madrid,
// en UTC todavía es ayer. Todo sale de los mismos helpers de parse.js. Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { madridDate, madridDateTime, madridLocalToMs, madridToday } from '../../server/adapters/outbound/sources/parse.js';
import { createTimetables } from '../../server/adapters/outbound/sources/renfe.js';
import { createJsonlHistory } from '../../server/adapters/outbound/persistence/jsonl-history.js';

// 00:30 del 3 de noviembre en Madrid (invierno, UTC+1): en UTC aún son las 23:30 del día 2.
const MADRID_00_30 = Date.parse('2026-11-02T23:30:00Z');
// 23:59 del 2 de noviembre en Madrid.
const MADRID_23_59 = Date.parse('2026-11-02T22:59:00Z');

test('pasada la medianoche de Madrid ya es el día siguiente, aunque en UTC no', () => {
  assert.equal(new Date(MADRID_00_30).toISOString().slice(0, 10), '2026-11-02', 'en UTC, aún el día 2');
  assert.equal(madridToday(MADRID_00_30), '2026-11-03');
  assert.equal(madridDate(MADRID_00_30), '2026-11-03');
  assert.equal(madridToday(MADRID_23_59), '2026-11-02');
  // En verano (UTC+2) la ventana es de dos horas.
  assert.equal(madridToday(Date.parse('2026-07-01T22:30:00Z')), '2026-07-02');
  assert.equal(madridToday(Date.parse('2026-07-01T21:59:00Z')), '2026-07-01');
});

test('la fecha y hora de Madrid va de 00 a 23 y vuelve a su instante, en invierno y en verano', () => {
  assert.equal(madridDateTime(MADRID_00_30), '2026-11-03T00:30:00');
  assert.equal(madridDateTime(Date.parse('2026-11-02T23:00:00Z')), '2026-11-03T00:00:00', 'medianoche es 00, no 24');
  assert.equal(madridDateTime(Date.parse('2026-07-01T22:30:00Z')), '2026-07-02T00:30:00');
  for (const iso of ['2026-03-29T12:00:00Z', '2026-07-01T22:30:00Z', '2026-10-25T12:00:00Z', '2026-11-02T23:30:00Z']) {
    const t = Date.parse(iso);
    assert.equal(madridLocalToMs(madridDateTime(t)), t, iso);
  }
  assert.equal(madridLocalToMs('2026-10-30T19:05:43'), Date.parse('2026-10-30T18:05:43Z'));
  assert.equal(madridLocalToMs('no es una fecha'), null);
});

// Horario de AV/LD/MD con el mismo tren en dos periodos: el que empezó el 1 de octubre y el que
// empieza el 3 de noviembre (con otro destino, para distinguirlos).
const NAMES = { 65000: 'València-Estació del Nord', 64103: 'Massanassa', 64200: 'Moixent' };
const stations = { get: () => undefined, name: (code) => NAMES[code] ?? `Estación ${code}` };
const ldZip = () => zipSync({
  'routes.txt': strToU8('route_id,route_short_name\nR1,AVE\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,0515212026-10-01,05152\nR1,B,0515212026-11-03,05152\n'),
  'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence\n'
    + '0515212026-10-01,65000,1\n0515212026-10-01,64200,2\n'
    + '0515212026-11-03,65000,1\n0515212026-11-03,64103,2\n'),
});

async function destinationAt(t, now) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const timetables = createTimetables({ cache: { bytes: async () => ldZip() }, stations, log: { warn() {}, info() {} } });
  await timetables.loadLd();
  return timetables.ld('desconocido', '05152').destination;
}

test('Renfe: a las 00:30 de Madrid del día que empieza un periodo, el tren se busca en el nuevo', async (t) => {
  assert.equal(await destinationAt(t, MADRID_00_30), 'Massanassa', 'con el día de UTC se quedaba con el del 1 de octubre');
});

test('Renfe: a las 23:59 de Madrid de la víspera, aún en el periodo anterior', async (t) => {
  assert.equal(await destinationAt(t, MADRID_23_59), 'Moixent');
});

test('el histórico de una noche va al fichero del día de Madrid', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'historial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const history = createJsonlHistory({ dir: pathToFileURL(`${dir}/`), log: { warn: assert.fail }, now: () => MADRID_00_30 });
  await history.append('alerts', { id: 'a' });
  assert.deepEqual(await readdir(dir), ['alerts-2026-11-03.jsonl']);
});
