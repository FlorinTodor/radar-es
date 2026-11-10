import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tx, useLang } from '../../public/js/i18n.js';
import { EXACT, PATTERNS } from '../../public/js/i18n/en-servidor.js';
import {
  delayJumps, earthquakesNearTrains, feedHealth, firesNearTrains, fleetDrop, gridDemandDrop, isolatedGridBlackouts, largeDelays,
  officialEmergencyPlans, officialPowerCuts, severeWeather, stoppedClusters, stoppedOutsideStation, disasterAlerts, GRID_METRICS,
} from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { recordPositions } from '../../server/domain/tracking.js';
import { cancellationEvent, mergeSameTrain, missingTrainEvent, withdrawnCancellation } from '../../server/domain/cancelaciones.js';
import { parseDgt } from '../../server/adapters/outbound/sources/dgt.js';
import { createFirmsSource } from '../../server/adapters/outbound/sources/firms.js';
import { createIgnSismosSource } from '../../server/adapters/outbound/sources/ign-sismos.js';
import { createEmscSismosSource } from '../../server/adapters/outbound/sources/emsc-sismos.js';

// Los textos que escribe el servidor, en inglés (server/domain/en-servidor.js). Se generan con el propio
// servidor: si cambia una de sus plantillas, la traducción deja de encajar y este test lo dice. Los nombres y
// lo que publica cada fuente tienen que salir tal cual.
before(() => useLang('en'));
after(() => useLang('es'));

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 18, 18, 0);
const train = (label, lat, lon, extra = {}) => ({
  id: label, mode: 'av', operator: 'Renfe', service: 'AVE', line: 'AVE', label, lat, lon, delay: 0,
  origin: 'Madrid-Puerta de Atocha', destination: 'Sevilla-Santa Justa', ...extra,
});
const ctx = (over) => ({
  now: T0, vehicles: [], tracks: new Map(), events: [], metrics: {}, health: [], kpis: { vehicles: 0 }, kpiHistory: [],
  nearestStation: () => ({ station: { name: 'Adamuz' }, km: 4.2 }), thresholds: DEFAULT_THRESHOLDS, ...over,
});
function stationary(vehicles, minutes) {
  const tracks = new Map();
  for (let m = 0; m <= minutes; m += 1) recordPositions(tracks, vehicles, T0 - (minutes - m) * MIN);
  return tracks;
}
const both = (a) => [tx(a.title), tx(a.description)];

test('alertas de trenes: detenidos, sin GPS, agrupados, retrasos y saltos de retraso; los nombres, igual', () => {
  const v = train('03063', 38.0, -4.5);
  assert.deepEqual(both(stoppedOutsideStation(ctx({ vehicles: [v], tracks: stationary([v], 12) }))[0]), [
    'AVE 03063 stopped between stations',
    'Not moving for 12 min, 4.2 km from Adamuz. This source does not publish the GPS time: it may also be a frozen position. '
      + 'Madrid-Puerta de Atocha → Sevilla-Santa Justa.',
  ]);
  const withFix = train('03063', 38.0, -4.5, { fixTime: T0 - MIN });
  assert.equal(tx(stoppedOutsideStation(ctx({ vehicles: [withFix], tracks: stationary([withFix], 12) }))[0].description),
    'Not moving for 12 min, 4.2 km from Adamuz. Madrid-Puerta de Atocha → Sevilla-Santa Justa.');
  const frozen = train('03063', 38.0, -4.5, { fixTime: T0 - 30 * MIN });
  assert.deepEqual(both(stoppedOutsideStation(ctx({ vehicles: [frozen], tracks: stationary([frozen], 30) }))[0]),
    ['AVE 03063 without an updated position', 'Last GPS fix 30 min ago, away from any station (4.2 km from Adamuz).']);
  const nowhere = ctx({ vehicles: [frozen], tracks: stationary([frozen], 30), nearestStation: () => null });
  assert.equal(tx(stoppedOutsideStation(nowhere)[0].description), 'Last GPS fix 30 min ago, away from any station.');

  const pair = [train('03063', 38.0, -4.5), train('03071', 38.01, -4.51, { service: 'Alvia', line: 'Alvia' })];
  const c = ctx({ vehicles: pair, tracks: stationary(pair, 15) });
  stoppedOutsideStation(c);
  assert.deepEqual(both(stoppedClusters(c)[0]),
    ['2 trains stopped close together near Adamuz', 'Possible line blockage or incident: AVE 03063 (15 min), Alvia 03071 (15 min).']);

  const late = (extra) => largeDelays(ctx({ vehicles: [train('00291', 38, -4.5, { service: 'Cercanías', line: 'C3', delay: 52, ...extra })] }))[0];
  assert.deepEqual(both(late({ next: 'Córdoba' })),
    ['Cercanías C3 00291 running 52 min late', 'Madrid-Puerta de Atocha → Sevilla-Santa Justa. Next stop: Córdoba.']);
  assert.equal(tx(late({ current: 'Villanueva de Córdoba' }).description), 'Madrid-Puerta de Atocha → Sevilla-Santa Justa. At Villanueva de Córdoba.');
  assert.equal(tx(late({}).description), 'Madrid-Puerta de Atocha → Sevilla-Santa Justa.');

  const tracks = new Map();
  recordPositions(tracks, [train('03063', 38, -4.5, { delay: 2 })], T0 - 10 * MIN);
  const jump = delayJumps(ctx({ vehicles: [train('03063', 38.05, -4.4, { delay: 25 })], tracks }))[0];
  assert.deepEqual(both(jump), ['AVE 03063: delay jumps by 23 min', `From 2 to 25 min in less than ${DEFAULT_THRESHOLDS.delayJumpWindowMin} min.`]);
});

