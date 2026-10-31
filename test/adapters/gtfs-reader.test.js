import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createPacer, csvColumns, csvRows, openGtfs, own } from '../../server/adapters/outbound/gtfs/gtfs-reader.js';

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
