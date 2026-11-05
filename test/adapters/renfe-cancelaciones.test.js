// Renfe: trenes cancelados y paradas suprimidas de Cercanías y de AV/LD/MD, con la hora de su horario,
// quién lo publica y desde cuándo lo ve el radar (guardado: un reinicio no lo da por nuevo). Sin esperas
// reales: el reloj es simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createRenfeSources } from '../../server/adapters/outbound/sources/renfe.js';

const pad = (s) => s.padEnd(40);
const NAMES = { 65000: 'València-Estació del Nord', 64102: 'Alfafar-Benetússer', 64103: 'Massanassa', 64200: 'Moixent' };
const AT = { 65000: [-0.3772, 39.4669], 64103: [-0.39, 39.41], 64200: [-0.75, 38.87] }; // Alfafar, sin coordenadas en el catálogo
const stations = {
  get: (code) => (NAMES[code] ? { name: NAMES[code], ...(AT[code] ? { lon: AT[code][0], lat: AT[code][1] } : {}) } : undefined),
  name: (code) => (code ? NAMES[code] ?? `Estación ${code}` : null),
};
const log = { warn() {}, info() {} };

const cercaniasZip = zipSync({
  'routes.txt': strToU8(`route_id,route_short_name,route_long_name,route_type\n40T0006C2,C2,${pad('Moixent')}-Valencia Nord,2\n`),
  'trips.txt': strToU8('route_id,service_id,trip_id,shape_id\n40T0006C2,S,4006J20109C2,40_C2\n40T0006C2,S,4006J20111C2,40_C2\n'),
  'stops.txt': strToU8('stop_id,stop_name,stop_lat,stop_lon\n64200,Moixent,38.87,-0.75\n64103,Massanassa,39.41,-0.39\n64102,Alfafar-Benetússer,39.42,-0.39\n65000,València Nord,39.4669,-0.3772\n'),
  'stop_times.txt': strToU8('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
    + '4006J20109C2,07:59:00,08:00:00,64200,1\n4006J20109C2,09:00:00,09:01:00,64103,2\n4006J20109C2,09:05:00,09:05:00,64102,3\n4006J20109C2,09:15:00,09:15:00,65000,4\n'
    + '4006J20111C2,10:00:00,10:00:00,64200,1\n4006J20111C2,11:00:00,11:00:00,64103,2\n4006J20111C2,11:05:00,11:05:00,64102,3\n4006J20111C2,11:15:00,11:15:00,65000,4\n'),
});
const ldZip = zipSync({
  'routes.txt': strToU8('route_id,route_short_name\nR1,MD\nR2,AVE\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,1800012026-11-02,18000\nR2,A,0515212026-11-02,05152\n'),
  'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence,arrival_time,departure_time\n'
    + '1800012026-11-02,65000,1,06:00:00,06:00:00\n1800012026-11-02,64103,2,06:20:00,06:21:00\n1800012026-11-02,64200,3,07:30:00,07:30:00\n'
    + '0515212026-11-02,65000,1,07:00:00,07:00:00\n0515212026-11-02,64200,2,07:50:00,07:50:00\n'),
});

/** Caché con los dos GTFS y lo calculado guardado en memoria (lo que en el servidor va a disco). */
function memoryCache(store = new Map()) {
  return {
    store,
    bytes: async (url, name) => (name === 'renfe-fomento_transit.zip' ? cercaniasZip : ldZip),
    readValue: async (name) => structuredClone(store.get(name) ?? null),
    writeValue: async (name, value) => { store.set(name, structuredClone(value)); },
  };
}
const entity = (tripId, relation, skipped = []) => ({
  tripUpdate: { trip: { tripId, scheduleRelationship: relation }, stopTimeUpdate: skipped.map((stopId) => ({ stopId, scheduleRelationship: 'SKIPPED' })) },
});
const feeds = (over = {}) => ({
  'alerts.json': { entity: [] },
  'trip_updates.json': { header: { timestamp: '1793870000' }, entity: [entity('4006J20109C2', 'CANCELED'), entity('NO_ESTA_EN_EL_HORARIO', 'CANCELED')] },
  'trip_updates_LD.json': { entity: [
    entity('0515212026-11-02', 'CANCELED'), entity('0515222026-11-02', 'CANCELED'), // las dos variantes del mismo tren
    entity('1800012026-11-02', 'SCHEDULED', ['64200']),
  ] },
  ...over,
});
const httpWith = (byFile) => ({
  json: async (url) => {
    const value = byFile[url.split('/').pop()];
    if (value instanceof Error) throw value;
    return value ?? { entity: [] };
  },
});
const avisosOf = (sources) => sources.find((s) => s.id === 'renfe-avisos');

