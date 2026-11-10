// El tráfico en el bot de Telegram: la clave de una carretera (entera o en una provincia), qué incidencias se avisan
// a quien sigue una carretera o una provincia (pocas: cortes, accidentes y lo grave), sus textos tal cual los da su
// fuente, cuáles son nuevas y cómo está ahora. Con incidencias como las de la DGT, el Servei Català de Trànsit y
// Tráfico de Euskadi del 10-nov-2026. Reloj fijo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_KEY_MAX, followKind, isFollowKey, isRoadKey, parseRoadKey, roadCode, roadKey, roadLabel } from '../../server/domain/seguir.js';
import { PROVINCIAS_ES, provinceById } from '../../server/domain/provincias.js';
import {
  TRAFFIC_FRESH_MS, parseRoadRequest, provinceTrafficStatus, provinceWorthy, roadName, roadRequestHelp, roadStatus, roadSub, roadTitle,
  roadWorthy, trafficFact, trafficFacts, trafficProvinceId,
} from '../../server/domain/seguidos/trafico.js';
import { collectFacts, newFacts, provinceSub, statusOf, trackFacts } from '../../server/domain/seguidos/avisos.js';

const NOW = Date.parse('2026-11-10T21:00:00Z'); // 22:00 en Madrid
const MIN = 60_000;
const TELEGRAM_START = /^[A-Za-z0-9_-]{1,64}$/;
const credits = { dgt: 'Fuente: DGT', sct: 'Servei Català de Trànsit', 'trafico-euskadi': 'Open Data Euskadi (CC BY 4.0)' };
const creditOf = (source) => credits[source] ?? null;

// Como las dan los adaptadores (dgt.js y trafico-autonomico.js).
const dgt = (over = {}) => ({
  id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', subtype: 'accident', severity: 'media', closed: false,
  road: 'A-7', province: 'Málaga', title: 'Accidente · A-7 km 1012.0', description: 'Marbella, Málaga', lat: 36.51, lon: -4.88,
  start: NOW - 10 * MIN, end: null, updated: NOW - 5 * MIN, ...over,
});
const sctCut = {
  id: 'sct:152467501', source: 'sct', category: 'carretera', type: 'abnormalTraffic', severity: 'media', closed: true, road: 'AP-2',
  title: 'Retención · AP-2 km 205.0', description: 'Calçada tallada · Retirada de vehicle · sentido LLEIDA', lat: 41.62, lon: 0.68, start: NOW - 6 * MIN,
};
const euskadi = {
  id: 'euskadi:378636', source: 'trafico-euskadi', category: 'carretera', type: 'accident', severity: 'baja', closed: false, road: 'GI-627',
  title: 'Alcance · GI-627 km 38.0', description: 'Accidente · Arrasate/Mondragón · sentido EIBAR (POR MALTZAGA)', lat: 43.07, lon: -2.46, start: NOW - 2 * MIN,
};
const busNotice = { id: 'emt-madrid:1', source: 'emt-madrid-avisos', category: 'carretera', type: 'aviso', severity: 'alta', title: 'EMT Madrid · Desvío línea 3', lat: null, lon: null };

test('clave de carretera: «A-7», «a7» y «A 7» son la misma; con provincia, su id sin guiones; cabe en el start de Telegram', () => {
  for (const text of ['A-7', 'a7', 'A 7', ' a-7 ', 'A‐7']) assert.equal(roadKey(text), 'c-A7', text);
  assert.equal(roadCode('N-121-A'), roadCode('N-121A'), 'la DGT y Euskadi escriben distinto la misma');
  assert.equal(roadCode('TE-V-1121'), 'TEV1121');
  assert.equal(roadCode('N-II'), 'NII', 'las nacionales en números romanos');
  assert.equal(roadCode('N-IIa'), 'NIIA');
  for (const text of ['', 'Obra', 'CV privado Iberdrola', 'VIAs SE-225', 'RM', 'Málaga', 'hola', null]) assert.equal(roadCode(text), null, String(text));
  assert.equal(roadKey('A-7', 'malaga'), 'c-A7-malaga');
  assert.deepEqual(parseRoadKey('c-A7-santacruzdetenerife'), { road: 'A7', province: 'santacruzdetenerife' });
  assert.deepEqual(parseRoadKey('c-AP7'), { road: 'AP7', province: null });
  for (const p of PROVINCIAS_ES) {
    const key = roadKey('VS-M-501-C', p.id);
    assert.match(key, TELEGRAM_START, p.id);
    assert.ok(key.length <= FOLLOW_KEY_MAX);
    assert.equal(roadSub(key).province, p, 'cada provincia vuelve de su clave');
  }
  assert.equal(new Set(PROVINCIAS_ES.map((p) => p.id.replaceAll('-', ''))).size, PROVINCIAS_ES.length, 'sin guiones no se confunden');
});

