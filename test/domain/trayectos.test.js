// «Mi trayecto» del bot: lo que se escribe («Alcalá de Henares > Atocha 7:00-9:00 L-V»), qué estaciones son, qué
// trenes encajan (paran en el origen y luego en el destino y salen del origen en la franja, uno de esos días) y qué
// se avisa y se cuenta de ellos. Con un tren de Cercanías sin hora en sus paradas (se calcula por dónde va), uno de
// larga distancia con horario y cancelaciones como las de Renfe. Reloj fijo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberedServiceKey, lineKey, trayectoKey } from '../../server/domain/seguir.js';
import { sameNetwork, searchStations, stationLabel } from '../../server/domain/seguidos/estaciones.js';
import {
  ESTIMATE_KMH, collectTrayectoFacts, legOf, looksLikeTrayecto, parseDays, parseTrayectoText, passIndex, trayectoErrorText, trayectoName,
  trayectoOptions, trayectoStations, trayectoStatus, vehicleDeparture, weekday,
} from '../../server/domain/seguidos/trayectos.js';
import { distanceKm } from '../../server/domain/geo.js';

const NOW = Date.parse('2026-11-10T05:30:00Z'); // martes, 06:30 en Madrid
const MIN = 60_000;

const ST = {
  gu: { code: '70200', name: 'Guadalajara', place: 'Guadalajara', lat: 40.6447, lon: -3.1824 },
  az: { code: '70112', name: 'Azuqueca', place: 'Azuqueca De Henares', lat: 40.565, lon: -3.265 },
  al: { code: '70103', name: 'Alcalá de Henares', place: 'Alcalá De Henares', lat: 40.48908, lon: -3.36625 },
  au: { code: '70107', name: 'Alcalá de Henares-Universidad', place: 'Alcalá De Henares', lat: 40.5045, lon: -3.3433 },
  to: { code: '70100', name: 'Torrejón de Ardoz', place: 'Torrejón De Ardoz', lat: 40.4559, lon: -3.4797 },
  at: { code: '18000', name: 'Madrid-Atocha Cercanías', place: 'Madrid', lat: 40.40636, lon: -3.68962 },
  pa: { code: '60000', name: 'Madrid-Puerta de Atocha-Almudena Grandes', place: 'Madrid', lat: 40.40644, lon: -3.69089 },
  sants: { code: '71801', name: 'Barcelona-Sants', place: 'Barcelona', lat: 41.3792, lon: 2.1402 },
  tmbSants: { code: 'tmb:P.6660319', name: 'Sants Estació', place: null, lat: 41.3797, lon: 2.1408, network: 'Metro de Barcelona (TMB)', networkId: 'tmb', mode: 'metro' },
  tmbPlaca: { code: 'tmb:P.6660120', name: 'Plaça de Sants', place: null, lat: 41.3757, lon: 2.1355, network: 'Metro de Barcelona (TMB)', networkId: 'tmb', mode: 'metro' },
};
const CATALOG = Object.values(ST);
const byCode = new Map(CATALOG.map((s) => [s.code, s]));
const stationOf = (code) => byCode.get(code) ?? null;
const creditOf = (source) => (source?.startsWith('renfe') ? 'Origen de los datos: Renfe Operadora' : null);
const stop = (st, extra = {}) => ({ name: st.name, lat: st.lat, lon: st.lon, ...extra });

const KEY = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 6 * 60, to: 9 * 60, days: 0x1f }); // L-V, 06:00-09:00
const C2 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C2' });