test('alertas de terremotos, avisos de AEMET, incendios, GDACS y avisos oficiales: lo nuestro en inglés, lo de la fuente tal cual', () => {
  const quake = { id: 'q', category: 'sismo', magnitude: 4.0, start: T0 - 10 * MIN, lat: 37.1, lon: -3.6, title: 'Terremoto M4.0 · al noreste de Gójar (Granada)' };
  const [near] = earthquakesNearTrains(ctx({ events: [quake], vehicles: [train('03063', 37.1, -3.6)] }));
  assert.deepEqual(both(near), ['Earthquake M4.0 · north-east of Gójar (Granada)', '1 train within 50 km.']);
  assert.equal(tx(earthquakesNearTrains(ctx({ events: [quake] }))[0].description), 'No trains within 50 km.');

  const zone = { type: 'Polygon', coordinates: [[[-1, 39], [0, 39], [0, 40], [-1, 40], [-1, 39]]] };
  const aemet = { id: 'dana', category: 'meteo', level: 'rojo', title: 'Aviso rojo por lluvias · Litoral sur de Valencia', description: 'Acumulados de 180 mm en 12 horas.', geometry: zone, start: T0 - MIN, end: T0 + 6 * 3600_000 };
  const [weather] = severeWeather(ctx({ events: [aemet], vehicles: [train('03063', 39.5, -0.5)] }));
  assert.equal(tx(weather.title), 'Aviso rojo por lluvias · Litoral sur de Valencia · 1 train inside', 'el aviso de AEMET, sin alterar');
  assert.match(tx(weather.description), /^Acumulados de 180 mm en 12 horas\. Trains in the area: AVE 03063\. Valid until \d{1,2}\/\d{1,2}\/\d\d, \d{1,2}:\d\d\.$/);
  const [quiet] = severeWeather(ctx({ events: [{ ...aemet, end: null }] }));
  assert.equal(tx(quiet.title), aemet.title, 'sin trenes dentro, el título es el de AEMET');
  assert.equal(tx(quiet.description), aemet.description);

  const fire = (id) => ({ id, category: 'incendio', lat: 38.01, lon: -4.5, frp: 12, start: T0 - 60 * MIN });
  const [blaze] = firesNearTrains(ctx({ vehicles: [train('03063', 38.0, -4.5)], events: [fire('f1'), fire('f2')] }));
  assert.deepEqual(both(blaze), [`Possible fire less than ${DEFAULT_THRESHOLDS.fireNearKm} km from 1 train`,
    '2 satellite detections (max. power 12 MW). Trains: AVE 03063. It may be an industrial heat source: check with official sources.']);

  const gdacs = { id: 'g', category: 'catastrofe', level: 'naranja', title: 'Orange earthquake alert (Magnitude 6.1M, Depth:10km) in Morocco', description: 'On 11/10/2026, an earthquake occurred.', lat: 35, lon: -4 };
  assert.deepEqual(both(disasterAlerts(ctx({ events: [gdacs] }))[0]), [gdacs.title, gdacs.description]);

  const official = {
    id: 'emergencias-canarias:123:la-palma', group: 'emergencias-canarias:123', category: 'emergencia', power: true, severity: 'alta',
    title: 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma',
    description: 'A las 06:42 h se ha producido un fallo general del sistema eléctrico en la isla de La Palma (cero energético).',
    area: 'La Palma', approx: 'isla', lat: 28.68, lon: -17.86,
  };
  assert.deepEqual(both(officialPowerCuts(ctx({ events: [official] }))[0]),
    ['Power cut · La Palma', `Official notice: «${official.description}».`]);
  assert.equal(tx(officialPowerCuts(ctx({ events: [{ ...official, approx: 'comunidad' }] }))[0].description),
    `Official notice: «${official.description}» (the notice does not give the exact place).`);
  const plan = { ...official, power: false, title: 'PROCICAT · ALERTA', description: 'Pla activat per risc de nevades.', area: 'Cataluña' };
  assert.deepEqual(both(officialEmergencyPlans(ctx({ events: [plan] }))[0]), ['PROCICAT · ALERTA · Cataluña', plan.description],
    'el plan, tal cual lo publica la Generalitat');
});

