// Atribución y fecha de actualización de cada fuente, que sus licencias piden citar donde se ven sus
// datos (TMB, AMB, Euskotren, el Servei Català de Trànsit, Open Data Euskadi…). Sin esperas reales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { strToU8, zipSync } from 'fflate';
import { createHttpClient } from '../../server/adapters/outbound/http/http-client.js';
import { createGtfsScheduleSource } from '../../server/adapters/outbound/sources/gtfs-horario.js';
import { createMoveuskadiBusSource } from '../../server/adapters/outbound/sources/moveuskadi-bus.js';
import { madridLocalToMs } from '../../server/adapters/outbound/sources/parse.js';
import { createSctSource } from '../../server/adapters/outbound/sources/trafico-autonomico.js';

const { transit_realtime: rt } = createRequire(import.meta.url)('gtfs-realtime-bindings');
const feedAt = (timestamp) => rt.FeedMessage.encode(rt.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp }, entity: [] })).finish();
const csv = (rows) => strToU8(rows.join('\n'));
const quiet = { info() {}, warn() {} };
const NOW = Date.parse('2026-11-01T11:00:00Z'); // 12:00 en Madrid

// Un autobús que de 11:55 a 13:30 va entre dos paradas.
const busGtfs = () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_type', 'L1,L1,3']),
  'trips.txt': csv(['route_id,service_id,trip_id', 'L1,S,T1']),
  'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
  'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'A,Alfa,37.0,-6.0', 'B,Beta,37.0,-5.99']),
  'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'T1,11:55:00,11:55:00,A,1', 'T1,13:30:00,13:30:00,B,2']),
});
const UPDATED = { 1: '2026-10-30T10:00:00', 2: '2026-10-31T10:00:00' };

test('grupo de operadores: cada vehículo cita sólo a su operador, con la fecha de su horario', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const nap = { gtfs: async () => busGtfs(), updatedAt: async (dataset) => UPDATED[dataset] };
  const source = createGtfsScheduleSource({ nap, http: {}, log: quiet }, {
    id: 'bus-urbanos', name: 'Urbanos', mode: 'bus',
    feeds: [{ ficheroId: 1, dataset: 1, operator: 'TMB', credit: 'Fuente: TMB' }, { ficheroId: 2, dataset: 2, operator: 'TUSSAM' }],
  });
  assert.match(source.license, /· TMB \(Fuente: TMB\), TUSSAM ·/, '«Fuente: TMB» es sólo de TMB, no de todo el grupo');
  assert.match(source.operatorLicenses.TMB, /^Powered by MITRAMS \(Punto de Acceso Nacional\) · Fuente: TMB · Posición estimada/);
  assert.match(source.operatorLicenses.TUSSAM, /· TUSSAM · /);
  const result = await source.fetch();
  assert.deepEqual(result.datasetUpdatedBy, { TMB: madridLocalToMs(UPDATED[1]), TUSSAM: madridLocalToMs(UPDATED[2]) });
  assert.equal(result.sourceTime, undefined, 'sin tiempo real no hay hora del dato');
});

test('un solo operador: su atribución, sin la de cada operador', () => {
  const source = createGtfsScheduleSource({ nap: {}, http: {}, log: quiet }, {
    id: 'horario-metro-barcelona', name: 'Metro', mode: 'metro', ficheroId: 1, dataset: 1, operator: 'Metro de Barcelona', credit: 'Fuente: TMB',
  });
  assert.match(source.license, /· Fuente: TMB · /);
  assert.equal(source.operatorLicenses, undefined);
});

test('horario con retrasos en tiempo real (AMB, Euskotren): la hora del dato es la de su feed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const source = createGtfsScheduleSource({ nap: { gtfs: async () => busGtfs(), updatedAt: async () => UPDATED[1] }, http: { bytes: async () => feedAt(1_793_530_000) }, log: quiet }, {
    id: 'amb-bus', name: 'AMB', mode: 'bus', ficheroId: 1, dataset: 1, operator: 'AMB', tripUpdatesUrl: 'https://ejemplo/trip-updates',
  });
  const result = await source.fetch();
  assert.equal(result.sourceTime, 1_793_530_000_000);
  assert.equal(result.datasetUpdated, madridLocalToMs(UPDATED[1]));
});

test('autobuses de Euskadi: la hora del feed más reciente de sus operadores', async () => {
  const feeds = { 'https://ejemplo/bizkaibus/positions.pb': feedAt(100), 'https://ejemplo/dbus/positions.pb': feedAt(200) };
  const http = {
    json: async () => ({ data: {
      Bizkaibus: [{ url: 'https://ejemplo/bizkaibus/positions.pb' }],
      Dbus: [{ url: 'https://ejemplo/dbus/positions.pb' }],
    } }),
    bytes: async (url) => feeds[url],
  };
  const result = await createMoveuskadiBusSource({ http, log: quiet }).fetch();
  assert.equal(result.sourceTime, 200_000);
});

test('Servei Català de Trànsit: la fecha de su fichero sale de la cabecera Last-Modified', async () => {
  const http = {
    text: async (url, opts) => {
      opts.info.lastModified = Date.parse('Mon, 02 Nov 2026 09:42:03 GMT');
      return '<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs"></wfs:FeatureCollection>';
    },
  };
  const result = await createSctSource({ http }).fetch();
  assert.equal(new Date(result.sourceTime).toISOString(), '2026-11-02T09:42:03.000Z');
});

test('cliente HTTP: con `info`, deja la fecha de Last-Modified (null si no la trae)', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/con') res.setHeader('Last-Modified', 'Mon, 02 Nov 2026 09:42:03 GMT');
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const http = createHttpClient();
  const con = {};
  const sin = {};
  assert.equal(await http.text(`${base}/con`, { info: con }), 'ok');
  await http.text(`${base}/sin`, { info: sin });
  assert.equal(con.lastModified, Date.parse('2026-11-02T09:42:03Z'));
  assert.equal(sin.lastModified, null);
});