/** Un Cercanías de Guadalajara a Atocha, sin hora en sus paradas (como los de Renfe), entre Guadalajara y Azuqueca. */
const cercanias = (over = {}) => ({
  id: 'renfe-c:1013M21520C2', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C2', label: '21520',
  follow: [numberedServiceKey({ operator: 'Renfe', number: '21520' }), C2], lat: 40.6, lon: -3.22, delay: 16, next: 'Azuqueca', stops: true, ...over,
});
const cercaniasStops = () => [stop(ST.gu, { passed: true }), stop(ST.az), stop(ST.al), stop(ST.to), stop(ST.at)].map((s) => ({ time: null, eta: null, passed: false, ...s }));
/** Un Media Distancia con horario que pasa por Alcalá a las 07:10 y llega a Atocha a las 07:40. */
const md = (over = {}) => ({
  id: 'renfe-ld:18001', source: 'renfe-ld', mode: 'md', operator: 'Renfe', service: 'Media Distancia', line: 'Media Distancia', label: '18001',
  follow: [numberedServiceKey({ operator: 'Renfe', number: '18001' }), lineKey({ operator: 'Renfe', line: 'Media Distancia' })],
  lat: 40.7, lon: -3.0, delay: 31, next: 'Guadalajara', stops: true, ...over,
});
const mdStops = () => [
  stop(ST.gu, { time: '06:50', eta: '07:21', passed: false }), stop(ST.al, { time: '07:10', eta: '07:41', passed: false }), stop(ST.at, { time: '07:40', eta: '08:11', passed: false }),
];

/** Una cancelación de Renfe: el tren y sus paradas con la hora del horario. */
const cancel = (id, number, times, over = {}) => ({
  id, source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', title: `Cercanías C2 ${number} cancelado: Guadalajara ${times[0]} → Madrid-Atocha Cercanías`,
  credit: 'Origen de los datos: Renfe Operadora',
  trip: {
    operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C2', number, date: null, follow: [numberedServiceKey({ operator: 'Renfe', number }), C2],
    stops: [stop(ST.gu, { time: times[0] }), stop(ST.al, { time: times[1] }), stop(ST.at, { time: times[2] })],
  },
  ...over,
});

test('lo que se escribe: estaciones, franja y días, en varias formas; y qué falta si no se entiende', () => {
  assert.deepEqual(parseTrayectoText('Alcalá de Henares > Atocha 7:00-9:00 L-V'), { origin: 'Alcalá de Henares', destination: 'Atocha', from: 420, to: 540, days: 0x1f });
  assert.deepEqual(parseTrayectoText('Alcalá → Atocha de 7 a 9:30 de lunes a viernes'), { origin: 'Alcalá', destination: 'Atocha', from: 420, to: 570, days: 0x1f });
  assert.deepEqual(parseTrayectoText('Alcalá -> Atocha L-V 07.15-08.45'), { origin: 'Alcalá', destination: 'Atocha', from: 435, to: 525, days: 0x1f }, 'los días antes de la franja');
  assert.deepEqual(parseTrayectoText('Sants > Plaça de Catalunya entre las 18 y las 20h'), { origin: 'Sants', destination: 'Plaça de Catalunya', from: 1080, to: 1200, days: 0x7f },
    'sin días, todos');
  assert.deepEqual(parseTrayectoText('Aeroport T1 > Sants 22-24 S-D'), { origin: 'Aeroport T1', destination: 'Sants', from: 1320, to: 1439, days: 0x60 },
    'una cifra en el nombre no es la franja; «24» es el final del día');
  for (const [text, error] of [
    ['Alcalá Atocha 7-9', 'flecha'], ['Alcalá > Atocha', 'franja'], ['> Atocha 7-9', 'estaciones'], ['Alcalá > 7-9', 'estaciones'],
    ['Alcalá > Atocha 9-7', 'horas'], ['Alcalá > Atocha 7-25', 'horas'], ['Alcalá > Atocha 7:75-9', 'horas'], ['Alcalá > Atocha 7-9 los martes no', 'dias'],
    ['A > B > C 7-9', 'flecha'],
  ]) assert.equal(parseTrayectoText(text).error, error, text);
  assert.equal(looksLikeTrayecto('Alcalá > Atocha'), true);
  assert.equal(looksLikeTrayecto('C4 Madrid'), false);
  assert.match(trayectoErrorText(parseTrayectoText('Alcalá > Atocha 7-9 cuando sea')), /^No entiendo los días «cuando sea»/);
  assert.match(trayectoErrorText({ error: 'franja' }), /\/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V/);
});

