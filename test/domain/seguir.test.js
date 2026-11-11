// Qué se puede seguir de un vehículo: claves de servicio, línea y parada, estables entre días, de cualquier
// tipo de vehículo, y que caben tal cual en el parámetro start de Telegram (64 caracteres de [A-Za-z0-9_-]).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_DAYS, FOLLOW_KEY_MAX, answersTo, canonicalKey, daysText, describeFollow, followKind, followOf, isFollowKey, lineKey, mergeFollow, networkPart,
  numberedServiceKey, parseFollowKey, scheduledServiceKey, shortHash, stopCode, stopKey, trayectoKey,
} from '../../server/domain/seguir.js';

const TELEGRAM_START = /^[A-Za-z0-9_-]{1,64}$/;
const h = (hh, mm) => hh * 3600 + mm * 60;

test('servicio con número: el mismo con o sin ceros a la izquierda, en cualquier feed', () => {
  assert.equal(numberedServiceKey({ operator: 'Renfe', number: '08058' }), 's-renfe-8058');
  assert.equal(numberedServiceKey({ operator: 'Renfe', number: '8058' }), 's-renfe-8058');
  assert.equal(numberedServiceKey({ operator: 'Ouigo', number: '11740' }), 's-ouigo-11740');
  assert.equal(numberedServiceKey({ operator: 'Renfe', number: null }), null);
  assert.equal(numberedServiceKey({ operator: '', number: '1' }), null, 'sin operador no hay red');
});

test('servicio de un horario: su línea, su parada de origen y su hora; otro origen u otra hora, otro servicio', () => {
  const base = { operator: 'EMT Málaga', line: '27', origin: '2354', departure: h(7, 32) };
  const key = scheduledServiceKey(base);
  assert.match(key, /^s-emtmalaga-27-[0-9a-z]{7}-0732$/);
  assert.equal(scheduledServiceKey({ ...base }), key, 'mañana, el mismo');
  assert.notEqual(scheduledServiceKey({ ...base, origin: '2355' }), key, 'desde la otra cabecera a la misma hora');
  assert.notEqual(scheduledServiceKey({ ...base, departure: h(7, 33) }), key);
  assert.match(scheduledServiceKey({ ...base, departure: h(25, 10) }), /-2510$/, 'pasada la medianoche del horario');
  assert.match(scheduledServiceKey({ ...base, line: null }), /^s-emtmalaga-_-/, 'sin nombre de línea');
  assert.equal(scheduledServiceKey({ ...base, origin: null }), null);
  assert.equal(scheduledServiceKey({ ...base, departure: NaN }), null);
});

