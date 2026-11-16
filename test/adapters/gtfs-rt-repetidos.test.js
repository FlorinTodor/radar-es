// Un GTFS-RT con el mismo vehículo dos veces (lo ha hecho el de Bizkaibus): sale una vez, con su posición más reciente.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vehiclesFromFeed } from '../../server/adapters/outbound/sources/gtfs-rt.js';

const T0 = Date.parse('2026-11-16T15:00:00Z');
const entity = (id, vehicleId, lat, secondsAgo) => ({
  id, vehicle: { vehicle: { id: vehicleId }, trip: { routeId: 'A3' }, position: { latitude: lat, longitude: -2.9 }, ...(secondsAgo !== null && { timestamp: T0 / 1000 - secondsAgo }) },
});

test('el mismo vehículo dos veces: uno, con su posición más reciente; los demás, tal cual y en su orden', () => {
  const feed = { entity: [entity('e1', '2089', 43.20, 90), entity('e2', '7001', 43.30, 10), entity('e3', '2089', 43.21, 20)] };
  const seen = [];
  const vehicles = vehiclesFromFeed(feed, { id: 'bus-bizkaibus', mode: 'bus', operator: 'Bizkaibus', now: T0, onVehicle: (v) => seen.push(v.id) });
  assert.deepEqual(vehicles.map((v) => v.id), ['bus-bizkaibus:2089', 'bus-bizkaibus:7001']);
  assert.equal(vehicles[0].lat, 43.21, 'la de hace 20 s, no la de hace 90');
  assert.deepEqual(seen, ['bus-bizkaibus:2089', 'bus-bizkaibus:7001'], 'onVehicle, una vez por vehículo');
});

test('una hora en el futuro o sin hora no gana a una de verdad', () => {
  const future = entity('e1', '2089', 43.20, -3600);
  const plain = entity('e2', '2089', 43.21, 30);
  const none = entity('e3', '2089', 43.22, null);
  const [v] = vehiclesFromFeed({ entity: [future, plain, none] }, { id: 'bus-bizkaibus', mode: 'bus', operator: 'Bizkaibus', now: T0 });
  assert.equal(v.lat, 43.21);
});