test('los días: rangos (también de viernes a lunes), listas, letras juntas y palabras', () => {
  for (const [text, mask] of [
    ['L-V', 0x1f], ['l - v', 0x1f], ['de lunes a viernes', 0x1f], ['laborables', 0x1f], ['entre semana', 0x1f], ['S-D', 0x60], ['fin de semana', 0x60],
    ['sábados y domingos', 0x60], ['L,X,V', 0x15], ['LXV', 0x15], ['V-L', 0x71], ['lunes', 0x01], ['todos', 0x7f], ['', 0x7f], ['mi', 0x04],
  ]) assert.equal(parseDays(text), mask, text);
  for (const text of ['pepe', 'L-', 'lunes-pepe', 'a']) assert.equal(parseDays(text), null, text);
  assert.equal(weekday('2026-11-10'), 1, 'martes');
  assert.equal(weekday('2026-11-15'), 6, 'domingo');
});

test('estaciones del catálogo: tal cual si se llama así; si no, todas las que encajan, primero las de Renfe', () => {
  assert.deepEqual(searchStations(CATALOG, 'alcala de henares').map((s) => s.code), [ST.al.code], 'tal cual: sólo esa, no la de Universidad');
  assert.deepEqual(searchStations(CATALOG, 'Alcalá').map((s) => s.code), [ST.al.code, ST.au.code]);
  assert.deepEqual(searchStations(CATALOG, 'Atocha').map((s) => s.code), [ST.at.code, ST.pa.code]);
  assert.deepEqual(searchStations(CATALOG, 'Atocha Madrid').map((s) => s.code), [ST.at.code, ST.pa.code], 'también por su ciudad');
  assert.deepEqual(searchStations(CATALOG, 'Sants metro').map((s) => s.code).sort(), [ST.tmbPlaca.code, ST.tmbSants.code].sort(), 'y por su red');
  assert.deepEqual(searchStations(CATALOG, 'Valladolid'), []);
  assert.deepEqual(searchStations(CATALOG, ''), []);
  assert.equal(stationLabel(ST.tmbSants), 'Sants Estació · Metro de Barcelona (TMB)');
  assert.equal(stationLabel(ST.al), 'Alcalá de Henares', 'su ciudad ya está en el nombre');
  assert.equal(sameNetwork(ST.al, ST.at), true);
  assert.equal(sameNetwork(ST.sants, ST.tmbSants), false);
});

test('qué trayectos son: uno, varios (dos Atocha) o ninguno; con su clave y su nombre', () => {
  const one = trayectoOptions(CATALOG, parseTrayectoText('Alcalá de Henares > Madrid-Atocha Cercanías 6-9 L-V'));
  assert.deepEqual(one, { pairs: [{ key: KEY, name: 'Alcalá de Henares → Madrid-Atocha Cercanías (06:00-09:00, de lunes a viernes)', label: 'Alcalá de Henares → Madrid-Atocha Cercanías' }], total: 1 });
  const two = trayectoOptions(CATALOG, parseTrayectoText('Alcalá de Henares > Atocha 6-9 L-V'));
  assert.equal(two.total, 2);
  assert.deepEqual(two.pairs.map((p) => p.label), ['Alcalá de Henares → Madrid-Atocha Cercanías', 'Alcalá de Henares → Madrid-Puerta de Atocha-Almudena Grandes']);
  assert.equal(trayectoOptions(CATALOG, parseTrayectoText('Alcalá > Atocha 6-9'), { limit: 3 }).pairs.length, 3, 'cuatro posibles, tres en la lista');
  assert.deepEqual(trayectoOptions(CATALOG, parseTrayectoText('Sants > Sants Estació 6-9')).pairs.map((p) => p.label), ['Plaça de Sants → Sants Estació · Metro de Barcelona (TMB)'],
    'sólo de la misma red y distintas');
  assert.deepEqual(trayectoOptions(CATALOG, parseTrayectoText('Narnia > Atocha 6-9')), { error: 'origen', text: 'Narnia' });
  assert.deepEqual(trayectoOptions(CATALOG, parseTrayectoText('Atocha > Narnia 6-9')), { error: 'destino', text: 'Narnia' });
  assert.deepEqual(trayectoOptions(CATALOG, parseTrayectoText('Guadalajara > Guadalajara 6-9')), { error: 'misma' });
  const red = trayectoOptions(CATALOG, parseTrayectoText('Alcalá de Henares > Plaça de Sants 6-9'));
  assert.equal(red.error, 'red');
  assert.equal(trayectoErrorText(red), 'Alcalá de Henares y Plaça de Sants · Metro de Barcelona (TMB) no son de la misma red: ningún tren para en las dos.');
  assert.equal(trayectoName(KEY, stationOf), 'Alcalá de Henares → Madrid-Atocha Cercanías (06:00-09:00, de lunes a viernes)');
  assert.equal(trayectoStations(KEY, () => null), null, 'una estación que ya no está en el catálogo');
});

