import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createPacer, csvColumns, csvColumnsStreamed, csvRows, openGtfs, own, zipLocalDate } from '../../server/adapters/outbound/gtfs/gtfs-reader.js';

const text = (bytes) => new TextDecoder().decode(bytes);

test('descomprime sólo los ficheros pedidos, comprimidos o no y dentro de carpetas', async () => {
  const stopTimes = 'trip_id,stop_id\n' + 'T1,S1\n'.repeat(5000);
  const zip = zipSync({
    'gtfs/stop_times.txt': [strToU8(stopTimes), { level: 9 }],
    'stops.txt': [strToU8('stop_id,stop_name\nS1,"Sol, Madrid"\n'), { level: 0 }],
    'shapes.txt': strToU8('no se pide'),
  });
  const files = await openGtfs(zip, ['stop_times.txt', 'stops.txt', 'trips.txt']);
  assert.deepEqual(Object.keys(files).sort(), ['stop_times.txt', 'stops.txt']);
  assert.equal(text(files['stop_times.txt']), stopTimes);
  assert.deepEqual([...csvRows(files['stops.txt'])], [{ stop_id: 'S1', stop_name: 'Sol, Madrid' }]);
});

test('rechaza lo que no es un ZIP', async () => {
  await assert.rejects(openGtfs(strToU8('<html>error</html>'), ['stops.txt']), /no es un ZIP/);
});

/** Cambia un campo de 16 bits de la entrada `name` en el directorio central de un ZIP. */
function patchCentral(zip, name, offset, value) {
  const buf = Buffer.from(zip);
  for (let p = 0; p < buf.length - 46; p++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) continue;
    const len = buf.readUInt16LE(p + 28);
    if (buf.toString('utf8', p + 46, p + 46 + len) === name) buf.writeUInt16LE(value, p + offset);
  }
  return buf;
}