test('clave de carretera: sólo lo que parece una carretera, y no es una clave de vehículo (ni «Mis trenes» ni /api/live/siguiendo la ven)', () => {
  for (const key of ['c-A7', 'c-AP7-tarragona', 'c-NII', 'c-TEV1121']) assert.equal(isRoadKey(key), true, key);
  for (const key of ['c-a7', 'c-A7-Malaga', 'c-HOLA', 'c-A7-x', 'c-', 'c-A7-malaga-x', 'l-renfe-C1', 'prov-malaga', `c-A7-${'a'.repeat(30)}`, 42, null]) {
    assert.equal(isRoadKey(key), false, String(key));
  }
  assert.equal(isFollowKey('c-A7'), false);
  assert.equal(followKind('c-A7'), null);
  assert.equal(roadSub('c-A7-atlantida'), null, 'una provincia que no existe');
  assert.equal(roadLabel('A7'), 'A-7');
  assert.equal(roadLabel('AP7'), 'AP-7');
  assert.equal(roadLabel('NII'), 'N-II');
  assert.equal(roadLabel('N121A'), 'N-121A');
  assert.equal(roadName('TEV1121', [dgt({ road: 'TE-V-1121' })]), 'TE-V-1121', 'como la escribe su fuente, si se ve');
  assert.equal(roadName('TEV1121', [busNotice]), 'TEV-1121');
  assert.equal(roadTitle('A-7', provinceById('malaga')), 'Carretera A-7 (Málaga)');
});

test('/carretera: la carretera y, al final, la provincia (con o sin «en», «provincia de»); lo que no se entiende, se dice', () => {
  const key = (text) => parseRoadRequest(text).key ?? parseRoadRequest(text).error;
  assert.equal(key('A-7'), 'c-A7');
  assert.equal(key('a7 Málaga'), 'c-A7-malaga');
  assert.equal(key('A 7 malaga'), 'c-A7-malaga');
  assert.equal(key('la AP-7 en Tarragona'), 'c-AP7-tarragona');
  assert.equal(key('autovía A-2 provincia de Guadalajara'), 'c-A2-guadalajara');
  assert.equal(key('AC-552 A Coruña'), 'c-AC552-acoruna');
  assert.equal(key('TF-21 Santa Cruz de Tenerife'), 'c-TF21-santacruzdetenerife');
  assert.equal(key('N-340 Alacant'), 'c-N340-alicante', 'por sus otros nombres');
  assert.equal(key(''), 'vacia');
  assert.equal(key('carretera'), 'vacia');
  assert.equal(key('Málaga'), 'sin-carretera');
  assert.equal(key('A7 Mlaga'), 'carretera', 'una provincia mal escrita no se pega a la carretera («A7MLAGA»)');
  assert.equal(key('tranvía de la luna'), 'carretera');
  assert.match(roadRequestHelp(parseRoadRequest('Málaga')), /^Dime también la carretera, por ejemplo: \/carretera A-7 Málaga\. Para los avisos de toda la provincia: \/provincia Málaga\.$/);
  assert.match(roadRequestHelp(parseRoadRequest('xyz'), 'xyz'), /^No entiendo qué carretera es «xyz»/);
  assert.match(roadRequestHelp(parseRoadRequest('')), /^Dime la carretera: \/carretera A-7/);
});

