// NASA FIRMS: cada foco lleva su confianza («alta» si VIIRS la da alta, con la palabra o con su inicial), que
// el bot usa para avisar sólo de los más seguros; los de confianza baja ni se leen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFirmsSource } from '../../server/adapters/outbound/sources/firms.js';

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n';
const row = (lat, lon, conf, frp) => `${lat},${lon},340.1,0.4,0.4,2026-11-10,1331,N20,VIIRS,${conf},2.0NRT,290.1,${frp},D\n`;

test('la confianza de cada foco: alta o nominal; la baja, fuera', async () => {
  const csv = HEADER + row(37.41, -3.17, 'high', 42.5) + row(37.42, -3.18, 'h', 12) + row(37.43, -3.19, 'nominal', 8) + row(37.44, -3.2, 'n', 3)
    + row(37.45, -3.21, 'low', 50) + row(37.46, -3.22, 'l', 50);
  // Los dos ficheros (Europa y África) traen lo mismo: el dominio quita los repetidos por su id.
  const { events } = await createFirmsSource({ http: { text: async () => csv } }).fetch();
  assert.deepEqual(events.slice(0, 4).map((e) => [e.confidence, e.frp]), [['alta', 42.5], ['alta', 12], ['nominal', 8], ['nominal', 3]]);
  assert.equal(events.length, 8, 'los de confianza baja no se leen');
  assert.equal(events[0].start, Date.parse('2026-11-10T13:31:00Z'));
});