test('línea: con su núcleo en Cercanías; sin línea, toda la red; los signos se escapan', () => {
  assert.equal(lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' }), 'l-renfe-Madrid-C4a');
  assert.equal(lineKey({ operator: 'Renfe', scope: 'Cádiz', line: 'C1' }), 'l-renfe-C_C3_A1diz-C1');
  assert.notEqual(lineKey({ operator: 'Renfe', scope: 'Valencia', line: 'C1' }), lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C1' }));
  assert.equal(lineKey({ operator: 'Metro Bilbao' }), 'l-metrobilbao');
  assert.equal(lineKey({ operator: 'Renfe', scope: 'Valencia' }), 'l-renfe', 'un ámbito sin línea se leería como una línea');
  const crowded = lineKey({ operator: 'Operador con un nombre larguísimo', scope: 'Ámbito de veinte letras', line: 'Línea larga de 20 chr' });
  assert.ok(isFollowKey(crowded) && crowded.length <= FOLLOW_KEY_MAX, crowded);
  assert.equal(parseFollowKey(crowded).parts[0], null, 'si no cabe todo, el ámbito va como huella');
  assert.equal(lineKey({ operator: 'Sagalés Vic', line: 'L-1' }), 'l-sagalesvic-L_2D1');
  assert.equal(lineKey({ operator: 'Renfe', line: 'Regional Exprés' }), 'l-renfe-Regional_20Expr_C3_A9s');
  assert.equal(lineKey({ operator: 'EMT València', line: ' 4 ' }), lineKey({ operator: 'EMT Valencia', line: '4' }), 'sin tildes ni espacios de más');
});

test('la red: el operador sin tildes ni signos; uno muy largo, abreviado con su huella', () => {
  assert.equal(networkPart("TRAM d'Alacant"), 'tramdalacant');
  assert.equal(networkPart('Sagalés (FyT)'), 'sagalesfyt');
  const long = networkPart('AISA Ciudad Real y Seseña');
  assert.equal(long.length, 20);
  assert.match(long, /^aisaciudadr__[0-9a-z]{7}$/);
  assert.notEqual(long, networkPart('AISA Ciudad Real y Toledo'));
  assert.equal(networkPart('  '), null);
});

test('todas caben en el parámetro start de Telegram, también en el peor caso', () => {
  const worst = [
    scheduledServiceKey({ operator: 'VIAGON AUTOCARES SL Y MUCHOS MÁS', line: 'EL CABACO por Sequeros-BEJAR', origin: 'CIUDAD RODRIGO ESTACION DE AUTOBUSES', departure: h(29, 59) }),
    lineKey({ operator: 'Autocares Rías Baixas y Tren Turístico', scope: 'núcleo larguísimo', line: 'VILLAR_CIERVO-CIUDAD_RODRIGO' }),
    numberedServiceKey({ operator: 'Operador con un nombre larguísimo', number: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }),
    stopKey('euskotren:2576'),
  ];
  for (const key of worst) {
    assert.ok(key, 'se puede construir');
    assert.ok(key.length <= FOLLOW_KEY_MAX, `${key} (${key.length})`);
    assert.match(key, TELEGRAM_START);
    assert.ok(isFollowKey(key), key);
  }
  assert.match(worst[1], /-__[0-9a-z]{7}$/, 'la línea larga va como huella');
});

test('parada: el código de su catálogo, de ida y vuelta', () => {
  for (const code of ['71801', 'mlm:par_10_1', 'tmb:2.1000.674887', 'fgc:PC', 'tranviazaragoza:0702']) {
    const key = stopKey(code);
    assert.match(key, TELEGRAM_START, code);
    assert.equal(stopCode(key), code);
  }
  assert.equal(stopKey('71801'), 'p-71801');
  assert.equal(stopKey(''), null);
  assert.equal(stopCode('l-renfe-10-C4a'), null, 'no es una parada');
});

test('validación: tipo conocido, de una a cuatro partes bien escritas y nada más', () => {
  for (const bad of [null, '', 'x-renfe', 's-', 's-a-b-c-d-e', 's-renfe:8058', 's-ren fe', `s-${'a'.repeat(70)}`, 'l-renfe-_ZZ', 's-renfe-__abc', 'p-a--b']) {
    assert.equal(isFollowKey(bad), false, String(bad));
  }
  for (const good of ['s-renfe-8058', 'l-metrobilbao', 'p-71801', 'l-renfe-__17cohho', 's-emtmalaga-_-0abc123-0732']) assert.equal(isFollowKey(good), true, good);
  assert.equal(followKind('s-renfe-8058'), 'servicio');
  assert.equal(followKind('l-metrobilbao'), 'linea');
  assert.equal(followKind('p-71801'), 'parada');
  assert.equal(followKind('nada'), null);
});

test('las partes se leen de la clave; la huella, no', () => {
  assert.deepEqual(parseFollowKey('s-renfe-8058'), { kind: 'servicio', network: 'renfe', parts: ['8058'], number: '8058' });
  const s = parseFollowKey(scheduledServiceKey({ operator: 'Sagalés Vic', line: 'L-1', origin: '4026', departure: h(7, 5) }));
  assert.equal(s.network, 'sagalesvic');
  assert.equal(s.parts[0], 'L-1');
  assert.equal(s.departure, '07:05');
  assert.deepEqual(parseFollowKey('l-renfe-C_C3_A1diz-C1').parts, ['Cádiz', 'C1']);
  assert.deepEqual(parseFollowKey(lineKey({ operator: 'X', line: 'una línea con un nombre muy largo' })).parts, [null]);
  assert.equal(parseFollowKey('roto'), null);
});

test('cómo se llama: con lo que se sepa de él, o lo que diga la clave', () => {
  assert.equal(describeFollow('s-renfe-8058', { service: 'Avant', number: '08058' }), 'Avant 08058');
  assert.equal(describeFollow('s-renfe-8058'), 'renfe 8058');
  const bus = scheduledServiceKey({ operator: 'EMT Málaga', line: '27', origin: '2354', departure: h(7, 32) });
  assert.equal(describeFollow(bus, { operator: 'EMT Málaga', origin: 'Plaza Mayor', modeLabel: 'Autobús' }), 'Autobús 27 · EMT Málaga, el de las 07:32, desde Plaza Mayor');
  assert.equal(describeFollow('l-renfe-Madrid-C5', { operator: 'Renfe', service: 'Cercanías', line: 'C5', area: 'Getafe' }), 'Cercanías C5 · Renfe (Madrid)',
    'el ámbito de la clave, nunca dónde está ahora el vehículo');
  assert.equal(describeFollow('l-renfe-Catalunya-R16', { operator: 'Renfe', service: 'Rodalies' }), 'Rodalies R16 · Renfe (Catalunya)');
  assert.equal(describeFollow('l-renfe-Madrid-C5'), 'Línea C5 · renfe (Madrid)', 'sin nada más, lo que dice la clave');
  assert.equal(describeFollow('l-emtmalaga-71', { operator: 'EMT Málaga', service: 'EMT Málaga', modeLabel: 'Autobús' }), 'Autobús 71 · EMT Málaga');
  assert.equal(describeFollow('l-euskotren-E4', { operator: 'Euskotren', service: 'Euskotren', modeLabel: 'Tren' }), 'Tren E4 · Euskotren');
  assert.equal(describeFollow('l-renfe-AVE', { operator: 'Renfe', service: 'AVE', line: 'AVE', area: 'Orihuela', modeLabel: 'Tren' }), 'AVE · Renfe',
    'la línea es el propio producto: sin repetirlo');
  assert.equal(describeFollow('s-renfe-23065', { service: 'Cercanías', number: '23065' }), 'Cercanías 23065');
  assert.equal(describeFollow('l-metrobilbao', { operator: 'Metro Bilbao' }), 'Metro Bilbao: toda la red');
  assert.equal(describeFollow('p-tmb-123', { name: 'Diagonal' }), 'Diagonal');
  assert.equal(describeFollow('p-tmb-123'), 'tmb:123');
  assert.equal(describeFollow('nada'), null);
});

test('listas de claves: sin repetir, primero los servicios, y sin las que no valen', () => {
  assert.deepEqual(mergeFollow(['l-renfe-51-R16', 's-renfe-18093'], ['s-renfe-18093', 'l-renfe-Regional_20Expr_C3_A9s', 'roto']),
    ['s-renfe-18093', 'l-renfe-51-R16', 'l-renfe-Regional_20Expr_C3_A9s']);
  assert.deepEqual(followOf('l-tmb-V15', null, undefined, 's-tmb-V15-0abc123-0732'), ['s-tmb-V15-0abc123-0732', 'l-tmb-V15']);
  assert.equal(followOf(null, 'roto'), undefined, 'ninguna: sin lista');
  assert.equal(answersTo(['s-renfe-8058', 'l-renfe-AVE'], 'l-renfe-AVE'), true);
  assert.equal(answersTo(undefined, 'l-renfe-AVE'), false, 'lo guardado por versiones anteriores no trae claves');
});

test('la huella es siempre la misma y de 7 caracteres en base 36', () => {
  assert.equal(shortHash('2354'), shortHash('2354'));
  assert.notEqual(shortHash('2354'), shortHash('2355'));
  assert.match(shortHash(''), /^[0-9a-z]{7}$/);
  assert.match(shortHash('ES:Euskotren:StopPlaceEntrance:2576_Entrada_E'), /^[0-9a-z]{7}$/);
});

test('trayecto: dos estaciones, la franja y los días; reversible, válido para Telegram y sin tocar las demás claves', () => {
  const key = trayectoKey({ origin: '70103', destination: '18000', from: 7 * 60, to: 9 * 60, days: 0x1f });
  assert.equal(key, 't-70103-18000-07000900-1f');
  assert.match(key, TELEGRAM_START);
  assert.equal(followKind(key), 'trayecto');
  assert.deepEqual(parseFollowKey(key), {
    kind: 'trayecto', network: null, parts: ['70103', '18000'], origin: '70103', destination: '18000', from: '07:00', to: '09:00', days: 0x1f,
  });
  assert.equal(describeFollow(key, { originName: 'Alcalá de Henares', destinationName: 'Madrid-Atocha Cercanías' }),
    'Alcalá de Henares → Madrid-Atocha Cercanías (07:00-09:00, de lunes a viernes)');
  // Las estaciones de metro y tranvía llevan su red en el código: también caben (las de códigos más largos del catálogo).
  const long = trayectoKey({ origin: 'metrosevilla:L1-E10', destination: 'metrosevilla:L1-E21', from: 0, to: 24 * 60 - 1, days: ALL_DAYS });
  assert.ok(long.length <= FOLLOW_KEY_MAX && TELEGRAM_START.test(long), long);
  assert.equal(parseFollowKey(long).origin, 'metrosevilla:L1-E10');
  assert.equal(parseFollowKey(long).to, '23:59');
  for (const bad of [
    { origin: '70103', destination: '70103', from: 420, to: 540, days: 1 }, // la misma estación
    { origin: '70103', destination: '18000', from: 540, to: 420, days: 1 }, // franja al revés
    { origin: '70103', destination: '18000', from: 420, to: 24 * 60, days: 1 }, // pasa del día
    { origin: '70103', destination: '18000', from: 420, to: 540, days: 0 }, // ningún día
    { origin: '70103', destination: '18000', from: 420, to: 540, days: 0x80 },
    { origin: '', destination: '18000', from: 420, to: 540, days: 1 },
    { origin: 'x'.repeat(30), destination: 'y'.repeat(30), from: 420, to: 540, days: 1 }, // no cabe en 64
  ]) assert.equal(trayectoKey(bad), null, JSON.stringify(bad));
  for (const bad of ['t-70103-18000-09000700-1f', 't-70103-18000-07000900-00', 't-70103-18000-07000900-80', 't-70103-18000-07602500-1f',
    't-70103-70103-07000900-1f', 't-70103-18000-0700-1f', 't-70103-18000-07000900-1F', 't-7010_3-18000-07000900-1f', 't-70103']) {
    assert.equal(isFollowKey(bad), false, bad);
  }
  assert.deepEqual(mergeFollow([key, 'p-71801', 's-renfe-8058']), ['s-renfe-8058', 'p-71801', key]);
  // Las de antes siguen igual.
  for (const good of ['s-renfe-8058', 'l-metrobilbao', 'p-71801', 'l-renfe-__17cohho', 's-emtmalaga-_-0abc123-0732']) assert.equal(isFollowKey(good), true, good);
  assert.equal(daysText(0x1f), 'de lunes a viernes');
  assert.equal(daysText(0x60), 'sábados y domingos');
  assert.equal(daysText(0x15), 'lunes, miércoles y viernes');
  assert.equal(daysText(0x71), 'de viernes a lunes', 'seguidos pasando del domingo al lunes');
  assert.equal(daysText(0x40), 'los domingos');
  assert.equal(daysText(ALL_DAYS), 'todos los días');
});

test('la forma única de una clave: lo que hacen los constructores, tal cual; otras escrituras de lo mismo, a ella', () => {
  const esc = (s) => [...new TextEncoder().encode(s)].map((b) => `_${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  const built = [stopKey('70103'), stopKey('tmb:P.6660111'), lineKey({ operator: 'EMT Madrid', line: 'L-1' }), lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' }),
    numberedServiceKey({ operator: 'Renfe', number: '08058' }), scheduledServiceKey({ operator: 'Euskotren', line: 'E4', origin: 'stop-matiko', departure: 47400 }),
    lineKey({ operator: 'Autobuses Urbanos de Valladolid AUVASA', line: '1' }), lineKey({ operator: 'Renfe' }),
    trayectoKey({ origin: '70103', destination: '18000', from: 420, to: 540, days: 31 })];
  for (const key of built) assert.equal(canonicalKey(key), key, key);
  assert.equal(canonicalKey(`p-${esc('70103')}`), 'p-70103');
  assert.equal(canonicalKey('s-renfe-08058'), 's-renfe-8058');
  assert.equal(canonicalKey(`s-${esc('renfe')}-8058`), 's-renfe-8058');
  assert.equal(canonicalKey(`l-renfe-${esc('Madrid')}-C4a`), 'l-renfe-Madrid-C4a');
  assert.equal(canonicalKey(`t-${esc('70103')}-18000-07000900-1f`), 't-70103-18000-07000900-1f');
  assert.equal(canonicalKey(`t-70103-${esc('70103')}-07000900-1f`), null, 'el origen y el destino, la misma estación');
  assert.equal(canonicalKey('no-es-una-clave'), null);
});

test('un servicio de un horario con una hora de salida que no existe no es una clave («9999»); pasada la medianoche, sí («2500»)', () => {
  assert.equal(isFollowKey('s-renfe-C1-abc1234-9999'), false);
  assert.equal(isFollowKey('s-renfe-C1-abc1234-0760'), false);
  assert.equal(isFollowKey('s-renfe-C1-abc1234-2500'), true);
  assert.equal(isFollowKey(scheduledServiceKey({ operator: 'Euskotren', line: 'E4', origin: 'x', departure: 25 * 3600 + 59 * 60 })), true);
});
