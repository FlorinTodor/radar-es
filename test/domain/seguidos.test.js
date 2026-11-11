// Lo que sigue cada chat del bot: el directorio y la búsqueda («08058», «C4 Madrid», «27 EMT Málaga»), los hechos
// de cada cosa seguida (cancelaciones, retrasos, sin datos, avisos, provincias), cuáles son nuevos y sus textos.
// Con vehículos de varios tipos: nada depende de que sea un tren de Renfe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineKey, numberedServiceKey, scheduledServiceKey, stopKey } from '../../server/domain/seguir.js';
import { entryLabel, guessedName, knownNames, searchDirectory, updateDirectory } from '../../server/domain/seguidos/directorio.js';
import {
  DELAY_MIN, MESSAGE_MAX, collectFacts, factsMessages, fitMessage, joinCredits, madridDay, madridHourMinute, newFacts, newFactsOf, packBlocks, provinceSub, statusOf,
  capSeen, stopAt, trackFacts, tripsAt,
} from '../../server/domain/seguidos/avisos.js';
import { parseCommand, parseHour, smallTalk } from '../../server/domain/seguidos/ordenes.js';
import { cutText, sourceText } from '../../server/domain/seguidos/texto.js';

const NOW = Date.parse('2026-11-10T11:00:00Z'); // 12:00 en Madrid
const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const C4A = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' });
const C4B = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4b' });
const C1VLC = lineKey({ operator: 'Renfe', scope: 'Valencia', line: 'C1' });
const EMT27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const E4 = scheduledServiceKey({ operator: 'Euskotren', line: 'E4', origin: 'stop-matiko', departure: 13 * 3600 + 10 * 60 });
const E4LINE = lineKey({ operator: 'Euskotren', line: 'E4' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });

const credits = { 'renfe-ld': 'Origen de los datos: Renfe Operadora', 'emt-malaga': 'EMT Málaga', 'aemet-avisos': '© AEMET', 'euskotren': 'Euskotren' };
const creditOf = (source) => credits[source] ?? null;

const vehicles = [
  { id: 'renfe-ld:08058', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058', delay: 22,
    origin: 'Valladolid-Campo Grande', destination: 'Madrid-Chamartín-Clara Campoamor', next: 'Segovia-Guiomar', follow: [AVANT, AVANT_LINE] },
  { id: 'renfe-c:1013M27100C4a', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C4a', label: '27100',
    delay: 3, origin: 'Alcobendas-San Sebastián de los Reyes', destination: 'Parla', follow: [numberedServiceKey({ operator: 'Renfe', number: '27100' }), C4A] },
  { id: 'renfe-c:1013M27200C4b', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C4b', label: '27200',
    delay: 8, origin: 'Colmenar Viejo', destination: 'Parla', follow: [numberedServiceKey({ operator: 'Renfe', number: '27200' }), C4B] },
  { id: 'renfe-c:4013M35401C1', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C1', label: '35401',
    delay: 0, origin: 'València-Estació del Nord', destination: 'Gandia', follow: [numberedServiceKey({ operator: 'Renfe', number: '35401' }), C1VLC] },
  { id: 'emt-malaga:661', source: 'emt-malaga', mode: 'bus', operator: 'EMT Málaga', line: '27', label: '661', delay: null, follow: [EMT27] },
  { id: 'euskotren:J1', source: 'euskotren', mode: 'cercanias', operator: 'Euskotren', service: 'Euskotren', line: 'E4', label: null, delay: 16,
    origin: 'Matiko-Bilbao', destination: 'Bermeo', follow: [E4, E4LINE] },
];
const cancelled = {
  id: 'renfe-cancelado:ld:08058', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', severity: 'alta',
  title: 'Avant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor', credit: 'Origen de los datos: Renfe Operadora',
  trip: { operator: 'Renfe', mode: 'av', service: 'Avant', number: '08058', origin: 'Valladolid-Campo Grande', destination: 'Madrid-Chamartín-Clara Campoamor',
    follow: [AVANT, AVANT_LINE], stops: [{ name: 'Valladolid-Campo Grande', time: '06:23', lat: 41.64, lon: -4.73 }, { name: 'Madrid-Chamartín-Clara Campoamor', time: '07:24' }] },
};
const c4Cancelled = {
  id: 'renfe-cancelado:1012L27314C4a', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', title: 'Cercanías C4a 27314 cancelado: Parla 07:00 → Alcobendas',
  credit: 'Origen de los datos: Renfe Operadora', trip: { operator: 'Renfe', mode: 'cercanias', line: 'C4a', number: '27314', follow: [numberedServiceKey({ operator: 'Renfe', number: '27314' }), C4A], stops: [] },
};
const notice = { id: 'renfe-aviso:1', source: 'renfe-avisos', category: 'ferroviario', type: 'aviso', title: 'Aviso Renfe · C4a, C4b',
  description: 'Por huelga de maquinistas circulan los servicios mínimos.', follow: [C4A, C4B] };