test('alertas de la red eléctrica, de la flota y de las fuentes; los números de MW, a la inglesa', () => {
  const at = Date.UTC(2026, 3, 28, 10, 35);
  const drop = gridDemandDrop(ctx({ metrics: { [GRID_METRICS.peninsular]: { demandMW: 18_000.5, forecastMW: 26_000, deviation: -0.31, at } } }))[0];
  assert.deepEqual(both(drop), ['Electricity demand 31% below forecast',
    'Actual 18,000.5 MW at 12:35 against 26,000 MW forecast. A sudden drop may point to a blackout or a large power cut (Radar España estimate with Red Eléctrica data).']);
  assert.equal(drop.credit, 'Fuente: Red Eléctrica', 'la atribución, con la fórmula de su aviso legal');

  const now = Date.parse('2026-11-02T06:50:00Z');
  const sys = (real, programmed) => ({ id: 'la-palma', name: 'La Palma', real, programmed, recentMax: real, readMax: real, at: now - 10 * MIN, previous: { real, at: now - 15 * MIN } });
  const isolated = (s) => isolatedGridBlackouts(ctx({ now, metrics: { [GRID_METRICS.aislados]: { systems: [s] } } }))[0];
  const zero = isolated(sys(0, 21));
  assert.equal(tx(zero.title), 'Possible total blackout in La Palma: demand at 0 MW');
  assert.match(tx(zero.description), /^Actual 0 MW at .+ \(mainland time\) against 21 MW scheduled\. Radar España estimate with Red Eléctrica data: check it against the official notices\.$/);
  assert.equal(tx(isolated(sys(7.3, 21)).title), 'La Palma electricity demand 65% below expected');

  const fleet = fleetDrop(ctx({ kpis: { vehicles: 120 }, kpiHistory: [{ t: T0 - 10 * MIN, vehicles: 300 }] }))[0];
  assert.deepEqual(both(fleet), ['Trains disappearing from the map: 120 now against 300 10 min ago',
    'It may be an outage of the data source or a widespread service disruption.']);

  const source = { id: 'renfe-ld', name: 'Renfe AV/LD/MD (GTFS-RT)', enabled: true, kind: 'vehicles', interval: 30_000 };
  const down = feedHealth(ctx({ health: [{ ...source, ok: false, lastOk: T0 - 10 * MIN, error: 'HTTP 503 en gtfsrt.renfe.com' }] }))[0];
  assert.deepEqual(both(down), ['Renfe AV/LD/MD (GTFS-RT): not responding', 'Last error: HTTP 503 at gtfsrt.renfe.com']);
  const stale = feedHealth(ctx({ health: [{ ...source, ok: true, lastOk: T0, sourceTime: T0 - 20 * MIN }] }))[0];
  assert.deepEqual(both(stale), ['Renfe AV/LD/MD (GTFS-RT): data not updating', 'The source has not updated for 20 min.']);
});

