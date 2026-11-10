// Lo que sigue cada chat del bot: el directorio y la búsqueda («08058», «C4 Madrid», «27 EMT Málaga»), los hechos
// de cada cosa seguida (cancelaciones, retrasos, sin datos, avisos, provincias), cuáles son nuevos y sus textos.
// Con vehículos de varios tipos: nada depende de que sea un tren de Renfe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineKey, numberedServiceKey, scheduledServiceKey, stopKey } from '../../server/domain/seguir.js';
import { entryLabel, searchDirectory, updateDirectory } from '../../server/domain/seguidos/directorio.js';
import {
  DELAY_MIN, collectFacts, factsMessage, madridDay, madridHourMinute, newFacts, provinceSub, statusOf, trackFacts,
} from '../../server/domain/seguidos/avisos.js';
import { parseCommand, parseHour } from '../../server/domain/seguidos/ordenes.js';

const NOW = Date.parse('2026-11-10T11:00:00Z'); // 12:00 en Madrid
const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const C4A = lineKey({ operator: 'Renfe', scope: '10', line: 'C4a' });
const C4B = lineKey({ operator: 'Renfe', scope: '10', line: 'C4b' });
const C1VLC = lineKey({ operator: 'Renfe', scope: '40', line: 'C1' });
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
    delay: 8, origin: 'Colmenar Viejo', destination: 'Parla', area: 'Madrid', current: 'Madrid-Atocha Cercanías', follow: [numberedServiceKey({ operator: 'Renfe', number: '27200' }), C4B] },
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
  assert.equal(dir.get(AVANT_LINE).name, 'Tren Avant · Renfe', 'el producto de AV/LD/MD no se repite');
  assert.equal(dir.get(C4A).name, 'Tren C4a · Cercanías · Renfe');
  assert.equal(dir.get(EMT27).name, 'Autobús 27 · EMT Málaga');
  assert.equal(dir.get(E4).name, 'Tren E4 · Euskotren, el de las 13:10, desde Matiko-Bilbao');
  assert.equal(entryLabel(dir.get(C4B)), 'Tren C4b · Cercanías · Renfe (Colmenar Viejo – Parla)');
  updateDirectory(dir, { vehicles: [], now: NOW + 37 * 3600_000 });
  assert.equal(dir.size, 0);
});

test('búsqueda: por número (con o sin ceros), por línea y ciudad u operador, por hora; y nada si no encaja', () => {
  const dir = updateDirectory(new Map(), { vehicles, events: [cancelled], now: NOW });
  assert.deepEqual(searchDirectory(dir, '08058').map((e) => e.key), [AVANT]);
  assert.deepEqual(searchDirectory(dir, '8058').map((e) => e.key), [AVANT]);
  assert.deepEqual(searchDirectory(dir, 'C4 Madrid').map((e) => e.key), [C4B], 'por dónde se le ha visto pasar, aunque no empiece ni acabe allí');
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
  assert.deepEqual(worse.get(AVANT).map((f) => f.id), ['renfe-ld:08058|retraso|1'], `+${DELAY_MIN} min más: otro aviso`);
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

test('mensaje: título, lo que pasa (como mucho 8 y cuántos más), fuentes sin repetir y la web', () => {
  const one = factsMessage('Avant 08058', [{ id: 'a', text: 'Va con 22 min de retraso.', credit: 'Renfe' }], { webUrl: 'https://radarespana.es' });
  assert.equal(one, 'Avant 08058:\n\nVa con 22 min de retraso.\n\nRenfe\n\nMás en https://radarespana.es');
  const many = factsMessage('Tren C4a', Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `T${i}`, credit: 'Renfe' })), { webUrl: 'https://x.es' });
  assert.match(many, /^Tren C4a:\n\n- T0\n- T1\n.*- T7\n…y 2 más\.\n\nRenfe\n\nMás en https:\/\/x\.es$/s);
  const long = factsMessage('X', [{ id: 'a', text: 'a'.repeat(5000), credit: null }], { webUrl: 'https://x.es' });
  assert.ok(long.length <= 3800);
});

test('estado: un servicio que circula, cancelado o que no se ve; una línea; una provincia', () => {
  const ctx = { vehicles, events: [cancelled, c4Cancelled, notice, orange], now: NOW, creditOf };
  const avant = statusOf(AVANT, ctx);
  assert.equal(avant.lines[0], 'Avant 08058: circula con 22 min de retraso, de Valladolid-Campo Grande a Madrid-Chamartín-Clara Campoamor. Próxima parada: Segovia-Guiomar.');
  assert.match(avant.lines[1], /^Avant 08058 cancelado/);
  assert.deepEqual(statusOf(numberedServiceKey({ operator: 'Renfe', number: '1' }), ctx).lines,
    ['Ahora no se ve circulando: puede que no le toque a esta hora o que su operador no lo publique.']);
  const c4 = statusOf(C4A, ctx).lines;
  assert.equal(c4[0], 'Ahora circulan 1 trenes; 0 de los 1 que dicen su retraso llevan 5 min o más.');
  assert.equal(c4[1], 'Cancelados o con paradas suprimidas hoy: 1.');
  assert.match(c4.at(-1), /^Aviso: Aviso Renfe · C4a, C4b: Por huelga/);
  assert.deepEqual(statusOf(EMT27, ctx).lines, ['Ahora circulan 1 autobuses.'], 'el nombre de los vehículos, del registro de tipos');
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