const orange = { id: 'aemet:1', source: 'aemet-avisos', category: 'meteo', type: 'lluvias', level: 'naranja', title: 'Aviso naranja por lluvias · Litoral sur de Valencia',
  lat: 39.0, lon: -0.2, issued: NOW - 3600_000, start: NOW, end: NOW + 6 * 3600_000 };

test('directorio: lo que se puede seguir de cada vehículo y de cada cancelación, con su nombre; y se olvida lo viejo', () => {
  const dir = updateDirectory(new Map(), { vehicles, events: [cancelled], now: NOW });
  assert.equal(dir.get(AVANT).name, 'Avant 08058');
  assert.equal(dir.get(AVANT_LINE).name, 'Avant · Renfe', 'el producto de AV/LD/MD no se repite');
  assert.equal(dir.get(C4A).name, 'Cercanías C4a · Renfe (Madrid)', 'con su núcleo');
  assert.equal(dir.get(EMT27).name, 'Autobús 27 · EMT Málaga');
  assert.equal(dir.get(E4).name, 'Tren E4 · Euskotren, el de las 13:10, desde Matiko-Bilbao');
  assert.equal(entryLabel(dir.get(C4B)), 'Cercanías C4b · Renfe (Madrid) (Colmenar Viejo – Parla)');
  updateDirectory(dir, { vehicles: [], now: NOW + 37 * 3600_000 });
  assert.equal(dir.size, 0);
});

test('búsqueda: por número (con o sin ceros), por línea y ciudad u operador, por hora; y nada si no encaja', () => {
  const dir = updateDirectory(new Map(), { vehicles, events: [cancelled], now: NOW });
  assert.deepEqual(searchDirectory(dir, '08058').map((e) => e.key), [AVANT]);
  assert.deepEqual(searchDirectory(dir, '8058').map((e) => e.key), [AVANT]);
  assert.deepEqual(searchDirectory(dir, 'C4 Madrid').map((e) => e.key), [C4A, C4B], 'por el núcleo de su clave, aunque ninguno empiece ni acabe en Madrid');
  assert.deepEqual(searchDirectory(dir, 'C4 Parla').map((e) => e.key).sort(), [C4A, C4B].sort(), 'C4 → C4a y C4b, sin cada tren');
  assert.deepEqual(searchDirectory(dir, '27100').map((e) => e.key), [numberedServiceKey({ operator: 'Renfe', number: '27100' })]);
  assert.deepEqual(searchDirectory(dir, 'C1 valencia').map((e) => e.key), [C1VLC], 'sin tildes: València');
  assert.deepEqual(searchDirectory(dir, '27 EMT Málaga').map((e) => e.key), [EMT27]);
  assert.deepEqual(searchDirectory(dir, 'E4 13:10').map((e) => e.key), [E4]);
  assert.deepEqual(searchDirectory(dir, 'tranvía de la luna'), []);
  assert.deepEqual(searchDirectory(dir, ''), []);
});

test('hechos: cancelación, retraso desde el umbral (y por escalones), aviso de su línea, parada y provincia; no los retirados', () => {
  const events = [cancelled, c4Cancelled, notice, orange, { ...c4Cancelled, id: 'retirada', withdrawn: NOW - 60_000 }];
  const station = { name: 'Valladolid-Campo Grande', lat: 41.64, lon: -4.73 };
  const facts = collectFacts({
    keys: [AVANT, C4A, EMT27, E4, stopKey('10600')], provinces: ['valencia'], vehicles, events, now: NOW, creditOf,
    stationOf: (code) => (code === '10600' ? station : null),
  });
  assert.deepEqual(facts.get(AVANT).map((f) => [f.kind, f.id]), [['cancelado', cancelled.id], ['retraso', 'renfe-ld:08058|retraso|0']]);
  assert.equal(facts.get(AVANT)[1].text, 'Avant 08058 va con 22 min de retraso (de Valladolid-Campo Grande a Madrid-Chamartín-Clara Campoamor). Próxima parada: Segovia-Guiomar.');
  assert.equal(facts.get(AVANT)[1].credit, 'Origen de los datos: Renfe Operadora');
  assert.deepEqual(facts.get(C4A).map((f) => f.kind), ['cancelado', 'aviso'], 'en una línea: sus cancelaciones y los avisos; no los retrasos de cada tren');
  assert.equal(facts.get(EMT27), undefined, 'un autobús sin retraso publicado: nada');
  assert.deepEqual(facts.get(E4).map((f) => f.kind), ['retraso'], 'un servicio de un horario, como un tren con número');
  assert.match(facts.get(stopKey('10600'))[0].text, /Por esta estación pasaba a las 06:23/);
  assert.deepEqual(facts.get(provinceSub('valencia')).map((f) => f.kind), ['meteo']);
  assert.match(facts.get(provinceSub('valencia'))[0].text, /^Aviso naranja por lluvias · Litoral sur de Valencia, desde .* hasta .*\. Emitido el /);
  const worse = collectFacts({ keys: [AVANT], vehicles: [{ ...vehicles[0], delay: 31 }], now: NOW });
  assert.deepEqual(worse.get(AVANT).filter((f) => !f.silent).map((f) => f.id), ['renfe-ld:08058|retraso|1'], `+${DELAY_MIN} min más: otro aviso`);
  assert.deepEqual(worse.get(AVANT).filter((f) => f.silent).map((f) => f.id), ['renfe-ld:08058|retraso|0'], 'el escalón de debajo, callado');
});