// ---------- Cancelaciones (las muestras, como las de test/domain/cancelaciones.test.js) ----------
const STOPS = [
  { name: 'Badajoz', time: 6 * 3600 + 29 * 60, at: [-6.98, 38.89] },
  { name: 'Mérida', time: 7 * 3600 + 4 * 60, at: [-6.34, 38.92] },
  { name: 'Cáceres', time: 7 * 3600 + 40 * 60, at: [-6.37, 39.46] },
  { name: 'Madrid-Chamartín-Clara Campoamor', time: 11 * 3600 + 7 * 60, at: [-3.68, 40.47] },
];
const base = {
  id: 'renfe-cancelado:ld:00291', who: 'Alvia 00291', operator: 'Renfe', mode: 'ld', service: 'Alvia', number: '00291',
  publisher: 'Renfe', feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia', feedUrl: 'https://gtfsrt.renfe.com/trip_updates_LD.json',
  credit: 'Origen de los datos: Renfe Operadora', seen: 1000, cancelled: true, running: false,
};
const LD_EN = 'GTFS-RT for High Speed, Long and Medium Distance';

test('cancelaciones: título y descripción en inglés, con las estaciones, el motivo y el aviso del operador tal cual', () => {
  const whole = cancellationEvent({ ...base, stops: STOPS }, 5000);
  assert.deepEqual(both(whole), ['Alvia 00291 cancelled: Badajoz 06:29 → Madrid-Chamartín-Clara Campoamor',
    `Renfe reports it as cancelled in its real-time feed (${LD_EN}). According to the timetable, it left Badajoz at 06:29 and arrived at Madrid-Chamartín-Clara Campoamor at 11:07.`]);
  assert.equal(tx(cancellationEvent({ ...base, stops: null }, 5000).title), 'Alvia 00291 cancelled');

  const partial = (skip, extra = {}) => cancellationEvent({ ...base, cancelled: false, running: true, stops: STOPS.map((s, i) => ({ ...s, skipped: skip.includes(i) })), ...extra }, 5000);
  assert.equal(tx(partial([3]).title), 'Alvia 00291 does not reach Madrid-Chamartín-Clara Campoamor: terminates at Cáceres');
  assert.equal(tx(partial([0]).title), 'Alvia 00291 does not start from Badajoz: starts at Mérida');
  assert.equal(tx(partial([1]).title), 'Alvia 00291 skips Mérida');
  assert.equal(tx(partial([1, 2]).title), 'Alvia 00291 skips 2 stations');
  assert.equal(tx(partial([1, 2]).description), `Renfe reports these 2 stops as skipped in its real-time feed (${LD_EN}): Mérida; Cáceres. `
    + 'According to the timetable, it left Badajoz at 06:29 and arrived at Madrid-Chamartín-Clara Campoamor at 11:07.');
  assert.match(tx(partial([0, 1, 2, 3]).description), /^Renfe reports all its stops as skipped in its real-time feed/);
  assert.match(tx(cancellationEvent({ ...base, running: true, stops: STOPS }, 5000).description),
    /Renfe also publishes its delay or position: it may be partly running\.$/);
  assert.match(tx(partial([3], { cancelled: true }).description), /Renfe also marks it as cancelled in another entry of its real-time feed\.$/);

  // Motivo y aviso: del operador, tal cual.
  const notice = 'Por una avería en la infraestructura, hoy no circula. Según el horario previsto se repondrá mañana.';
  const withNotice = cancellationEvent({ ...base, stops: STOPS, notice: { id: '9', text: notice } }, 5000);
  assert.ok(tx(withNotice.description).endsWith(`Notice from Renfe about this trip: ${notice}`), tx(withNotice.description));
  const reason = 'Desvío línea 7: Línea 7 desviada entre las paradas A y B.';
  const bus = cancellationEvent({ ...base, id: 'auvasa-suprimidas:7', who: 'Línea 7 de AUVASA', publisher: 'AUVASA', operator: 'AUVASA', mode: 'bus', number: null,
    feed: 'GTFS-RT de avisos de servicio', stops: null, skippedNames: ['Plaza Uruguay'], cancelled: false, running: true, reason }, 5000);
  assert.deepEqual(both(bus), ['AUVASA line 7 skips Plaza Uruguay',
    `${reason} AUVASA reports this stop as skipped in its real-time feed (GTFS-RT service alerts): Plaza Uruguay.`]);

  const amb = cancellationEvent({
    ...base, id: 'amb-bus-suprimidas:129:x', who: 'Línea 129 de AMB', operator: 'AMB', publisher: 'AMB', mode: 'bus', number: null,
    feed: 'GTFS-RT de actualizaciones de viaje', cancelled: false, running: true, trips: 7, date: '20261105',
    stops: [{ name: 'Zona Universitària', at: [2.11, 41.38], skipped: true }, { name: 'Palau Reial', at: [2.12, 41.38] }, { name: 'Fabra i Puig', at: [2.18, 41.43] }],
  }, 5000);
  assert.deepEqual(both(amb), ['AMB line 129 does not start from Zona Universitària: starts at Palau Reial',
    'AMB reports this stop as skipped on 7 trips in its real-time feed (GTFS-RT trip updates): Zona Universitària.']);
  assert.equal(tx(cancellationEvent({ ...base, who: 'Autobús 5 de TUSSAM', mode: 'bus', stops: null, skippedNames: ['Prado', 'Puerta Jerez'],
    cancelled: false, running: true }, 5000).title), 'TUSSAM bus 5 skips 2 stops');
  assert.equal(tx(cancellationEvent({ ...base, who: 'Tren 12345', stops: null }, 5000).title), 'Train 12345 cancelled');
});

