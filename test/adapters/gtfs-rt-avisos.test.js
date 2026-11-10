// Avisos de servicio de los autobuses (AUVASA, EMT Málaga): las paradas que suprime un desvío salen como
// cancelación parcial de la línea, con el aviso como motivo y en la parada suprimida; los demás avisos,
// como avisos de servicio. Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { strToU8, zipSync } from 'fflate';
import { createGtfsRtAlertsSource, suppressedStops } from '../../server/adapters/outbound/sources/gtfs-rt-avisos.js';

const { transit_realtime: rt } = createRequire(import.meta.url)('gtfs-realtime-bindings');
const NOW = Date.parse('2026-11-05T15:00:00Z'); // 16:00 en Madrid
const text = (s) => ({ translation: [{ text: s, language: 'es' }] });
const alert = (id, routeId, stopId, header, description, effect = 'DETOUR') => ({
  id, alert: { informedEntity: [{ routeId, routeType: 3, stopId }], headerText: text(header), descriptionText: text(description), effect },
});
const feed = (entity) => rt.FeedMessage.encode(rt.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: 1_793_890_000 }, entity })).finish();
const stopsZip = async () => zipSync({ 'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n'
  + '84,Calle Venezuela esquina Ecuador,41.6300,-4.7500\n90,Plaza Uruguay esquina Honduras,41.6309,-4.7509\n91,Plaza Uruguay esquina Honduras,41.7000,-4.9000\n'
  + '92,Calle Chile,41.6320,-4.7520\n25,Calle Barbecho frente Arado,41.6500,-4.7466\n') });

const ALERTS = [
  alert('alert_4', '7', '84', 'Desvío línea 7', 'Línea 7 desviada entre las paradas Calle Venezuela esquina Ecuador y Calle Chile - Paradas suprimidas: Plaza Uruguay esquina Honduras'),
  alert('alert_4b', '7', '84', 'Desvío línea 7', 'Línea 7 desviada entre las paradas Calle Venezuela esquina Ecuador y Calle Chile - Paradas suprimidas: Plaza Uruguay esquina Honduras'),
  alert('alert_2', '3', '25', 'Desvío línea 3', 'Línea 3 desviada entre las paradas Calle Barbecho frente Arado y Calle Rastrojo'),
  { id: 'alert_1', alert: { informedEntity: [{ routeType: 3 }], headerText: text('Aviso'), descriptionText: text('Parada de c/ Doctrinos 12 trasladada provisionalmente a c/ Doctrinos 18'), effect: 'UNKNOWN_EFFECT' } },
];

function source(entities) {
  let current = entities;
  const s = createGtfsRtAlertsSource({ http: { bytes: async () => feed(current) }, cache: undefined, now: () => Date.now() }, {
    id: 'auvasa-avisos', name: 'AUVASA avisos', operator: 'AUVASA', url: 'http://ejemplo/alert', license: 'Fuente: AUVASA (CC BY 3.0 ES)', stopsZip,
  });
  return { s, set: (e) => { current = e; } };
}

test('paradas suprimidas por un desvío: cancelación parcial de la línea, en la parada suprimida y con el aviso como motivo', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { s } = source(ALERTS);
  const { events, sourceTime } = await s.fetch();
  assert.equal(sourceTime, 1_793_890_000_000);
  const cancelled = events.filter((e) => e.category === 'cancelacion');
  assert.equal(cancelled.length, 1, 'el mismo aviso repetido, una vez');
  const [l7] = cancelled;
  assert.equal(l7.title, 'Línea 7 de AUVASA no para en Plaza Uruguay esquina Honduras');
  assert.equal(l7.severity, 'baja');
  assert.deepEqual([l7.lon, l7.lat], [-4.7509, 41.6309], 'la parada con ese nombre más cerca de la que cita el aviso');
  assert.equal(l7.trip.reason, 'Desvío línea 7: Línea 7 desviada entre las paradas Calle Venezuela esquina Ecuador y Calle Chile - Paradas suprimidas: Plaza Uruguay esquina Honduras.');
  assert.match(l7.description, /^Desvío línea 7: .* AUVASA da como suprimidas en su tiempo real \(GTFS-RT de avisos de servicio\) esta parada: Plaza Uruguay esquina Honduras\.$/);
  assert.equal(l7.credit, 'Fuente: AUVASA (CC BY 3.0 ES)');
  assert.equal(l7.trip.feedUrl, 'http://ejemplo/alert');
  assert.deepEqual(l7.trip.follow, ['l-auvasa-7'], 'quien siga la línea se entera');
  assert.equal(l7.seen, NOW);

  const notices = events.filter((e) => e.category === 'carretera');
  assert.deepEqual(notices.map((e) => e.title), ['AUVASA · Desvío línea 3', 'AUVASA · Aviso']);
  assert.deepEqual([notices[0].lon, notices[0].lat], [-4.7466, 41.65], 'en la parada que cita');
  assert.equal(notices[0].area, 'Calle Barbecho frente Arado');
  assert.equal(notices[1].lat, null, 'sin parada: sin ubicación');
});

test('cuando el desvío acaba, la cancelación sigue hasta medianoche como retirada', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { s, set } = source(ALERTS);
  await s.fetch();
  t.mock.timers.tick(5 * 60_000);
  set(ALERTS.slice(2));
  const gone = (await s.fetch()).events.find((e) => e.category === 'cancelacion');
  assert.equal(gone.withdrawn, NOW + 5 * 60_000);
  assert.match(gone.description, /AUVASA dejó de publicarlo a las 16:05\.$/);
  assert.equal(gone.expires, Date.parse('2026-11-05T23:00:00Z'));
});

test('varias paradas suprimidas: se parten sólo si cada trozo es una parada del horario', () => {
  const known = (n) => ['Plaza Uruguay', 'Calle Chile'].includes(n);
  assert.deepEqual(suppressedStops('Línea 7 desviada - Paradas suprimidas: Plaza Uruguay y Calle Chile', known), ['Plaza Uruguay', 'Calle Chile']);
  assert.deepEqual(suppressedStops('Paradas suprimidas: Plaza Uruguay, Calle Chile.', known), ['Plaza Uruguay', 'Calle Chile']);
  assert.deepEqual(suppressedStops('Paradas suprimidas: Héroe de Sostoa - Girón'), ['Héroe de Sostoa - Girón']);
  assert.deepEqual(suppressedStops('Paradas suprimidas: Calle 5, esquina Mayor'), ['Calle 5, esquina Mayor'], 'trozos que no son paradas: el texto entero');
  assert.deepEqual(suppressedStops('Línea 8 desviada entre las paradas A y B - Paradas suprimidas: '), []);
  assert.deepEqual(suppressedStops('Línea 3 desviada entre las paradas A y B'), []);
});