test('un ZIP dañado es un error normal y no deja promesas sin capturar que tumben el proceso', async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    // stops.txt con datos deflate rotos y, detrás, trips.txt con un método que no existe.
    let zip = Buffer.from(zipSync({ 'stops.txt': [strToU8('x'.repeat(4000)), { level: 9 }], 'trips.txt': [strToU8('y'.repeat(4000)), { level: 9 }] }));
    const data = zip.indexOf(Buffer.from('stops.txt')) + 'stops.txt'.length; // justo detrás del nombre en la cabecera local
    zip.fill(0xff, data, data + 20);
    zip = patchCentral(zip, 'trips.txt', 10, 12);
    await assert.rejects(openGtfs(zip, ['stops.txt', 'trips.txt']), /trips\.txt: compresión 12 no soportada/);
    await assert.rejects(openGtfs(patchCentral(zip, 'trips.txt', 10, 8), ['stops.txt', 'trips.txt']), /./, 'deflate roto: rechaza');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('el tamaño descomprimido que declara el ZIP no cambia el contenido aunque venga mal', async () => {
  const content = 'trip_id,stop_id\n' + 'T1,S1\n'.repeat(20000);
  const zip = zipSync({ 'stop_times.txt': [strToU8(content), { level: 6 }] });
  assert.equal(text((await openGtfs(zip, ['stop_times.txt']))['stop_times.txt']), content);
  // Tamaño descomprimido (bytes 24-27 de la entrada) puesto a 10: zlib sigue con más bloques.
  const wrong = patchCentral(patchCentral(zip, 'stop_times.txt', 24, 10), 'stop_times.txt', 26, 0);
  assert.equal(text((await openGtfs(wrong, ['stop_times.txt']))['stop_times.txt']), content);
});

test('el ritmo cede el hilo en los bucles largos', async () => {
  const pace = createPacer(0);
  let other = false;
  setImmediate(() => { other = true; });
  for (let i = 0; i < 200 && !other; i++) if (pace.due()) await pace.pause();
  assert.ok(other, 'otra tarea pendiente llega a ejecutarse durante el bucle');
});

test('CSV: comillas, BOM, CRLF, espacios, líneas vacías y filas cortas', () => {
  const csv = '﻿id, name ,lat\r\n'
    + '1,Sol,40.4\r\n'
    + '\r\n'
    + '   \n'
    + '2,"Gran Vía, 1",40.42\n'
    + '3,"Dice ""hola""",\n'
    + ' 4 , Atocha \n'
    + '5';
  assert.deepEqual([...csvRows(strToU8(csv))], [
    { id: '1', name: 'Sol', lat: '40.4' },
    { id: '2', name: 'Gran Vía, 1', lat: '40.42' },
    { id: '3', name: 'Dice "hola"', lat: '' },
    { id: '4', name: 'Atocha', lat: '' },
    { id: '5', name: '', lat: '' },
  ]);
  // Por columnas: en el orden pedido; undefined si el fichero no trae la columna.
  assert.deepEqual([...csvColumns(strToU8(csv), ['lat', 'id', 'falta'])], [
    ['40.4', '1', undefined], ['40.42', '2', undefined], ['', '3', undefined], ['', '4', undefined], ['', '5', undefined],
  ]);
});

test('CSV: filas que cruzan el límite de un trozo de 1 MB y columnas repetidas', () => {
  const rows = Array.from({ length: 100_000 }, (_, i) => `T${i},S${i % 7},${i}`);
  const bytes = strToU8(`trip_id,stop_id,stop_sequence\n${rows.join('\n')}\n`);
  const got = [...csvColumns(bytes, ['stop_sequence', 'trip_id'])];
  assert.equal(got.length, 100_000);
  assert.ok(bytes.length > 1 << 20, 'más de un trozo');
  assert.ok(got.every(([seq, trip], i) => seq === String(i) && trip === `T${i}`));
  // Con columnas repetidas manda la última, como antes.
  assert.deepEqual([...csvRows(strToU8('a,b,a\n1,2,3\n'))], [{ a: '3', b: '2' }]);
});

test('own devuelve una cadena igual', () => {
  const big = 'x'.repeat(100) + 'identificador-largo-de-viaje';
  const cell = big.slice(100);
  assert.equal(own(cell), cell);
  assert.equal(own(''), '');
  assert.equal(own(undefined), undefined);
});

test('por trozos: las mismas filas que leyendo el fichero entero, comprimido o no', async () => {
  // ~1,5 MB: varios trozos de 256 KB, con filas y letras de dos bytes partidas entre ellos.
  const rows = Array.from({ length: 40_000 }, (_, i) => `T${i >> 4},Estación ${i % 97},"${i}, ñ",${i}`);
  const csv = `\ufefftrip_id,stop_name,nota,stop_sequence\r\n${rows.join('\r\n')}`;
  for (const level of [9, 0]) {
    const zip = zipSync({ 'stop_times.txt': [strToU8(csv), { level }] });
    const fields = ['stop_sequence', 'trip_id', 'nota', 'no_existe'];
    const got = [];
    for await (const row of csvColumnsStreamed(zip, 'stop_times.txt', fields)) got.push(row);
    assert.deepEqual(got, [...csvColumns(strToU8(csv), fields)]);
    assert.equal(got.length, 40_000);
    assert.deepEqual(got[39_999], ['39999', 'T2499', '39999, ñ', undefined]);
  }
});

test('por trozos: un fichero que no está en el ZIP es un error', async () => {
  const zip = zipSync({ 'stops.txt': strToU8('stop_id\nS1\n') });
  await assert.rejects(async () => { for await (const _ of csvColumnsStreamed(zip, 'stop_times.txt', ['trip_id'])); }, /no está en el ZIP/);
});

test('fecha de un GTFS sin fecha: la del fichero más reciente del ZIP', () => {
  const zip = zipSync({
    'stops.txt': [strToU8('a'), { mtime: new Date(2026, 9, 30, 4, 0, 0) }],
    'trips.txt': [strToU8('b'), { mtime: new Date(2026, 9, 31, 3, 0, 52) }],
  });
  assert.equal(zipLocalDate(zip), '2026-10-31T03:00:52');
});
