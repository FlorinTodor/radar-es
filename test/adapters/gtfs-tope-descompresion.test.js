// Tope de lo que se descomprime de un GTFS: un ZIP de ~1 MB que se inflaba a más de 1 GB (sumando
// varias llamadas, o por la ruta ZIP64, que no tenía ningún tope) tumbaba el contenedor en cada arranque.
// Los ZIP de estas pruebas son de pocos KB: los tamaños grandes sólo los declaran, y se rechazan antes
// de descomprimir nada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { MAX_GTFS_BYTES, gtfsBudget, openGtfs } from '../../server/adapters/outbound/gtfs/gtfs-reader.js';
import { parseSchedule } from '../../server/adapters/outbound/gtfs/gtfs-schedule.js';

const MB = 1024 * 1024;

/** Cambia un campo de 32 bits de la entrada `name` en el directorio central de un ZIP. */
function patchCentral32(zip, name, offset, value) {
  const buf = Buffer.from(zip);
  for (let p = 0; p < buf.length - 46; p++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) continue;
    const len = buf.readUInt16LE(p + 28);
    if (buf.toString('utf8', p + 46, p + 46 + len) === name) buf.writeUInt32LE(value, p + offset);
  }
  return buf;
}
const COMPRESSED_SIZE = 20;
const UNCOMPRESSED_SIZE = 24;

const stops = 'stop_id,stop_name,stop_lat,stop_lon\n' + 'S1,Sol,40.4,-3.7\n'.repeat(200);

test('un ZIP64 no se lee: ni siquiera uno falso con 0xffffffff y 600 MB declarados', async () => {
  const zip = zipSync({ 'stops.txt': [strToU8(stops), { level: 9 }] });
  const zip64 = patchCentral32(patchCentral32(zip, 'stops.txt', COMPRESSED_SIZE, 0xffffffff), 'stops.txt', UNCOMPRESSED_SIZE, 600 * MB);
  await assert.rejects(openGtfs(zip64, ['stops.txt']), /ZIP64/);
  assert.equal((await openGtfs(zip, ['stops.txt']))['stops.txt'].length, stops.length, 'el mismo ZIP sin el 0xffffffff, sí');
});

test('si lo que declaran los ficheros pedidos pasa del tope, error antes de descomprimir', async () => {
  const zip = zipSync({ 'stops.txt': [strToU8(stops), { level: 9 }], 'trips.txt': [strToU8('trip_id\nT1\n'), { level: 9 }] });
  // Un fichero solo que declara más que el tope.
  await assert.rejects(openGtfs(patchCentral32(zip, 'stops.txt', UNCOMPRESSED_SIZE, MAX_GTFS_BYTES + 1), ['stops.txt']), /stops\.txt: el GTFS pasa del tope/);
  // Dos que caben cada uno, pero no juntos.
  const half = MAX_GTFS_BYTES / 2 + 1;
  const both = patchCentral32(patchCentral32(zip, 'stops.txt', UNCOMPRESSED_SIZE, half), 'trips.txt', UNCOMPRESSED_SIZE, half);
  await assert.rejects(openGtfs(both, ['stops.txt', 'trips.txt']), /trips\.txt: el GTFS pasa del tope/);
});

test('el tope es de toda la lectura: suma las llamadas que comparten presupuesto', async () => {
  const trips = 'trip_id,route_id\n' + 'T1,R1\n'.repeat(200);
  const stopTimes = 'trip_id,stop_id\n' + 'T1,S1\n'.repeat(200);
  const zip = zipSync({ 'stops.txt': strToU8(stops), 'trips.txt': strToU8(trips), 'stop_times.txt': strToU8(stopTimes) });
  const first = stops.length + trips.length;
  // Cada llamada cabe por separado…
  await openGtfs(zip, ['stops.txt', 'trips.txt'], gtfsBudget(first));
  await openGtfs(zip, ['stop_times.txt'], gtfsBudget(first));
  // …pero con el mismo presupuesto, la segunda ya no.
  const budget = gtfsBudget(first + stopTimes.length - 1);
  await openGtfs(zip, ['stops.txt', 'trips.txt'], budget);
  await assert.rejects(openGtfs(zip, ['stop_times.txt'], budget), /stop_times\.txt: el GTFS pasa del tope/);
});

test('un horario no pasa del tope aunque cada una de sus tres lecturas del ZIP quepa', async () => {
  const files = {
    'agency.txt': 'agency_id,agency_name\nA,Metro\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_type\nR1,A,L1,1\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\nS1,Sol,40.4168,-3.7038\nS2,Gran Vía,40.4200,-3.7050\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nW,1,1,1,1,1,1,1,20260101,20271231\n',
    'trips.txt': 'route_id,service_id,trip_id,shape_id\nR1,W,T1,SH\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,S1,1\nT1,08:05:00,08:05:00,S2,2\n',
    'shapes.txt': 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nSH,40.4168,-3.7038,1\nSH,40.4200,-3.7050,2\n',
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([name, s]) => [name, strToU8(s)])));
  const bytes = (s) => Buffer.byteLength(s);
  const first = ['agency.txt', 'routes.txt', 'stops.txt', 'calendar.txt', 'trips.txt'].reduce((n, name) => n + bytes(files[name]), 0);
  const all = first + bytes(files['stop_times.txt']) + bytes(files['shapes.txt']);
  const days = { today: { ymd: '20261102', weekday: 0 }, yesterday: { ymd: '20261101', weekday: 6 } };
  // Con todo lo que descomprime, se lee igual que sin presupuesto.
  assert.deepEqual(await parseSchedule(zip, undefined, days, {}, gtfsBudget(all)), await parseSchedule(zip, undefined, days, {}));
  // Lo de la primera llamada cabe y stop_times.txt también, pero juntos no.
  await assert.rejects(parseSchedule(zip, undefined, days, {}, gtfsBudget(first + bytes(files['stop_times.txt']) - 1)), /stop_times\.txt: el GTFS pasa del tope/);
  // Y los trazados, después de stop_times.txt, también cuentan.
  await assert.rejects(parseSchedule(zip, undefined, days, {}, gtfsBudget(all - 1)), /shapes\.txt: el GTFS pasa del tope/);
});