test('cancelados de Cercanías y de AV/LD/MD (uno por tren) y paradas suprimidas, con la hora de su horario', async () => {
  const cache = memoryCache();
  const avisos = avisosOf(createRenfeSources({ http: httpWith(feeds()), cache, stations, log }));
  const { events, sourceTime } = await avisos.fetch();
  const byId = new Map(events.map((e) => [e.id, e]));
  assert.deepEqual([...byId.keys()].sort(), ['renfe-cancelado:4006J20109C2', 'renfe-cancelado:ld:05152', 'renfe-cancelado:ld:18000'],
    'el viaje que no está en el horario no sale; el AVE, una vez aunque vaya en dos viajes');
  assert.equal(sourceTime, 1_793_870_000_000);

  const cerc = byId.get('renfe-cancelado:4006J20109C2');
  assert.equal(cerc.category, 'cancelacion');
  assert.equal(cerc.title, 'Cercanías C2 20109 cancelado: Moixent 08:00 → València-Estació del Nord');
  assert.deepEqual(cerc.trip.stops.map((s) => s.time), ['08:00', '09:00', '09:05', '09:15'], 'las horas de Cercanías, de lo guardado en la pasada de paradas');
  assert.deepEqual(cerc.trip.stops.map((s) => [s.name, s.lon ?? null]), [
    ['Moixent', -0.75], ['Massanassa', -0.39], ['Alfafar-Benetússer', -0.39], ['València-Estació del Nord', -0.3772],
  ], 'sin coordenadas en el catálogo, las del GTFS');
  assert.equal(cerc.trip.line, 'C2');
  assert.equal(cerc.trip.number, '20109');
  assert.equal(cerc.trip.feedUrl, 'https://gtfsrt.renfe.com/trip_updates.json');
  assert.match(cerc.credit, /^Origen de los datos: Renfe Operadora/);

  const ave = byId.get('renfe-cancelado:ld:05152');
  assert.equal(ave.title, 'AVE 05152 cancelado: València-Estació del Nord 07:00 → Moixent');
  assert.equal(ave.trip.mode, 'av');
  assert.equal(ave.trip.feed, 'GTFS-RT de Alta Velocidad, Larga y Media Distancia');

  const md = byId.get('renfe-cancelado:ld:18000');
  assert.equal(md.type, 'parcial');
  assert.equal(md.title, 'Media Distancia 18000 no llega a Moixent: termina en Massanassa');
  assert.deepEqual([md.lon, md.lat], [-0.75, 38.87]);
});