test('umbrales: en una carretera, cortes, accidentes y lo grave (las obras, si cortan); en una provincia, sólo cortes y accidentes graves', () => {
  const cases = [
    // [incidencia, ¿carretera?, ¿provincia?]
    [dgt(), true, false, 'accidente de gravedad media'],
    [dgt({ severity: 'muy alta' }), true, true, 'accidente grave'],
    [dgt({ closed: true }), true, true, 'accidente que corta la carretera'],
    [dgt({ type: 'roadMaintenance', severity: 'muy alta' }), false, false, 'obras graves sin corte'],
    [dgt({ type: 'roadMaintenance', closed: true }), true, false, 'obras que cortan: a la carretera sí, a la provincia no'],
    [dgt({ type: 'environmentalObstruction', severity: 'muy alta', closed: true }), true, true, 'desprendimiento que corta'],
    [dgt({ type: 'poorEnvironment', severity: 'muy alta' }), true, false, 'viento fuerte sin corte'],
    [dgt({ type: 'vehicleObstruction' }), false, false, 'vehículo detenido'],
    [dgt({ type: 'abnormalTraffic', severity: 'alta' }), true, false, 'retención grave'],
    [sctCut, true, true, 'corte del Servei Català de Trànsit'],
    [euskadi, true, false, 'accidente leve de Euskadi'],
    [busNotice, false, false, 'aviso de un autobús'],
    [{ ...dgt(), category: 'meteo' }, false, false, 'no es de tráfico'],
  ];
  for (const [e, road, province, what] of cases) {
    assert.equal(roadWorthy(e), road, `carretera: ${what}`);
    assert.equal(provinceWorthy(e), province, `provincia: ${what}`);
  }
});

test('provincia de una incidencia: la que dice la DGT (también con dos nombres); si no la dice, la de su punto', () => {
  // La MA-7402 (Ronda) cae más cerca del círculo de Cádiz: con la provincia de la DGT, en Málaga.
  assert.equal(trafficProvinceId(dgt({ province: 'Málaga', lat: 36.73, lon: -5.35 })), 'malaga');
  assert.equal(trafficProvinceId(dgt({ province: 'València/Valencia', lat: 39.68, lon: -0.27 })), 'valencia');
  assert.equal(trafficProvinceId(dgt({ province: 'Araba/Álava', lat: 42.85, lon: -2.67 })), 'alava');
  assert.equal(trafficProvinceId(euskadi), 'gipuzkoa', 'Euskadi no la da: por su punto');
  assert.equal(trafficProvinceId(dgt({ province: 'Narnia', lat: 37.39, lon: -5.98 })), 'sevilla', 'una que no se conoce: por su punto');
});

test('el aviso: título y descripción de su fuente tal cual (Tráfico de Euskadi lo pide), y detrás lo que añade el radar', () => {
  const eus = trafficFact(euskadi, 'Open Data Euskadi (CC BY 4.0)', NOW);
  assert.equal(eus.text, 'Alcance · GI-627 km 38.0 · Accidente · Arrasate/Mondragón · sentido EIBAR (POR MALTZAGA). Desde las 21:58.');
  assert.equal(eus.credit, 'Open Data Euskadi (CC BY 4.0)');
  assert.ok(eus.text.includes(`${euskadi.title} · ${euskadi.description}`), 'sin tocar una letra');
  const cut = trafficFact(dgt({ type: 'environmentalObstruction', title: 'Fenómeno meteorológico o ambiental · A-7150 km 1.2',
    description: 'Casares, Málaga · Carretera cortada', severity: 'muy alta', closed: true, start: Date.parse('2026-02-03T14:45:00Z') }), 'Fuente: DGT', NOW);
  assert.equal(cut.text, 'Fenómeno meteorológico o ambiental · A-7150 km 1.2 · Casares, Málaga · Carretera cortada. Gravedad: muy alta. Desde el 3/2/2026.',
    'la DGT ya dice «Carretera cortada»: no se repite');
  assert.match(trafficFact(sctCut, null, NOW).text, /^Retención · AP-2 km 205\.0 · Calçada tallada · Retirada de vehicle · sentido LLEIDA\. Carretera cortada\. Desde las 21:54\.$/,
    'el Servei Català de Trànsit lo dice en catalán: el radar añade «Carretera cortada»');
  const works = trafficFact(dgt({ type: 'roadMaintenance', title: 'Obras · ZP-5207 km 15.8', closed: true, end: Date.parse('2026-12-23T22:59:00Z') }), null, NOW);
  assert.match(works.text, /Carretera cortada\. Desde las 21:50\. Prevista hasta el 23\/12\/2026\.$/);
});