test('cancelaciones que su fuente deja de publicar y el mismo tren en dos ficheros', () => {
  const shown = cancellationEvent({ ...base, stops: STOPS }, 5000);
  const MIDNIGHT = 90_000_000;
  assert.match(tx(withdrawnCancellation(shown, { now: 9000, clock: '11:30', endOfDay: MIDNIGHT }).description),
    /\. Renfe stopped publishing it at 11:30, after its arrival time: it does this with trips that have already run\.$/);
  assert.match(tx(withdrawnCancellation(shown, { now: 9000, clock: '08:00', endOfDay: MIDNIGHT }).description),
    /\. Renfe stopped publishing it at 08:00, before its arrival time: it may run after all, or it may have been withdrawn for another reason\.$/);
  const anonymous = { ...shown, trip: { ...shown.trip, publisher: undefined, arrival: null } };
  assert.match(tx(withdrawnCancellation(anonymous, { now: 9000, clock: '09:00', endOfDay: MIDNIGHT }).description), /\. The source stopped publishing it at 09:00\.$/);

  const h = (hh, mm) => hh * 3600 + mm * 60;
  const RODALIES = { publisher: 'Renfe', operator: 'Renfe', credit: 'Origen de los datos: Renfe Operadora', cancelled: true, running: false,
    feed: 'GTFS-RT de Cercanías y Rodalies', feedUrl: 'https://gtfsrt.renfe.com/trip_updates.json' };
  const r16 = cancellationEvent({ ...RODALIES, id: 'renfe-cancelado:5113M18093R16', who: 'Rodalies R16 18093', mode: 'cercanias', service: 'Rodalies', line: 'R16', number: '18093',
    stops: [{ name: 'Barcelona Estació de França', time: h(9, 15) }, { name: 'Barcelona-Passeig de Gràcia', time: h(9, 26) }, { name: 'Tortosa', time: h(11, 20) }], seen: 2000 }, 5000);
  const re = cancellationEvent({ ...RODALIES, feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia', id: 'renfe-cancelado:ld:18093', who: 'Regional Exprés 18093',
    mode: 'md', service: 'Regional Exprés', number: '18093', stops: [{ name: 'Barcelona Estació de França', time: h(9, 15) }, { name: 'Barcelona-Passeig de Gràcia', time: h(9, 25) },
      { name: 'Tortosa', time: h(11, 20) }, { name: 'València-Estació del Nord', time: h(15, 25) }], seen: 3000 }, 5000);
  const [merged] = mergeSameTrain([r16, re]);
  const text = tx(merged.description);
  assert.match(text, /^Renfe reports it as cancelled in its real-time feed \(GTFS-RT for High Speed, Long and Medium Distance\)\./);
  assert.match(text, /Renfe also publishes it in its GTFS-RT for Cercanías and Rodalies, as Rodalies R16 18093 \(Barcelona Estació de França → Tortosa\)\.$/);
  assert.equal(tx('GTFS-RT de Cercanías y Rodalies'), 'GTFS-RT for Cercanías and Rodalies', 'el nombre del fichero, suelto (la ficha lo enseña)');
  assert.equal(tx('Línea 129 de AMB'), 'AMB line 129', 'quién, suelto (la ficha lo enseña en «como …»)');
});