test('cuándo pasa un tren por el origen: su horario; si no, lo previsto menos el retraso; si no, por dónde va', () => {
  const stops = mdStops();
  assert.deepEqual(vehicleDeparture(md(), stops, 1, NOW), { day: '2026-11-10', min: 7 * 60 + 10, estimated: false });
  const noTimes = stops.map((s) => ({ ...s, time: null }));
  assert.deepEqual(vehicleDeparture(md(), noTimes, 1, NOW), { day: '2026-11-10', min: 7 * 60 + 10, estimated: true }, '07:41 previsto con 31 min de retraso');
  // Cercanías: sin hora; le faltan unos 17 km hasta Alcalá (por Azuqueca) a ESTIMATE_KMH, menos sus 16 min de retraso.
  const v = cercanias();
  const km = distanceKm(v.lat, v.lon, ST.az.lat, ST.az.lon) + distanceKm(ST.az.lat, ST.az.lon, ST.al.lat, ST.al.lon);
  const dep = vehicleDeparture(v, cercaniasStops(), 2, NOW);
  assert.equal(dep.estimated, true);
  assert.equal(dep.min, 6 * 60 + 30 + Math.floor((km / ESTIMATE_KMH) * 60) - 16);
  // Ya ha pasado por Alcalá: lo recorrido desde entonces, hacia atrás.
  const after = cercaniasStops().map((s, i) => ({ ...s, passed: i <= 2 }));
  const back = vehicleDeparture(cercanias({ lat: 40.47, lon: -3.43, delay: 0 }), after, 2, NOW);
  assert.ok(back.min < 6 * 60 + 30 && back.min > 6 * 60 + 15, String(back.min));
  assert.equal(vehicleDeparture(cercanias({ lat: null }), cercaniasStops(), 2, NOW), null, 'sin posición, no se sabe');
  assert.deepEqual(legOf(cercaniasStops(), ST.al, ST.at), { o: 2, d: 4 });
  assert.equal(legOf(cercaniasStops(), ST.at, ST.al), null, 'al revés no es este trayecto');
});

