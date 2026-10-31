import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createPacer, csvRows, openGtfs } from '../../server/adapters/outbound/gtfs/gtfs-reader.js';

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