test('trenes sin datos', () => {
  const e = missingTrainEvent({
    id: 'renfe-sin-datos:37090', who: 'Media Distancia 37090', operator: 'Renfe', mode: 'md', service: 'Media Distancia', number: '37090',
    stops: STOPS, at: 1, date: '2026-11-05', publisher: 'Renfe', feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia (posiciones y actualizaciones de viaje)',
    credit: 'Origen de los datos: Renfe Operadora', seen: 1000,
  }, 5000);
  assert.deepEqual(both(e), ['Media Distancia 37090: no data from Renfe: Badajoz 06:29 → Madrid-Chamartín-Clara Campoamor',
    'According to its timetable it should be running: it left Badajoz at 06:29 and arrives at Madrid-Chamartín-Clara Campoamor at 11:07; '
      + 'it would now be between Mérida and Cáceres. Renfe publishes neither its position nor its delay in its real-time feed, nor reports it as cancelled: '
      + 'the radar cannot tell whether it is running.']);
  assert.equal(tx(e.trip.feed), 'GTFS-RT for High Speed, Long and Medium Distance (positions and trip updates)');
});

// ---------- Terremotos, focos de calor y tráfico, desde sus adaptadores ----------

test('terremotos del IGN y del EMSC: «Earthquake», la dirección en inglés y el nombre del lugar igual', async () => {
  const INFO = 'http://www.ign.es/web/ign/portal/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=';
  const f = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { ultimo: 'false', ...props } });
  const DOC = { type: 'FeatureCollection', features: [
    f(-7.4218, 36.6311, { fecha: '25/10/2026 10:37:19', info: `${INFO}es2026uxomc`, 'localización': 'GOLFO DE CÁDIZ', magnitud: 2.7, profundidad: 37 }),
    f(-3.5668, 37.0883, { fecha: '04/11/2026 03:23:55', info: `${INFO}es2026vpzza`, intensidad: '             III', 'localización': 'NE GÓJAR.GR', magnitud: 2.5, profundidad: 4 }),
    f(-9.9333, 36.4823, { fecha: '26/10/2026 01:51:14', info: `${INFO}es2026uysqc`, 'localización': 'SW CABO DE SAN VICENTE', magnitud: 2.6, profundidad: 45 }),
    f(-1.5, 35.5, { fecha: '26/10/2026 05:00:00', info: `${INFO}es2026uyalg`, 'localización': 'N ORÁN.ARG', magnitud: 3.1, profundidad: 10 }),
    f(-16.5, 28.3, { fecha: '27/10/2026 08:00:00', info: `${INFO}es2026canar`, 'localización': 'ATLÁNTICO-CANARIAS', magnitud: 2.0, profundidad: 20 }),
  ] };
  const { events } = await createIgnSismosSource({ http: { json: async () => DOC }, now: () => Date.parse('2026-11-04T19:12:00Z') }).fetch();
  const byId = Object.fromEntries(events.map((e) => [e.id, e]));
  assert.equal(tx(byId['ign:es2026uxomc'].title), 'Earthquake M2.7 · Golfo de Cádiz');
  assert.deepEqual(both(byId['ign:es2026vpzza']), ['Earthquake M2.5 · north-east of Gójar (Granada)',
    'Magnitude 2.5 earthquake at a depth of 4 km, north-east of Gójar (Granada), on 4/11/26, 4:23. Located by the Instituto Geográfico Nacional (IGN). Felt with intensity III.']);
  assert.equal(tx(byId['ign:es2026uysqc'].title), 'Earthquake M2.6 · south-west of Cabo de San Vicente');
  assert.equal(tx(byId['ign:es2026uyalg'].title), 'Earthquake M3.1 · north of Orán (Algeria)');
  assert.match(tx(byId['ign:es2026canar'].description), /^Magnitude 2\.0 earthquake at a depth of 20 km \(Atlántico-Canarias\), on .+ \(Canary Islands time\)\. Located by the Instituto/);
  for (const e of events) assert.doesNotMatch(`${tx(e.title)} ${tx(e.description)}`, /Terremoto|magnitud|profundidad|Localizado|al (noreste|suroeste|norte)/, e.id);

  const NOW = Date.parse('2026-11-04T12:00:00Z');
  const ef = (props) => ({ type: 'Feature', properties: { evtype: 'ke', magtype: 'ml', depth: 7.6, ...props } });
  const EMSC = { type: 'FeatureCollection', features: [
    ef({ unid: '20261103_0000200', time: '2026-11-03T18:08:57Z', flynn_region: 'CANARY ISLANDS, SPAIN REGION', lat: 28.1, lon: -16.0, auth: 'EMSC', mag: 3.1, depth: -12 }),
    ef({ unid: '20261103_0000120', time: '2026-11-03T10:23:00Z', flynn_region: 'NEAR SOUTH COAST OF FRANCE', lat: 43.7746, lon: 3.3095, auth: 'ReNaSS', mag: 2.1 }),
    ef({ unid: '20261102_0000003', time: '2026-11-02T19:00:00Z', flynn_region: 'SOME NEW REGION', lat: 41, lon: 2, auth: 'XYZ', mag: 1.9 }),
  ] };
  const emsc = (await createEmscSismosSource({ http: { json: async () => EMSC }, now: () => NOW }).fetch()).events;
  for (const e of emsc) {
    const [title, description] = both(e);
    assert.match(title, /^Earthquake M\d\.\d · /, title);
    assert.match(description, /^Magnitude \d\.\d earthquake at a depth of \d+ km.+, on .+\. Located by .+; data from the EMSC-CSEM SeismicPortal\.$/, description);
  }
  assert.match(tx(emsc.find((e) => e.id === 'emsc:20261103_0000120').description), /Located by the ReNaSS \(France\);/);
});