test('avisos: cancelados y sin parar en el origen o el destino, sin datos y retraso por escalones; sólo los de la franja y de sus días', () => {
  const events = [
    cancel('c-dentro', '21516', ['07:20', '07:37', '08:10']),
    cancel('c-fuera', '21530', ['09:00', '09:17', '09:50']), // sale de Alcalá a las 09:17: fuera de la franja
    cancel('c-otro-dia', '21532', ['07:00', '07:17', '07:50'], { trip: { ...cancel('x', '21532', ['07:00', '07:17', '07:50']).trip, date: '20261114' } }), // sábado
    cancel('c-retirada', '21518', ['07:30', '07:47', '08:20'], { withdrawn: NOW - MIN }),
    // Al revés (de Atocha a Guadalajara): no es este trayecto.
    { ...cancel('c-reves', '21601', ['07:00', '07:20', '07:50']), trip: { ...cancel('x', '21601', ['07:00', '07:20', '07:50']).trip, stops: [stop(ST.at, { time: '07:00' }), stop(ST.al, { time: '07:20' }), stop(ST.gu, { time: '07:50' })] } },
    // Paradas suprimidas: la de Alcalá (avisa) y otra que no es del trayecto (no).
    { ...cancel('p-alcala', '21540', ['07:40', '07:57', '08:30']), type: 'parcial', title: 'Cercanías C2 21540 no para en Alcalá de Henares',
      trip: { ...cancel('x', '21540', ['07:40', '07:57', '08:30']).trip, stops: [stop(ST.gu, { time: '07:40' }), stop(ST.al, { time: '07:57', skipped: true }), stop(ST.at, { time: '08:30' })] } },
    { ...cancel('p-otra', '21542', ['07:45', '08:02', '08:35']), type: 'parcial', title: 'Cercanías C2 21542 no para en Guadalajara',
      trip: { ...cancel('x', '21542', ['07:45', '08:02', '08:35']).trip, stops: [stop(ST.gu, { time: '07:45', skipped: true }), stop(ST.al, { time: '08:02' }), stop(ST.at, { time: '08:35' })] } },
    { ...cancel('p-atocha', '21544', ['07:50', '08:07', '08:40']), type: 'parcial', title: 'Cercanías C2 21544 acaba en Torrejón de Ardoz',
      trip: { ...cancel('x', '21544', ['07:50', '08:07', '08:40']).trip, stops: [stop(ST.gu, { time: '07:50' }), stop(ST.al, { time: '08:07' }), stop(ST.at, { time: '08:40', skipped: true })] } },
    { id: 'renfe-sin-datos:18003', source: 'renfe-avisos', category: 'sin-datos', type: 'sin-datos', title: 'Media Distancia 18003 sin datos de Renfe: Guadalajara 07:30 → Madrid-Atocha Cercanías',
      trip: { operator: 'Renfe', mode: 'md', service: 'Media Distancia', number: '18003', date: '2026-11-10', follow: [numberedServiceKey({ operator: 'Renfe', number: '18003' })],
        stops: [stop(ST.gu, { time: '07:30', passed: true }), stop(ST.al, { time: '07:50', passed: false }), stop(ST.at, { time: '08:20', passed: false })] } },
  ];
  const stopsById = { [md().id]: mdStops(), [cercanias().id]: cercaniasStops() };
  const ctx = { events, vehicles: [md(), cercanias(), md({ id: 'renfe-ld:18009', delay: 3 })], now: NOW, stationOf, creditOf, stopsOf: (id) => stopsById[id] ?? mdStops() };
  const facts = collectTrayectoFacts({ keys: [KEY, 'p-71801'], ...ctx });
  assert.deepEqual([...facts.keys()], [KEY], 'sólo los trayectos');
  const list = facts.get(KEY);
  assert.deepEqual(list.filter((f) => !f.silent).map((f) => f.id).sort(),
    ['c-dentro', 'p-alcala', 'p-atocha', 'renfe-c:1013M21520C2|retraso|0', 'renfe-ld:18001|retraso|1', 'renfe-sin-datos:18003'].sort());
  const text = (id) => list.find((f) => f.id === id).text;
  assert.equal(text('c-dentro'), 'Cercanías C2 21516 cancelado: Guadalajara 07:20 → Madrid-Atocha Cercanías. Pasaba por Alcalá de Henares a las 07:37.');
  assert.equal(text('p-alcala'), 'Cercanías C2 21540 no para en Alcalá de Henares. Pasaba por Alcalá de Henares a las 07:57.', 'sin repetir lo que dice su título');
  assert.equal(text('p-atocha'), 'Cercanías C2 21544 acaba en Torrejón de Ardoz. No para en Madrid-Atocha Cercanías. Pasaba por Alcalá de Henares a las 08:07.');
  assert.match(text('renfe-sin-datos:18003'), /No se sabe si circula: su operador no publica nada de él\. Pasaba por Alcalá de Henares a las 07:50\.$/);
  assert.equal(text('renfe-ld:18001|retraso|1'), 'Media Distancia 18001, el de las 07:10 en Alcalá de Henares, va con 31 min de retraso. Próxima parada: Guadalajara.');
  assert.match(text('renfe-c:1013M21520C2|retraso|0'), /^Cercanías C2 21520, el de las 06:\d\d en Alcalá de Henares \(hora aproximada\), va con 16 min de retraso\./);
  assert.ok(list.some((f) => f.id === 'renfe-ld:18001|retraso|0' && f.silent), 'el escalón de debajo, callado (si mejora, no se avisa)');
  assert.equal(list.find((f) => f.id === 'c-dentro').credit, 'Origen de los datos: Renfe Operadora');
  // Ya ha llegado a Atocha: no se avisa; el sin datos que según su horario ya llegó, tampoco.
  const arrived = { ...ctx, stopsOf: () => mdStops().map((s) => ({ ...s, passed: true })),
    events: events.map((e) => (e.category === 'sin-datos' ? { ...e, trip: { ...e.trip, stops: e.trip.stops.map((s) => ({ ...s, passed: true })) } } : e)) };
  const later = collectTrayectoFacts({ keys: [KEY], ...arrived }).get(KEY).map((f) => f.id);
  assert.ok(!later.some((id) => id.includes('retraso') || id.includes('sin-datos')), later.join());
  // A las 08:20 ya no se avisa del cancelado que salía de Alcalá a las 07:37 y llegaba a Atocha a las 08:10; del que
  // llegaba a las 08:30 (sin parar en Atocha), aún sí.
  const at0820 = Date.parse('2026-11-10T07:20:00Z');
  const afterwards = collectTrayectoFacts({ keys: [KEY], ...ctx, vehicles: [], now: at0820 }).get(KEY).map((f) => f.id);
  assert.ok(!afterwards.includes('c-dentro') && afterwards.includes('p-alcala') && afterwards.includes('p-atocha'), afterwards.join());
  // El sábado (fuera de L-V), nada: ni los que circulan, ni las cancelaciones sin fecha (son de hoy), ni la que tiene
  // la fecha de ese sábado; y el sin datos del martes ya habría llegado.
  const saturday = Date.parse('2026-11-14T05:30:00Z');
  assert.equal(collectTrayectoFacts({ keys: [KEY], ...ctx, now: saturday }).get(KEY), undefined);
  const tuesdayEvent = ctx.events.find((e) => e.category === 'sin-datos');
  assert.equal(collectTrayectoFacts({ keys: [KEY], ...ctx, events: [{ ...tuesdayEvent, trip: { ...tuesdayEvent.trip, date: '2026-11-14' } }], now: saturday }).get(KEY),
    undefined, 'ni uno con la fecha de ese sábado');
});