test('nuevos: sólo lo que sale después de la última vez; lo que ya estaba al seguirlo, no; y lo que vuelve tras horas, otra vez', () => {
  const sub = AVANT;
  let seen = trackFacts(new Map(), collectFacts({ keys: [sub], vehicles, events: [cancelled], now: NOW }), NOW);
  const checkedAt = NOW; // se empezó a seguir ahora: lo que ya había no se avisa
  const later = NOW + 60_000;
  const more = { ...cancelled, id: 'renfe-cancelado:otra', title: 'Avant 08058 no llega a Madrid: termina en Segovia', type: 'parcial' };
  const facts = collectFacts({ keys: [sub], vehicles, events: [cancelled, more], now: later });
  seen = trackFacts(seen, facts, later);
  assert.deepEqual(newFacts(sub, facts.get(sub), seen, checkedAt).map((f) => f.id), ['renfe-cancelado:otra']);
  assert.deepEqual(newFacts(sub, facts.get(sub), seen, later), [], 'en la ronda siguiente ya no es nuevo');
  // Pasa la noche: el retraso de ayer se olvida y el de hoy es nuevo.
  const tomorrow = NOW + 24 * 3600_000;
  const today = collectFacts({ keys: [sub], vehicles, events: [], now: tomorrow });
  seen = trackFacts(seen, today, tomorrow);
  assert.equal(seen.get(`${sub}|renfe-ld:08058|retraso|0`).first, tomorrow);
});

test('tope de lo recordado: lo visto en la ronda nunca se olvida por el tope (ni se pierde ni se repite); lo viejo, primero', () => {
  // 30 suscripciones con el mismo hecho y un tope de 10: antes se borraban 20 de la ronda (unos avisos se perdían y
  // otros se repetían cada minuto).
  const facts = new Map(Array.from({ length: 30 }, (_, i) => [`t-${i}`, [{ id: 'renfe-c:cancel:1', kind: 'cancelado', text: 'x' }]]));
  const old = new Map([['t-viejo|renfe-c:cancel:0', { first: NOW - 120_000, last: NOW - 60_000 }]]);
  const first = trackFacts(old, facts, NOW, { max: 10 });
  assert.equal(first.size, 30, 'crece por encima del tope con lo de la ronda');
  assert.ok(!first.has('t-viejo|renfe-c:cancel:0'), 'lo que ya no se ve sale antes');
  for (const [sub, list] of facts) assert.equal(newFacts(sub, list, first, NOW - 60_000).length, 1, `${sub}: nuevo en la primera ronda`);
  const second = trackFacts(first, facts, NOW + 60_000, { max: 10 });
  for (const [sub, list] of facts) assert.deepEqual(newFacts(sub, list, second, NOW), [], `${sub}: en la siguiente ya no es nuevo`);
  // La válvula: si lo de la ronda pasa de hardMax, se recorta (para no comerse la memoria).
  assert.equal(trackFacts(first, facts, NOW + 60_000, { max: 10, hardMax: 25 }).size, 25);
  // Al cargar lo guardado: lo de la última ronda guardada se queda entero; lo de antes, hasta el tope.
  const saved = new Map([...second, ['t-viejo|a', { first: 1, last: 2 }]]);
  assert.equal(capSeen(saved, { max: 10, keepFrom: NOW + 60_000 }).size, 30);
});

