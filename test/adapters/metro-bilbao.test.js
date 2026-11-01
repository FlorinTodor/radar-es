// Metro Bilbao: su GTFS-RT da códigos de estación ("AIB_AIB2_ETX_…", stopId "22.0"); con su GTFS
// estático se convierten en nombres, y el trazado del viaje da el origen y lo que le queda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { openGtfs } from '../../server/adapters/outbound/gtfs/gtfs-reader.js';
import { staticGtfs, vehiclesFromFeed } from '../../server/adapters/outbound/sources/gtfs-rt.js';
import { metroBilbao } from '../../server/adapters/outbound/sources/index.js';

const zip = zipSync({
  'stops.txt': strToU8('stop_id,stop_code,stop_name,stop_lat,stop_lon\n2.0,ETX,Etxebarri,  43.24386,  -2.89771\n22.0,AIB,Aiboa,  43.34414,  -3.00267\n25.0,IBB,Ibarbengoa,  43.36320,  -3.00699\n'),
  'trips.txt': strToU8('trip_id,route_id,service_id,trip_headsign,direction_id,shape_id\n902887,MB,S,Etxebarri,1,IBB_ETX\n'),
});

const feed = (tripId) => ({ entity: [{
  id: 'AIB_AIB2_ETX_1793545602',
  vehicle: { trip: { tripId, routeId: 'MB' }, position: { latitude: 43.34414, longitude: -3.00267 }, timestamp: Date.now() / 1000, stopId: '22.0', vehicle: { id: '503' } },
}] });
const options = { id: 'metro-bilbao', mode: 'metro', operator: 'Metro Bilbao', line: () => null, describe: metroBilbao };

test('nombres de estación en vez de códigos, origen por el trazado del viaje y final para dibujar lo que le queda', async () => {
  const gtfs = staticGtfs(await openGtfs(zip, ['stops.txt', 'trips.txt']));
  const [v] = vehiclesFromFeed(feed('902887'), { ...options, gtfs });
  assert.equal(v.origin, 'Ibarbengoa');
  assert.equal(v.destination, 'Etxebarri');
  assert.equal(v.current, 'Aiboa');
  assert.equal(v.next, null, 'su stopId es la misma estación en la que está: no es la próxima');
  assert.equal(v.shape, 'IBB_ETX');
  assert.deepEqual(v.end, [-2.89771, 43.24386]);
});

test('sin horario estático (o un viaje que no está en él) se queda con lo que dice el tiempo real', async () => {
  const [sin] = vehiclesFromFeed(feed('902887'), options);
  assert.equal(sin.destination, 'ETX');
  assert.equal(sin.current, 'AIB');
  assert.equal(sin.shape, null);
  const gtfs = staticGtfs(await openGtfs(zip, ['stops.txt', 'trips.txt']));
  const [otro] = vehiclesFromFeed(feed('999'), { ...options, gtfs });
  assert.equal(otro.destination, 'Etxebarri');
  assert.equal(otro.origin, null);
  assert.equal(otro.shape, null);
});