test('cómo va: los de la franja por su hora en el origen, sin repetir el tren cancelado que circula; y qué se dice si no hay ninguno', () => {
  const vehicles = [md(), cercanias(), cercanias({ id: 'renfe-c:otro', follow: [numberedServiceKey({ operator: 'Renfe', number: '21516' }), C2], delay: 2 })];
  const stopsOf = (id) => (id === md().id ? mdStops() : cercaniasStops());
  const events = [cancel('c-dentro', '21516', ['07:20', '07:37', '08:10']), cancel('c-ya', '21500', ['05:40', '05:57', '06:30']),
    cancel('c-retirada', '21518', ['07:30', '07:47', '08:20'], { withdrawn: NOW - MIN })];
  const index = passIndex(vehicles, stopsOf);
  const { lines, credits } = trayectoStatus(KEY, { vehicles, events, now: NOW, stationOf, creditOf, stopsOf, index });
  assert.equal(lines[0], 'Trenes de tu franja que se ven ahora (hora en Alcalá de Henares):');
  assert.match(lines[1], /^- 06:\d\d \(aprox\.\) Cercanías C2 21520: circula con 16 min de retraso\. Próxima parada: Azuqueca\.$/);
  assert.equal(lines[2], '- 07:10 Media Distancia 18001: circula con 31 min de retraso. Próxima parada: Guadalajara.');
  assert.equal(lines[3], '- 07:37 Cercanías C2 21516: cancelado.', 'el que circula con el número de un cancelado, una vez y como cancelado');
  assert.equal(lines[4], 'Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule.');
  assert.equal(lines.length, 5, 'el de las 05:57 ya no es de los próximos');
  assert.deepEqual(credits, ['Origen de los datos: Renfe Operadora']);
  // Sin trenes: hoy no es uno de sus días, o no se ve ninguno aún.
  const sunday = Date.parse('2026-11-15T07:00:00Z');
  assert.deepEqual(trayectoStatus(KEY, { now: sunday, stationOf }).lines, ['Hoy no es uno de tus días: te aviso de lunes a viernes.']);
  assert.match(trayectoStatus(KEY, { now: NOW, stationOf }).lines[0], /^Ahora no se ve ningún tren de tu franja de Alcalá de Henares a Madrid-Atocha Cercanías\./);
  assert.deepEqual(trayectoStatus(KEY, { now: NOW, stationOf: () => null }).lines, ['Alguna de las estaciones de este trayecto ya no está en el catálogo del radar.']);
});