test('mensaje: título, lo que pasa (como mucho 8 y cuántos más), fuentes sin repetir y la web', () => {
  const [one, ...none] = factsMessages('Avant 08058', [{ id: 'a', text: 'Va con 22 min de retraso.', credit: 'Renfe' }], { webUrl: 'https://radarespana.es' });
  assert.equal(one, 'Avant 08058:\n\nVa con 22 min de retraso.\n\nRenfe\n\nMás en https://radarespana.es');
  assert.deepEqual(none, []);
  const [many] = factsMessages('Tren C4a', Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `T${i}`, credit: 'Renfe' })), { webUrl: 'https://x.es' });
  assert.match(many, /^Tren C4a:\n\n- T0\n- T1\n.*- T7\n…y 2 más\.\n\nRenfe\n\nMás en https:\/\/x\.es$/s);
});

test('mensaje largo: en varios, cada uno con las atribuciones de lo que lleva y la web; los textos de las fuentes, enteros', () => {
  // Seis avisos de Renfe de ~620 caracteres (review/s1): antes, uno de 3.800 cortado, sin la atribución ni la web.
  const notice = (i) => `${'Por obras de mejora en la infraestructura, los trenes circularán con horarios modificados. '.repeat(7)}[FIN ${i}]`;
  const facts = Array.from({ length: 6 }, (_, i) => ({ id: String(i), text: notice(i), credit: i === 5 ? '© AEMET' : 'Origen de los datos: Renfe Operadora' }));
  const out = factsMessages('Cercanías C4', facts, { webUrl: 'https://x.es' });
  assert.equal(out.length, 2);
  out.forEach((m, i) => {
    assert.ok(m.length <= MESSAGE_MAX);
    assert.ok(m.startsWith(`Cercanías C4 (${i + 1}/2):\n\n`), m.slice(0, 30));
    assert.match(m, /\n\nMás en https:\/\/x\.es$/);
  });
  assert.ok(out[0].includes('Origen de los datos: Renfe Operadora') && !out[0].includes('© AEMET'), 'cada atribución, en el mensaje de lo suyo');
  assert.ok(out[1].includes('© AEMET'));
  assert.equal(out[1].includes('Origen de los datos'), /\[FIN [0-4]\]/.test(out[1]), 'la de Renfe, sólo si lleva alguno de Renfe');
  for (let i = 0; i < 6; i++) assert.ok(out.join('').includes(notice(i)), `aviso ${i} entero`);
  // Un aviso que solo no cabe: partido por sus líneas en varios mensajes, cada uno con su atribución; nada se pierde.
  const huge = `${'Línea con texto de la fuente. '.repeat(40)}\n`.repeat(8);
  const parts = factsMessages('X', [{ id: 'a', text: huge, credit: 'Fuente: Renfe' }], { webUrl: 'https://x.es' });
  assert.ok(parts.length >= 3 && parts.every((m) => m.length <= MESSAGE_MAX && m.includes('Fuente: Renfe')));
  const words = (t) => t.split(/\s+/).filter(Boolean);
  const body = parts.map((m) => m.split('\n\n').slice(1, -2).join('\n\n')).join(' ');
  assert.deepEqual(words(body), words(huge), 'las mismas palabras, en el mismo orden');
});

test('estado: un servicio que circula, cancelado o que no se ve; una línea; una provincia', () => {
  const ctx = { vehicles, events: [cancelled, c4Cancelled, notice, orange], now: NOW, creditOf };
  const avant = statusOf(AVANT, ctx);
  assert.equal(avant.lines[0], 'Avant 08058: circula con 22 min de retraso, de Valladolid-Campo Grande a Madrid-Chamartín-Clara Campoamor. Próxima parada: Segovia-Guiomar.');
  assert.match(avant.lines[1], /^Avant 08058 cancelado/);
  assert.deepEqual(statusOf(numberedServiceKey({ operator: 'Renfe', number: '1' }), ctx).lines,
    ['Ahora no se ve circulando: puede que no le toque a esta hora o que su operador no lo publique.']);
  const c4 = statusOf(C4A, ctx).lines;
  assert.equal(c4[0], 'Ahora circula 1 tren; no lleva 5 min o más de retraso.');
  assert.equal(c4[1], 'Cancelados o con paradas suprimidas hoy: 1.');
  assert.match(c4.at(-1), /^Aviso: Aviso Renfe · C4a, C4b: Por huelga/);
  assert.deepEqual(statusOf(EMT27, ctx).lines, ['Ahora circula 1 autobús.'], 'el nombre de los vehículos, del registro de tipos');
  const two = statusOf(EMT27, { ...ctx, vehicles: [...vehicles, { ...vehicles[4], id: 'emt-malaga:662', delay: 9 }, { ...vehicles[4], id: 'x', delay: 1 }] }).lines;
  assert.equal(two[0], 'Ahora circulan 3 autobuses; 1 de los 2 que dicen su retraso llevan 5 min o más.');
  assert.match(statusOf(provinceSub('valencia'), ctx).lines[0], /^Aviso naranja por lluvias/);
  assert.match(statusOf(provinceSub('soria'), ctx).lines[0], /^Ahora no hay avisos naranja o rojo de AEMET/);
});