test('hechos: la carretera entera o sólo en su provincia; la misma incidencia dos veces (un número por sentido), una; lo más reciente primero', () => {
  const twin = dgt({ id: 'dgt:2' });
  const cadiz = dgt({ id: 'dgt:3', province: 'Cádiz', title: 'Accidente · A-7 km 115.0', description: 'Algeciras, Cádiz', start: NOW - MIN });
  const works = dgt({ id: 'dgt:4', type: 'roadMaintenance', title: 'Obras · A-7 km 1000.0' });
  const other = dgt({ id: 'dgt:5', road: 'A-45', title: 'Accidente · A-45 km 130.0' });
  const events = [dgt(), twin, cadiz, works, other, busNotice];
  const { roads } = trafficFacts({ keys: ['c-A7', 'c-A7-malaga', 'l-renfe-C1'], events, now: NOW, creditOf });
  assert.deepEqual(roads.get('c-A7').map((f) => f.text.split(' · ')[1]), ['A-7 km 115.0', 'A-7 km 1012.0']);
  assert.deepEqual(roads.get('c-A7-malaga').map((f) => f.text.split(' · ')[1]), ['A-7 km 1012.0']);
  assert.equal(roads.get('c-A7')[1].credit, 'Fuente: DGT');
  assert.equal(roads.has('l-renfe-C1'), false);
  const closed = trafficFacts({ keys: ['c-A7-malaga'], events: [dgt({ closed: true })], now: NOW }).roads.get('c-A7-malaga')[0];
  assert.notEqual(closed.id, roads.get('c-A7-malaga')[0].id, 'si pasa a cortar la carretera, es otro aviso');
});

test('rondas: se avisa una vez; lo de antes de seguirla, no; tras una caída de su fuente, lo viejo que vuelve, tampoco', () => {
  const key = 'c-A7-malaga';
  const sub = provinceSub('malaga');
  const old = dgt({ id: 'dgt:9', type: 'environmentalObstruction', closed: true, severity: 'muy alta', title: 'Fenómeno meteorológico o ambiental · A-7 km 990.0',
    description: 'Casares, Málaga · Carretera cortada', start: NOW - 9 * 86400_000, updated: NOW - 9 * 86400_000 });
  let seen = trackFacts(new Map(), collectFacts({ keys: [key], provinces: ['malaga'], events: [], now: NOW }), NOW);
  const checkedAt = NOW;
  // Un accidente nuevo y un corte de hace nueve días que reaparece (la DGT ha estado caída más de tres horas).
  const t1 = NOW + MIN;
  const facts = collectFacts({ keys: [key], provinces: ['malaga'], events: [dgt({ start: t1 - MIN, updated: t1 - MIN }), old], now: t1, creditOf });
  seen = trackFacts(seen, facts, t1);
  assert.deepEqual(newFacts(key, facts.get(key), seen, checkedAt).map((f) => f.text.split(' · ')[1]), ['A-7 km 1012.0'],
    'el corte viejo va callado: no es nuevo, es que no se veía');
  assert.deepEqual(newFacts(sub, facts.get(sub), seen, checkedAt), [], 'a la provincia, ni el accidente leve ni el corte viejo');
  assert.equal(facts.get(sub).length, 1, 'pero cuenta como visto');
  const t2 = t1 + MIN;
  const again = collectFacts({ keys: [key], provinces: ['malaga'], events: [dgt({ id: 'dgt:otro', start: t1 - MIN, updated: t2 }), old], now: t2, creditOf });
  seen = trackFacts(seen, again, t2);
  assert.deepEqual(newFacts(key, again.get(key), seen, t1), [], 'la DGT lo vuelve a publicar con otro número: no se repite');
  assert.ok(TRAFFIC_FRESH_MS >= 3600_000);
});

