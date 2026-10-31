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