test('órdenes: con su argumento, con @bot, alias, texto sin orden y horas', () => {
  assert.deepEqual(parseCommand('/seguir C4 Madrid'), { command: 'seguir', arg: 'C4 Madrid' });
  assert.deepEqual(parseCommand('/seguir@RadarEspanaBot   08058 '), { command: 'seguir', arg: '08058' });
  assert.deepEqual(parseCommand('/help'), { command: 'ayuda', arg: '' });
  assert.deepEqual(parseCommand('/start s-renfe-8058'), { command: 'start', arg: 's-renfe-8058' });
  assert.deepEqual(parseCommand('/inventada'), { command: 'desconocida', arg: '' });
  assert.deepEqual(parseCommand('C4 Madrid'), { command: 'buscar', arg: 'C4 Madrid' });
  assert.deepEqual(parseCommand(''), { command: 'ayuda', arg: '' });
  assert.equal(parseCommand(`/seguir ${'x'.repeat(500)}`).arg.length <= 200, true, 'lo que se lee está acotado');
  assert.equal(parseHour('7:30'), '07:30');
  assert.equal(parseHour('0730'), '07:30');
  assert.equal(parseHour('25:00'), null);
  assert.equal(parseHour('mañana'), null);
});

test('hora de Madrid', () => {
  assert.equal(madridHourMinute(NOW), '12:00');
  assert.equal(madridDay(Date.parse('2026-11-10T23:30:00Z')), '2026-11-11', 'pasada la medianoche de Madrid, otro día');
});

// Un texto UTF-16 bien formado: ningún par sustituto partido (Telegram rechaza el mensaje entero).
const wellFormed = (t) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);

test('recortes: nunca parten un emoji (par sustituto) por la mitad', () => {
  for (let pad = 0; pad < 4; pad++) {
    const t = `${'x'.repeat(pad)}${'🚆'.repeat(30)}`;
    for (let max = 2; max < 40; max++) {
      const cut = cutText(t, max);
      assert.ok(cut.length <= max, `cabe en ${max}`);
      assert.ok(wellFormed(cut), `sin partir con ${pad} delante y ${max}`);
    }
  }
  assert.equal(cutText('corto', 10), 'corto');
  assert.ok(wellFormed(fitMessage(`${'a'.repeat(MESSAGE_MAX - 2)}🚆🚆🚆`)));
  const notice = { id: 'n', category: 'ferroviario', type: 'aviso', title: `${'t'.repeat(118)}🚆🚆`, description: `${'d'.repeat(398)}🚆🚆`, follow: [C4A] };
  const noticeText = collectFacts({ keys: [C4A], events: [notice], now: NOW }).get(C4A)[0].text;
  assert.ok(wellFormed(noticeText));
  assert.ok(noticeText.includes(notice.description), 'el texto de un aviso va entero: su licencia pide no alterarlo');
  const longReason = { ...c4Cancelled, id: 'largo', trip: { ...c4Cancelled.trip, reason: `${'Motivo largo del operador. '.repeat(20)}Fin.` } };
  const reasonText = collectFacts({ keys: [C4A], events: [longReason], now: NOW }).get(C4A)[0].text;
  assert.ok(reasonText.includes('Fin.'), 'el motivo de una cancelación, entero');
  assert.ok(wellFormed(parseCommand(`/provincia ${'x'.repeat(188)}${'🚆'.repeat(10)}`).arg), 'lo que escribe alguien, acotado sin partir');
});