test('desde cuándo: se guarda y otro arranque no la da por nueva; las nuevas después de arrancar, sin dudas', async (t) => {
  const T0 = Date.parse('2026-11-05T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const cache = memoryCache();
  let current = feeds();
  const http = { json: (url) => httpWith(current).json(url) };
  const read = async (source) => new Map((await source.fetch()).events.map((e) => [e.id, e]));

  let byId = await read(avisosOf(createRenfeSources({ http, cache, stations, log })));
  assert.equal(byId.get('renfe-cancelado:ld:05152').seen, T0);
  assert.equal(byId.get('renfe-cancelado:ld:05152').seenAtStart, true, 'en la primera lectura: pudo publicarse antes');

  // El servidor se reinicia (otra instancia, la misma caché) y dos minutos después lee lo mismo.
  t.mock.timers.tick(2 * 60_000);
  const restarted = avisosOf(createRenfeSources({ http, cache, stations, log }));
  byId = await read(restarted);
  assert.equal(byId.get('renfe-cancelado:ld:05152').seen, T0, 'la hora guardada, no la del reinicio');
  assert.equal(byId.get('renfe-cancelado:ld:05152').seenAtStart, true);

  // Otra lectura, con un tren cancelado nuevo: se ve desde ahora, sin la duda del arranque.
  t.mock.timers.tick(2 * 60_000);
  current = feeds();
  current['trip_updates.json'].entity.push(entity('4006J20111C2', 'CANCELED'));
  byId = await read(restarted);
  assert.equal(byId.get('renfe-cancelado:4006J20111C2').seen, T0 + 4 * 60_000);
  assert.equal(byId.get('renfe-cancelado:4006J20111C2').seenAtStart, undefined);
  assert.equal(byId.get('renfe-cancelado:4006J20111C2').title, 'Cercanías C2 20111 cancelado: Moixent 10:00 → València-Estació del Nord');

  // Renfe deja de publicarla: sigue hasta medianoche como retirada, también tras otro arranque; si vuelve, es nueva.
  t.mock.timers.tick(2 * 60_000);
  current = feeds({ 'trip_updates_LD.json': { entity: [] } });
  byId = await read(restarted);
  const gone = byId.get('renfe-cancelado:ld:05152');
  assert.equal(gone.withdrawn, T0 + 6 * 60_000);
  assert.equal(gone.severity, 'baja');
  assert.equal(gone.seen, T0, 'desde cuándo se vio, el de antes');
  assert.equal(gone.expires, Date.parse('2026-11-05T23:00:00Z'), 'hasta la medianoche de Madrid');
  assert.match(gone.description, /Renfe dejó de publicarlo a las 09:06, después de su hora de llegada: lo hace con los viajes que ya han pasado\.$/);
  assert.equal(gone.trip.withdrawnAfterArrival, true);
  byId = await read(avisosOf(createRenfeSources({ http, cache, stations, log })));
  assert.equal(byId.get('renfe-cancelado:ld:05152').withdrawn, T0 + 6 * 60_000, 'un reinicio no la olvida');
  t.mock.timers.tick(2 * 60_000);
  current = feeds();
  byId = await read(restarted);
  assert.equal(byId.get('renfe-cancelado:ld:05152').seen, T0 + 8 * 60_000);
  assert.equal(byId.get('renfe-cancelado:ld:05152').withdrawn, undefined, 'vuelve a publicarse: ya no está retirada');
});

test('si un feed falla, sus cancelaciones siguen (una hora desde la última lectura buena) y no se dan por nuevas', async (t) => {
  const T0 = Date.parse('2026-11-05T08:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  let current = feeds();
  const avisos = avisosOf(createRenfeSources({ http: { json: (url) => httpWith(current).json(url) }, cache: memoryCache(), stations, log }));
  await avisos.fetch();
  t.mock.timers.tick(5 * 60_000);
  current = feeds({ 'trip_updates_LD.json': new Error('HTTP 503') });
  const byId = new Map((await avisos.fetch()).events.map((e) => [e.id, e]));
  const ave = byId.get('renfe-cancelado:ld:05152');
  assert.ok(ave, 'sigue aunque su feed haya fallado');
  assert.equal(ave.expires, T0 + 3600_000, 'una hora desde la última lectura buena');
  assert.equal(ave.seen, T0);
  assert.ok(byId.has('renfe-cancelado:4006J20109C2'), 'las del otro feed, de esta lectura');
  // Fallan los tres: la lectura falla (y el repositorio guarda la anterior).
  current = feeds({ 'alerts.json': new Error('x'), 'trip_updates.json': new Error('x'), 'trip_updates_LD.json': new Error('x') });
  await assert.rejects(avisos.fetch());
});

test('el aviso de Renfe que nombra el tren cancelado (por su hora y su origen) y los de su línea van en su cancelación', async () => {
  const text = (s) => ({ translation: [{ text: s, language: 'es' }] });
  const alerts = { entity: [
    { id: 'a1', alert: { informedEntity: [{ routeId: '40T0006C2' }], descriptionText: text('Línea C2. Tren con salida prevista a las 08:00h de la estación de Moixent con destino València Nord, hoy no circula.') } },
    { id: 'a2', alert: { informedEntity: [{ routeId: '40T0006C2' }], descriptionText: text('Por obras en la infraestructura entre Moixent y Xàtiva, algunos trenes circulan con retraso.') } },
    { id: 'a3', alert: { informedEntity: [{ routeId: '40T0006C2' }], descriptionText: text('Ascensor de la estación de Massanassa fuera de servicio.') } },
    { id: 'a4', alert: { informedEntity: [{ routeId: '40T0002C1' }], descriptionText: text('Por una avería, los trenes de la C1 circulan con retraso.') } },
  ] };
  const avisos = avisosOf(createRenfeSources({ http: httpWith(feeds({ 'alerts.json': alerts })), cache: memoryCache(), stations, log }));
  const cerc = (await avisos.fetch()).events.find((e) => e.id === 'renfe-cancelado:4006J20109C2');
  assert.equal(cerc.trip.notice.text, alerts.entity[0].alert.descriptionText.translation[0].text);
  assert.match(cerc.description, /Aviso de Renfe sobre este viaje: Línea C2\. Tren con salida prevista a las 08:00h/);
  assert.deepEqual(cerc.trip.lineNotices.map((n) => n.text), ['Por obras en la infraestructura entre Moixent y Xàtiva, algunos trenes circulan con retraso.'],
    'los de su línea, sin los de otro tren ni los de un ascensor; los de otra línea, no');
});

// Horario de AV/LD/MD con calendario: los dos trenes circulan todos los días.
const ldWithCalendar = zipSync({
  'routes.txt': strToU8('route_id,route_short_name\nR1,MD\nR2,AVE\n'),
  'trips.txt': strToU8('route_id,service_id,trip_id,trip_short_name\nR1,A,1800012026-11-02,18000\nR2,A,0515212026-11-02,05152\n'),
  'calendar.txt': strToU8('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nA,1,1,1,1,1,1,1,20260101,20271231\n'),
  'calendar_dates.txt': strToU8('service_id,date,exception_type\n'),
  'stop_times.txt': strToU8('trip_id,stop_id,stop_sequence,arrival_time,departure_time\n'
    + '1800012026-11-02,65000,1,06:00:00,06:00:00\n1800012026-11-02,64103,2,06:20:00,06:21:00\n1800012026-11-02,64200,3,07:30:00,07:30:00\n'
    + '0515212026-11-02,65000,1,07:00:00,07:00:00\n0515212026-11-02,64200,2,07:50:00,07:50:00\n'),
});

test('trenes sin datos: según su horario circulan ahora y Renfe no publica ni su posición, ni su retraso, ni su cancelación', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-02T06:20:00Z') }); // 07:20 en Madrid
  const cache = { ...memoryCache(), bytes: async (url, name) => (name === 'renfe-fomento_transit.zip' ? cercaniasZip : ldWithCalendar) };
  const positions = { entity: [{ vehicle: {
    trip: { tripId: '0515212026-11-02' }, vehicle: { id: '05152' }, position: { latitude: 39.2, longitude: -0.5 }, stopId: '64200', currentStatus: 'IN_TRANSIT_TO',
  } }] };
  let updatesLd = { entity: [] };
  const http = { json: async (url) => {
    const file = url.split('/').pop();
    if (file === 'vehicle_positions_LD.json') return positions;
    if (file === 'trip_updates_LD.json') return updatesLd;
    return { entity: [] };
  } };
  const sources = createRenfeSources({ http, cache, stations, log });
  const ld = sources.find((s) => s.id === 'renfe-ld');
  const avisos = avisosOf(sources);
  const missing = async () => (await avisos.fetch()).events.filter((e) => e.category === 'sin-datos');

  assert.deepEqual(await missing(), [], 'sin una lectura reciente de las posiciones, ninguno');
  await ld.fetch();
  const [md] = await missing();
  assert.equal(md.id, 'renfe-sin-datos:18000');
  assert.equal(md.title, 'Media Distancia 18000 sin datos de Renfe: València-Estació del Nord 06:00 → Moixent');
  assert.deepEqual(md.trip.between, ['Massanassa', 'Moixent']);
  assert.deepEqual([md.lon, md.lat], [-0.39, 39.41], 'en Massanassa, la última por la que debería haber pasado');
  assert.equal(md.trip.date, '2026-11-02');
  assert.equal(md.seen, Date.parse('2026-11-02T06:20:00Z'));
  assert.equal((await avisos.fetch()).events.some((e) => e.category === 'cancelacion' && e.withdrawn), false, 'no es una cancelación: no se «retira»');

  updatesLd = { entity: [{ tripUpdate: { trip: { tripId: '1800012026-11-02' }, stopTimeUpdate: [{ stopId: '64200', arrival: { delay: 300 } }] } }] };
  assert.deepEqual(await missing(), [], 'con su retraso publicado, ya hay datos');
  updatesLd = { entity: [] };

  t.mock.timers.tick(3 * 60_000);
  assert.deepEqual(await missing(), [], 'las posiciones ya no son recientes: no se sabe');
  await ld.fetch();
  assert.equal((await missing()).length, 1);
  t.mock.timers.tick(5 * 60_000); // 07:28: le quedan menos de 5 minutos para llegar
  await ld.fetch();
  assert.deepEqual(await missing(), []);
});