test('por dónde pasan: sólo los vehículos que dicen sus paradas y no van por carretera', () => {
  const asked = [];
  const stopsOf = (id) => {
    asked.push(id);
    return cercaniasStops();
  };
  const index = passIndex([cercanias(), cercanias({ id: 'sin-paradas', stops: undefined }), cercanias({ id: 'bus', mode: 'bus' })], stopsOf);
  assert.deepEqual(asked, [cercanias().id], 'ni se piden las paradas de los demás');
  assert.equal(index.get('alcala de henares').length, 1);
});

test('varios trayectos del mismo par de estaciones: lo de las dos se busca una vez, y cada uno sólo lo de su franja y sus días', () => {
  const early = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 7 * 60, to: 7 * 60 + 40, days: 0x1f });
  const late = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 7 * 60 + 41, to: 9 * 60, days: 0x02 }); // sólo martes
  const weekend = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 6 * 60, to: 9 * 60, days: 0x60 });
  const events = [cancel('a', '21516', ['07:20', '07:37', '08:10']), cancel('b', '21540', ['07:40', '07:57', '08:30'])];
  const facts = collectTrayectoFacts({ keys: [early, late, weekend, KEY], events, now: NOW, stationOf, creditOf, stopsOf: () => null });
  assert.deepEqual(facts.get(early).map((f) => f.id), ['a']);
  assert.deepEqual(facts.get(late).map((f) => f.id), ['b']);
  assert.equal(facts.get(weekend), undefined);
  assert.deepEqual(facts.get(KEY).map((f) => f.id), ['a', 'b']);
  assert.equal(facts.get(KEY)[0].text, facts.get(early)[0].text, 'el mismo texto');
  // Otra hora con la misma lista: se vuelve a mirar (a las 08:20 el de las 07:37 ya habría llegado a Atocha).
  const at0820 = Date.parse('2026-11-10T07:20:00Z');
  assert.deepEqual(collectTrayectoFacts({ keys: [KEY], events, now: at0820, stationOf, stopsOf: () => null }).get(KEY).map((f) => f.id), ['b']);
});

test('un tren de pasada la medianoche con la fecha de su día de servicio (24:30 en su horario, 00:30 en sus paradas): es del día siguiente', () => {
  const night = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 0, to: 119, days: 0x7f });
  const now = Date.parse('2026-11-09T23:20:00Z'); // martes 10-nov, 00:20 en Madrid
  const ev = (date, times = ['23:55', '00:30', '01:00']) => ({
    ...cancel('noche', '29999', times), trip: { ...cancel('x', '29999', times).trip, date },
  });
  for (const date of ['2026-11-09', null]) {
    const facts = collectTrayectoFacts({ keys: [night], events: [ev(date)], now, stationOf, stopsOf: () => null });
    assert.deepEqual(facts.get(night)?.map((f) => f.id), ['noche'], `fecha ${date}: antes, con la fecha, quedaba 24 h antes y no se avisaba`);
    assert.equal(trayectoStatus(night, { events: [ev(date)], now, stationOf }).lines[1], '- 00:30 Cercanías C2 29999: cancelado.');
  }
  // Un tren que sale después de medianoche en su día de servicio (sin pasar por ella): ese mismo día.
  const today = collectTrayectoFacts({ keys: [night], events: [ev('2026-11-10', ['00:10', '00:30', '01:00'])], now, stationOf, stopsOf: () => null });
  assert.deepEqual(today.get(night)?.map((f) => f.id), ['noche']);
  assert.equal(collectTrayectoFacts({ keys: [night], events: [ev('2026-11-09', ['00:10', '00:30', '01:00'])], now, stationOf, stopsOf: () => null }).get(night),
    undefined, 'el del día anterior (sin pasar la medianoche) ya pasó');
});