test('estación: lo que pasa por ella, por el índice de la ronda (igual que mirando cada viaje); las retiradas, aparte', () => {
  const station = { name: 'Getafe-Centro', lat: 40.3, lon: -3.73 };
  const trip = (id, time, extra = {}) => ({
    id, source: 'x', category: 'cancelacion', type: 'cancelado', title: `Tren ${id} cancelado`,
    trip: { follow: [], stops: [{ name: 'Parla', time: '06:00' }, { name: ' GETAFE-CENTRO ', time, lat: 40.3, lon: -3.73 }, { name: 'Atocha', time: '07:00' }] }, ...extra,
  });
  const far = { ...trip('lejos', '06:10'), trip: { follow: [], stops: [{ name: 'Getafe-Centro', time: '06:10', lat: 42.0, lon: -3.73 }] } };
  const events = [trip('b', '06:40'), trip('a', '06:20'), trip('retirada', '06:30', { withdrawn: NOW - 60_000 }), far,
    { ...trip('sd', '06:50'), category: 'sin-datos', type: 'sin-datos', title: 'Tren sd sin datos' }, notice];
  const viaIndex = tripsAt(events, station).map(({ e, here }) => [e.id, here.time]);
  const oneByOne = events.map((e) => [e, stopAt(e, station)]).filter(([e, here]) => here && (e.category === 'cancelacion' || e.category === 'sin-datos'))
    .map(([e, here]) => [e.id, here.time]);
  assert.deepEqual(viaIndex, oneByOne, 'el índice da lo mismo que recorrerlos');
  assert.deepEqual(viaIndex.map(([id]) => id), ['b', 'a', 'retirada', 'sd'], 'por nombre, sin mirar mayúsculas; la de lejos, no');
  events.push(trip('nueva', '06:05'));
  assert.equal(tripsAt(events, station).length, 5, 'si la lista cambia, el índice se rehace');
  const key = stopKey('17000');
  const facts = collectFacts({ keys: [key], events, now: NOW, stationOf: () => station }).get(key);
  assert.deepEqual(facts.map((f) => f.id), ['b', 'a', 'sd', 'nueva'], 'para avisar, sin las retiradas');
  const { lines } = statusOf(key, { events, now: NOW, stationOf: () => station });
  assert.equal(lines[0], 'Pasaban hoy por Getafe-Centro y están cancelados o con paradas suprimidas: 3; sin datos: 1.');
  assert.deepEqual(lines.slice(1, 5), ['- Tren nueva cancelado (aquí a las 06:05)', '- Tren a cancelado (aquí a las 06:20)', '- Tren b cancelado (aquí a las 06:40)',
    '- Tren sd sin datos (aquí a las 06:50)'], 'por su hora allí');
  assert.equal(lines.at(-1), 'Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule.');
  const onlyGone = statusOf(key, { events: [trip('r', '06:30', { withdrawn: 1 })], now: NOW, stationOf: () => station }).lines;
  assert.deepEqual(onlyGone, ['Hoy no hay cancelaciones en vigor ni servicios sin datos que pasen por Getafe-Centro.',
    'Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule.']);
});

test('retraso: se avisa cuando empeora, no cuando mejora (aunque al seguirlo ya fuera tarde)', () => {
  const at = (delay) => [{ ...vehicles[0], delay }];
  const round = (seen, delay, t) => {
    const facts = collectFacts({ keys: [AVANT], vehicles: at(delay), now: t });
    return { facts, seen: trackFacts(seen, facts, t) };
  };
  // Se empieza a seguir con 50 min: lo que ya había, visto.
  let { seen } = round(new Map(), 50, NOW);
  let t = NOW;
  for (const delay of [35, 20, 16, 50, 52]) {
    t += 60_000;
    const r = round(seen, delay, t);
    seen = r.seen;
    assert.deepEqual(newFacts(AVANT, r.facts.get(AVANT), seen, t - 60_000), [], `${delay} min: no es nuevo`);
  }
  t += 60_000;
  const r = round(seen, 66, t);
  assert.deepEqual(newFacts(AVANT, r.facts.get(AVANT), r.seen, t - 60_000).map((f) => f.text.match(/va con (\d+) min/)[1]), ['66'], 'empeora: un aviso');
  // De 0 a 50 de golpe: un solo aviso (el de su escalón), no uno por escalón.
  const fresh = round(new Map(), 0, NOW);
  const jump = round(fresh.seen, 50, NOW + 60_000);
  assert.deepEqual(newFacts(AVANT, jump.facts.get(AVANT), jump.seen, NOW).map((f) => f.id), ['renfe-ld:08058|retraso|2']);
});