test('estado: la carretera (lo que se avisa y cuántas más leves) y, en la provincia, una línea de carreteras con sus atribuciones', () => {
  const works = dgt({ id: 'dgt:4', type: 'roadMaintenance', title: 'Obras · A-7 km 1000.0' });
  const events = [dgt(), works, sctCut];
  const road = statusOf('c-A7-malaga', { events, now: NOW, creditOf });
  assert.deepEqual(road.lines, [
    'Ahora hay 1 corte, accidente o incidencia grave en la A-7 (Málaga):',
    '- Accidente · A-7 km 1012.0 · Marbella, Málaga. Desde las 21:50.',
    'Además, 1 incidencia más leve (obras sin corte, retenciones…), en el mapa.',
  ]);
  assert.deepEqual(road.credits, ['Fuente: DGT']);
  assert.deepEqual(roadStatus('c-N340', { events, now: NOW }).lines, ['Ahora no hay cortes, accidentes ni incidencias graves en la N-340.']);
  const lleida = statusOf(provinceSub('lleida'), { events, now: NOW, creditOf });
  assert.match(lleida.lines[0], /^Ahora no hay avisos naranja o rojo de AEMET/, 'lo de antes, igual');
  assert.deepEqual(lleida.lines.slice(1), ['Carreteras: 1 corte o accidente grave.',
    '- Retención · AP-2 km 205.0 · Calçada tallada · Retirada de vehicle · sentido LLEIDA. Carretera cortada. Desde las 21:54.']);
  assert.deepEqual(lleida.credits, ['Servei Català de Trànsit']);
  assert.deepEqual(provinceTrafficStatus(provinceById('soria'), { events, now: NOW }).lines, ['Carreteras: ahora no hay cortes ni accidentes graves.']);
  const many = Array.from({ length: 7 }, (_, i) => dgt({ id: `dgt:m${i}`, title: `Accidente · A-7 km ${i}.0`, closed: true }));
  const long = provinceTrafficStatus(provinceById('malaga'), { events: many, now: NOW });
  assert.equal(long.lines.at(-1), '…y 2 más.');
  assert.equal(long.lines.length, 7);
});

test('las incidencias de una lista se miran una vez (índice por lista): las retiradas no cuentan, y si la lista cambia, se rehace', () => {
  const cut = dgt({ id: 'dgt:5', closed: true, description: 'Marbella, Málaga · Carretera cortada' });
  const gone = dgt({ id: 'dgt:6', type: 'accident', severity: 'alta', title: 'Accidente · A-7 km 990.0', withdrawn: true });
  const events = [cut, gone, dgt({ id: 'dgt:7', type: 'roadMaintenance', title: 'Obras · A-7 km 1.0' })];
  const status = (list) => roadStatus('c-A7', { events: list, now: NOW, creditOf }).lines;
  assert.deepEqual(status(events).map((l) => l.slice(0, 40)), [
    'Ahora hay 1 corte, accidente o incidenci',
    '- Accidente · A-7 km 1012.0 · Marbella, ',
    'Además, 1 incidencia más leve (obras sin',
  ], 'la retirada no sale');
  assert.equal(trafficFacts({ provinces: ['malaga'], events, now: NOW }).provinces.get('malaga').length, 1);
  events.push(dgt({ id: 'dgt:8', closed: true, title: 'Accidente · A-7 km 1100.0' }));
  assert.equal(trafficFacts({ provinces: ['malaga'], events, now: NOW }).provinces.get('malaga').length, 2, 'la lista ha cambiado: se rehace');
  assert.equal(statusOf(provinceSub('malaga'), { events, now: NOW, creditOf }).lines.filter((l) => l.startsWith('- Accidente')).length, 2,
    'en /estado de la provincia, el tráfico de la misma pasada');
});