test('focos de calor (NASA FIRMS) e incidencias de tráfico de la DGT', async () => {
  const CSV = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n'
    + '38.5,-4.2,330.1,0.4,0.4,2026-11-04,1342,N20,VIIRS,n,2.0NRT,290.1,14.6,D\n';
  const { events } = await createFirmsSource({ http: { text: async () => CSV } }).fetch();
  assert.deepEqual(both(events[0]), ['Hotspot of 15 MW',
    'Detected by satellite (VIIRS, NOAA-20) at 13:42 UTC, confidence n. It may be a wildfire, an agricultural burn or an industrial heat source.']);

  const record = (id, cause, road, km) => `
  <sit:situation id="s${id}"><sit:situationRecord id="${id}" version="1">
    <sit:validity><com:validityTimeSpecification><com:overallStartTime>2026-11-04T16:05:26.000+01:00</com:overallStartTime></com:validityTimeSpecification></sit:validity>
    <sit:cause><sit:causeType>${cause}</sit:causeType></sit:cause>
    <sit:locationReference><loc:supplementaryPositionalDescription><loc:roadInformation><loc:roadName>${road}</loc:roadName></loc:roadInformation></loc:supplementaryPositionalDescription>
      <loc:tpegLinearLocation><loc:from><loc:pointCoordinates><loc:latitude>40.1</loc:latitude><loc:longitude>-3.2</loc:longitude></loc:pointCoordinates>
        <loc:_tpegNonJunctionPointExtension><loc:extendedTpegNonJunctionPoint><lse:kilometerPoint>${km}</lse:kilometerPoint></loc:extendedTpegNonJunctionPoint></loc:_tpegNonJunctionPointExtension>
      </loc:from></loc:tpegLinearLocation></sit:locationReference>
  </sit:situationRecord></sit:situation>`;
  const DATEX = `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="d2" xmlns:sit="sit" xmlns:com="com" xmlns:loc="loc" xmlns:lse="lse">
  ${record('a', 'accident', 'A-3', 80)}${record('b', 'roadMaintenance', 'A-67', 192.3)}${record('c', 'vehicleObstruction', 'N-432', 12)}
  ${record('d', 'abnormalTraffic', 'M-30', 4.5)}${record('e', 'someNewCode', 'A-1', 3)}
</d2:payload>`;
  const titles = parseDgt(DATEX, Date.parse('2026-11-04T16:20:00Z')).events.map((e) => tx(e.title));
  assert.deepEqual(titles, ['Accident · A-3 km 80.0', 'Roadworks · A-67 km 192.3', 'Stopped vehicle or obstruction · N-432 km 12.0',
    'Traffic queue · M-30 km 4.5', 'someNewCode · A-1 km 3.0']);
  assert.equal(tx('Getafe, Madrid · Carretera cortada'), 'Getafe, Madrid · Road closed');
  assert.equal(tx('Incidencia'), 'Incident');
});