test('mensajes en bloques: cada cosa entera, en varios mensajes; lo que no cabe se cuenta; la web al final', () => {
  const blocks = Array.from({ length: 12 }, (_, i) => `Cosa ${i}:\n${'línea de estado. '.repeat(60)}`); // ~1.000 caracteres cada uno
  const all = packBlocks(blocks, { footer: 'Más en https://x.es', maxMessages: 10 });
  assert.ok(all.length > 1 && all.every((m) => m.length <= MESSAGE_MAX));
  assert.deepEqual(all.join('\n\n').match(/^Cosa \d+:/gm), blocks.map((_, i) => `Cosa ${i}:`), 'todas, en orden y enteras');
  for (const m of all) assert.ok(!/…$/.test(m.split('\n\n').at(-2) ?? ''), 'ningún bloque recortado');
  assert.match(all.at(-1), /Más en https:\/\/x\.es$/);
  const capped = packBlocks(blocks, { footer: 'Más en https://x.es', maxMessages: 2, more: (n) => `…y ${n} más.` });
  assert.equal(capped.length, 2);
  const shown = capped.join('\n\n').match(/^Cosa \d+:/gm).length;
  assert.match(capped.at(-1), new RegExp(`…y ${12 - shown} más\\.\\n\\nMás en https://x\\.es$`), 'dice cuántas quedan fuera');
  assert.ok(capped.every((m) => m.length <= MESSAGE_MAX));
  const huge = packBlocks([`Enorme:\n${'x'.repeat(9000)}`, 'Pequeño:\nbien'], { footer: 'web' });
  assert.ok(huge.every((m) => m.length <= MESSAGE_MAX) && /Pequeño:\nbien\n\nweb$/.test(huge.at(-1)), 'un bloque que no cabe solo se parte; el resto sigue');
  assert.equal(huge.join('').replace(/[^x]/g, '').length, 9000, 'sin perder nada');
  // Con sus atribuciones aparte, van en cada trozo de un bloque partido.
  const lines = Array.from({ length: 120 }, (_, i) => `- Aviso ${i}: ${'texto de la fuente '.repeat(3)}`).join('\n');
  const split = packBlocks([{ text: `Línea C4:\n${lines}`, credits: 'Origen de los datos: Renfe Operadora' }], { footer: 'web', maxMessages: 10 });
  assert.ok(split.length > 1);
  for (const m of split) assert.match(m, /Origen de los datos: Renfe Operadora(\n\nweb)?$/);
  assert.equal(split.join('\n').match(/- Aviso \d+:/g).length, 120, 'todas las líneas');
  // Si no caben todos los mensajes, un bloque va entero o se cuenta entre los que faltan, nunca a medias.
  const capped2 = packBlocks([{ text: `Línea C4:\n${lines}`, credits: 'Renfe' }, 'Pequeño:\nbien'], { footer: 'web', maxMessages: 1, more: (n) => `…y ${n} más.` });
  assert.deepEqual(capped2, ['Pequeño:\nbien\n\n…y 1 más.\n\nweb'], 'el que no cabe entero, fuera y contado; el siguiente, sí');
  assert.deepEqual(packBlocks([], { footer: 'web' }), ['web']);
});

test('búsqueda ambigua: a igual encaje, por el orden del registro de tipos (trenes, metros y tranvías antes que autobuses)', () => {
  const bus = (op, i) => ({ id: `b${i}`, mode: 'bus', operator: op, line: 'C1', follow: [lineKey({ operator: op, line: 'C1' })] });
  const list = [...['Alsa', 'Auvasa', 'Avanza', 'EMT València', 'Moventis'].map(bus), vehicles[3],
    { id: 't', mode: 'tranvia', operator: 'Tranvía de Murcia', line: 'C1', follow: [lineKey({ operator: 'Tranvía de Murcia', line: 'C1' })] }];
  const dir = updateDirectory(new Map(), { vehicles: list, now: NOW });
  const found = searchDirectory(dir, 'C1', { limit: Infinity });
  assert.deepEqual(found.slice(0, 2).map((e) => e.mode), ['cercanias', 'tranvia']);
  assert.equal(found.length, 7);
});

