// Feeds GTFS-RT mal formados: Euskotren publica a veces una entrada mal medida (sus paradas quedan sueltas
// en el fichero) y BilboBus un fichero vacío. Lo que se puede leer se usa; lo roto se descarta y se cuenta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeFeed } from '../../server/adapters/outbound/sources/gtfs-rt.js';

const { transit_realtime: rt } = createRequire(import.meta.url)('gtfs-realtime-bindings');
const field = (n, body) => Uint8Array.from([(n << 3) | 2, body.length, ...body]); // cuerpos de menos de 128 bytes
const header = field(1, rt.FeedHeader.encode({ gtfsRealtimeVersion: '2.0', timestamp: 1_793_870_000 }).finish());
const trip = (id, delay) => field(2, rt.FeedEntity.encode({ id, tripUpdate: { trip: { tripId: id }, delay } }).finish());
const join = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
// Una entrada sin su viaje (TripUpdate exige `trip`): «missing required 'trip'», como la de Euskotren.
const withoutTrip = field(2, join(field(1, [...Buffer.from('roto')]).map((b, i) => (i === 0 ? 0x0a : b)), Uint8Array.from([0x1a, 4, 0x12, 2, 0x08, 1])));

test('un feed bien formado se lee igual que siempre, sin «damaged»', () => {
  const feed = decodeFeed(join(header, trip('A', 60), trip('B', 0)));
  assert.deepEqual(feed.entity.map((e) => e.id), ['A', 'B']);
  assert.equal(feed.header.timestamp, 1_793_870_000);
  assert.equal(feed.damaged, undefined);
});

test('una entrada rota no tira el feed entero: se descarta y se cuentan las partes perdidas', () => {
  const bytes = join(header, trip('A', 60), withoutTrip, trip('C', 120));
  assert.throws(() => rt.FeedMessage.decode(bytes), /missing required 'trip'/, 'leído de golpe, se pierde entero');
  const feed = decodeFeed(bytes);
  assert.deepEqual(feed.entity.map((e) => [e.id, e.tripUpdate.delay]), [['A', 60], ['C', 120]]);
  assert.equal(feed.damaged, 1);
  assert.equal(feed.header.timestamp, 1_793_870_000);
});

test('las paradas de una entrada mal medida, sueltas entre las entradas (el fichero de Euskotren): se saltan', () => {
  // Así llegó el 5-nov: tras una entrada, una parada suya (stop_sequence, llegada, salida, stop_id) fuera de ella.
  const loose = rt.TripUpdate.StopTimeUpdate.encode({
    stopSequence: 2, arrival: { time: 1_793_870_100 }, departure: { time: 1_793_870_100 }, stopId: 'ES:Euskotren:Quay:2621',
  }).finish();
  const bytes = join(header, trip('A', 60), loose, trip('C', 120));
  assert.throws(() => rt.FeedMessage.decode(bytes), /missing required/, 'leído de golpe, se pierde entero');
  const feed = decodeFeed(bytes);
  assert.deepEqual(feed.entity.map((e) => e.id), ['A', 'C']);
  assert.equal(feed.damaged, 1, 'la llegada suelta ocupa el campo de las entradas y no lo es; los demás campos se saltan');
});

test('un fichero vacío (0 bytes) es un error que lo dice; uno que ni tiene cabecera, el de protobuf', () => {
  assert.throws(() => decodeFeed(new Uint8Array(0)), /el fichero llega vacío \(0 bytes\)/);
  assert.throws(() => decodeFeed(join(withoutTrip)), /missing required/);
});