test('títulos por defecto de los avisos, por qué no se lee una fuente y sus errores de lectura', () => {
  assert.equal(tx('Aviso Renfe'), 'Renfe notice');
  assert.equal(tx('Aviso Renfe · C1, C10'), 'Renfe notice · C1, C10');
  assert.equal(tx('Aviso Rodalies'), 'Rodalies notice');
  assert.equal(tx('Aviso EMT Madrid'), 'EMT Madrid notice');
  assert.equal(tx('Alerta GDACS'), 'GDACS alert');
  assert.equal(tx('TUSSAM · Aviso'), 'TUSSAM · Notice');
  assert.equal(tx('En pausa mientras su web no responda a nuestro servidor'), 'Paused while its website does not respond to our server');
  assert.equal(tx('Falta NAP_API_KEY, TMB_APP_KEY en .env'), 'Missing NAP_API_KEY, TMB_APP_KEY in .env');
  assert.equal(tx('HTTP 403 en www.madrid.org'), 'HTTP 403 at www.madrid.org');
  assert.equal(tx('Respuesta que no es JSON en api.example.es'), 'Non-JSON response from api.example.es');
  assert.equal(tx('Redirección de https a http en a.es: no se sigue'), 'Redirect from https to http at a.es: not followed');
  assert.equal(tx('Redirección de a.es a otro origen (b.es): no se sigue'), 'Redirect from a.es to another origin (b.es): not followed');
});

test('lo que publican las fuentes sale tal cual, aunque se parezca a una plantilla nuestra', () => {
  const theirs = [
    'Aviso naranja por tormentas · Litoral norte de Valencia', // AEMET: sin alterar
    'Se esperan rachas de viento de 80 km/h. Vigente hasta mañana.',
    'Rodalies · R1, R2 Nord',
    'Línea C3. Tren con salida prevista a las 17:13h de la estación de Gandia con destino València Nord, hoy no circula.',
    'El tren 12345 circula con 20 min de retraso',
    'Servicio cancelado',
    'La línea 5 no para en Plaza Mayor por obras',
    'Línea 5 no para en Plaza de España',
    'Metro de Sevilla cancelado',
    'Línea C3. Servicio con 15 min de retraso',
    'Por obras, los trenes de la línea C5 no paran en Atocha',
    'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma',
    'PROCICAT · ALERTA',
    'TUSSAM · Desvío de la línea 27 por obras',
    'Orange earthquake alert (Magnitude 6.1M, Depth:10km) in Morocco',
    'Desvío línea 7: Línea 7 desviada entre las paradas A y B.',
  ];
  for (const s of theirs) assert.equal(tx(s), s);
});

test('cada patrón tiene su ejemplo en este test y ninguno usa la bandera g (tx() usa test() y luego replace())', () => {
  for (const [re] of PATTERNS) assert.ok(!re.flags.includes('g'), String(re));
  assert.ok(Object.keys(EXACT).length > 0);
});