test('nombres de lo que no se ve: sólo lo comprobable (operador conocido, número, código corto); nunca el texto libre de la clave', () => {
  const dir = updateDirectory(new Map(), { vehicles, events: [cancelled], now: NOW });
  const known = knownNames(dir);
  assert.equal(known.operators.get('emtmalaga'), 'EMT Málaga');
  assert.ok(known.scopes.has('Madrid'));
  assert.equal(guessedName(lineKey({ operator: 'EMT Málaga', line: '71' }), known), 'Línea 71 · EMT Málaga');
  assert.equal(guessedName(lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C10' }), known), 'Línea C10 · Renfe (Madrid)');
  assert.equal(guessedName(numberedServiceKey({ operator: 'Renfe', number: '04375' }), known), 'Renfe 4375');
  assert.equal(guessedName(scheduledServiceKey({ operator: 'Euskotren', line: 'E3', origin: 'x', departure: 17 * 3600 + 7 * 60 }), known), 'Línea E3 · Euskotren, el de las 17:07');
  assert.equal(guessedName('l-emtmalagaa-71', known), 'esa línea (ahora no se ve)', 'red que no se conoce');
  assert.equal(guessedName('s-noexiste-1', known), 'ese servicio (ahora no se ve)');
  for (const key of ['l-renfe-_0A_0AHecho_3A_20baja', 'l-renfe-Visita_20evil_2Ecom', 'l-renfe-_E2_80_AEabc', 'l-renfe-Inventado-C4']) {
    const name = guessedName(key, known);
    assert.ok(!/\n|evil|Hecho|\u202e|Inventado/.test(name), `${key} → ${name}`);
  }
  assert.equal(guessedName(stopKey('17000'), known), null, 'las estaciones, del catálogo');
});

test('charla: «hola», «gracias», «vale»… no son búsquedas; una línea o un número, sí', () => {
  for (const [t, kind] of [['Hola', 'saludo'], ['¡Hola, bot!', 'saludo'], ['buenos días', 'saludo'], ['Gracias!!', 'gracias'], ['vale', 'vale'],
    ['ok', 'vale'], ['ayuda', 'ayuda'], ['help', 'ayuda']]) assert.equal(smallTalk(t), kind, t);
  for (const t of ['C4 Madrid', '08058', 'hola madrid', 'Valencia', '27 EMT Málaga', '']) assert.equal(smallTalk(t), null, t);
});

test('lo nuevo de muchos chats en una ronda (newFactsOf): lo mismo que newFacts, mirando cada suscripción una vez', () => {
  const t0 = NOW;
  const t1 = NOW + 60_000;
  let seen = trackFacts(new Map(), collectFacts({ keys: [AVANT, C4A], vehicles, events: [notice], now: t0 }), t0);
  const more = { ...notice, id: 'renfe-aviso:2', description: 'Otro aviso.' };
  const facts = collectFacts({ keys: [AVANT, C4A], vehicles, events: [notice, more, cancelled], now: t1 });
  const firsts = new Map();
  seen = trackFacts(seen, facts, t1, { firsts });
  for (const fresh of [newFactsOf(facts, seen, firsts), newFactsOf(facts, seen)]) {
    for (const sub of [AVANT, C4A, 'l-nadie']) {
      for (const checkedAt of [t0 - 60_000, t0, t1]) {
        assert.deepEqual(fresh(sub, checkedAt), newFacts(sub, facts.get(sub), seen, checkedAt), `${sub} desde ${checkedAt - t0}`);
      }
    }
  }
  assert.deepEqual(newFactsOf(facts, seen, firsts)(C4A, t0).map((f) => f.id), ['renfe-aviso:2']);
});

test('atribuciones de un mensaje: cada una una vez, sin las que ya van dentro de otra', () => {
  const renfe = 'Origen de los datos: Renfe Operadora (CC BY 4.0)';
  const withTrack = `${renfe} · trazado: Powered by MITRAMS (Punto de Acceso Nacional)`;
  assert.equal(joinCredits([renfe, withTrack, renfe, null, '© AEMET']), `${withTrack} · © AEMET`);
  assert.equal(joinCredits([]), '');
  const [msg] = factsMessages('C4', [{ id: 'a', text: 'A', credit: renfe }, { id: 'b', text: 'B', credit: withTrack }], { webUrl: 'https://x.es' });
  assert.equal(msg.match(/Origen de los datos/g).length, 1);
});

test('avisos de Renfe de una línea: una vez cada texto (Renfe publica a veces el mismo con otro id); en /estado, hasta 3 y cuántos más', () => {
  const same = { ...notice, id: 'renfe-aviso:dup', title: 'Aviso Renfe · C4a', description: '  Por huelga de maquinistas   circulan los servicios mínimos. ' };
  const others = Array.from({ length: 3 }, (_, i) => ({ ...notice, id: `renfe-aviso:o${i}`, description: `Otro aviso ${i}.` }));
  const events = [notice, same, ...others];
  assert.deepEqual(collectFacts({ keys: [C4A], events, now: NOW }).get(C4A).map((f) => f.id), ['renfe-aviso:1', 'renfe-aviso:o0', 'renfe-aviso:o1', 'renfe-aviso:o2']);
  const { lines } = statusOf(C4A, { vehicles, events, now: NOW });
  assert.equal(lines.filter((l) => l.startsWith('Aviso: ')).length, 3);
  assert.equal(lines.filter((l) => l.includes('servicios mínimos')).length, 1, 'el repetido, una vez');
  assert.equal(lines.at(-1), '…y 1 más.', 'antes se cortaba a 2 sin decirlo');
});

test('los avisos de las fuentes conservan sus saltos de línea (los de Windows, normales; sin espacios dobles ni más de una línea en blanco)', () => {
  const text = 'Renfe   informa:\r\n\r\n\r\n  Con motivo de las obras,\tlos trenes\r\nno paran en Parla.  ';
  const e = { ...notice, id: 'renfe-aviso:lineas', description: text };
  const [fact] = collectFacts({ keys: [C4A], events: [e], now: NOW }).get(C4A);
  assert.equal(fact.text, 'Aviso Renfe · C4a, C4b: Renfe informa:\n\nCon motivo de las obras, los trenes\nno paran en Parla.');
  assert.match(statusOf(C4A, { events: [e], now: NOW }).lines.join('\n'), /Renfe informa:\n\nCon motivo de las obras, los trenes\nno paran en Parla\./);
  assert.equal(cutText(sourceText(' a \n\n\n b '), 10), 'a\n\nb');
});
