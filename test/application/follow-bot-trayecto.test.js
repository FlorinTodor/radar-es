// «Mi trayecto» en el bot, sin Telegram: /trayecto (con sus estaciones del catálogo, una lista si hay varias, y
// también escrito sin orden), los avisos de sus trenes en cada ronda (sólo lo nuevo, una vez), /estado y el parte,
// /mis, /dejar y /datos, lo que se guarda, el uso y los topes. Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { lineKey, numberedServiceKey, trayectoKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // martes, 06:00 en Madrid
const CHAT = 1001;
const ST = {
  gu: { code: '70200', name: 'Guadalajara', place: 'Guadalajara', lat: 40.6447, lon: -3.1824 },
  al: { code: '70103', name: 'Alcalá de Henares', place: 'Alcalá De Henares', lat: 40.48908, lon: -3.36625 },
  at: { code: '18000', name: 'Madrid-Atocha Cercanías', place: 'Madrid', lat: 40.40636, lon: -3.68962 },
  pa: { code: '60000', name: 'Madrid-Puerta de Atocha-Almudena Grandes', place: 'Madrid', lat: 40.40644, lon: -3.69089 },
};
const CATALOG = Object.values(ST);
const KEY = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 6 * 60, to: 9 * 60, days: 0x1f });
const NAME = 'Alcalá de Henares → Madrid-Atocha Cercanías (06:00-09:00, de lunes a viernes)';
const C2 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C2' });
const CREDIT = 'Origen de los datos: Renfe Operadora';
const stop = (st, extra = {}) => ({ name: st.name, lat: st.lat, lon: st.lon, time: null, eta: null, passed: false, ...extra });

/** Un Media Distancia con horario: por Alcalá a las 07:10. */
const md = (delay) => ({
  id: 'renfe-ld:18001', source: 'renfe-ld', mode: 'md', operator: 'Renfe', service: 'Media Distancia', line: 'Media Distancia', label: '18001',
  follow: [numberedServiceKey({ operator: 'Renfe', number: '18001' })], lat: 40.7, lon: -3.0, delay, next: 'Guadalajara', stops: true,
});
const MD_STOPS = [stop(ST.gu, { time: '06:50' }), stop(ST.al, { time: '07:10' }), stop(ST.at, { time: '07:40' })];
const cancelled = (id, number, at) => ({
  id, source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', title: `Cercanías C2 ${number} cancelado: Guadalajara → Madrid-Atocha Cercanías`, credit: CREDIT,
  trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C2', number, follow: [numberedServiceKey({ operator: 'Renfe', number }), C2],
    stops: [stop(ST.gu, { time: '06:40' }), stop(ST.al, { time: at }), stop(ST.at, { time: '08:00' })] },
});

function setup({ limits } = {}) {
  let now = T0;
  const world = { vehicles: [], events: [], stops: new Map([['renfe-ld:18001', MD_STOPS]]), stationsAsked: 0 };
  const disk = { value: null };
  const byCode = new Map(CATALOG.map((s) => [s.code, s]));
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, station: (code) => byCode.get(code) ?? null },
    trayectos: {
      stops: (id) => (world.stops.has(id) ? { stops: world.stops.get(id), partial: false } : null),
      stations: () => {
        world.stationsAsked++;
        return CATALOG;
      },
    },
    store: { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } },
    clock: { now: () => now },
    creditOf: (source) => (source.startsWith('renfe') ? CREDIT : null),
    webUrl: 'https://radarespana.es',
    limits,
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  const press = (data, chatId = CHAT) => bot.handle({ chatId, callback: data, callbackId: 'q1' });
  return { bot, world, disk, say, press, tick: (ms = 60_000) => { now += ms; return bot.tick(); } };
}

test('/trayecto: sin nada, cómo se escribe; con un trayecto que sólo puede ser uno, lo sigue y cuenta cómo va', () => {
  const { say, bot, world } = setup();
  assert.match(say('/trayecto')[0].text, /^Dime las dos estaciones, la franja en la que sales y los días:\n\/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V/);
  world.vehicles = [md(3)];
  const [r] = say('/trayecto Alcalá de Henares > Madrid-Atocha Cercanías 6:00-9:00 L-V');
  assert.equal(r.text, `Hecho: te aviso de ${NAME}.\n\nAhora:\nTrenes de tu franja que se ven ahora (hora en Alcalá de Henares):\n`
    + `- 07:10 Media Distancia 18001: circula con 3 min. Próxima parada: Guadalajara.\n\n${CREDIT}\n\n/mis para ver lo que sigues · /dejar para dejar de seguirlo`);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 1 });
  assert.match(say('/trayecto Alcalá de Henares > Madrid-Atocha Cercanías 6-9 laborables')[0].text, /^Ya sigues Alcalá de Henares → Madrid-Atocha Cercanías/,
    'el mismo trayecto escrito de otra forma');
  assert.equal(say('/mis')[0].text, `Sigues:\n\n1. ${NAME}\n\nPara dejar algo: /dejar (o /dejar y su número).`);
  assert.match(say('/datos')[0].text, new RegExp(`Lo que sigues: ${NAME.replace(/[()]/g, '\\$&')}`));
});

test('/trayecto con varias estaciones posibles (dos Atocha): una lista, y el botón lo sigue; escrito sin orden, igual', () => {
  const { say, press, bot } = setup();
  const [r] = say('/trayecto Alcalá de Henares > Atocha 6-9 L-V');
  assert.equal(r.text, 'Hay varias estaciones con esos nombres. ¿Cuál es tu trayecto?');
  assert.deepEqual(r.buttons.map((row) => row[0].text), ['Alcalá de Henares → Madrid-Atocha Cercanías', 'Alcalá de Henares → Madrid-Puerta de Atocha-Almudena Grandes']);
  assert.ok(r.buttons.every((row) => Buffer.byteLength(row[0].data) <= 64));
  const pressed = press(r.buttons[0][0].data);
  assert.equal(pressed.answer, 'Hecho');
  assert.match(pressed.replies[0].text, new RegExp(`^Hecho: te aviso de ${NAME.replace(/[()]/g, '\\$&')}\\.`));
  // Sin orden: «origen > destino franja» es un trayecto, no una búsqueda.
  assert.match(say('Guadalajara > Madrid-Atocha Cercanías 7-8')[0].text, /^Hecho: te aviso de Guadalajara → Madrid-Atocha Cercanías \(07:00-08:00, todos los días\)\./);
  assert.match(say('/seguir Guadalajara > Madrid-Atocha Cercanías 18-20 L-V')[0].text, /^Hecho: te aviso de Guadalajara → Madrid-Atocha Cercanías \(18:00-20:00/,
    'con /seguir, también');
  assert.deepEqual(bot.stats(), { chats: 1, subs: 3 });
});

test('/trayecto: lo que no se entiende o no se encuentra se explica, sin seguir nada', () => {
  const { say, bot } = setup();
  assert.match(say('/trayecto Alcalá de Henares Atocha 7-9')[0].text, /^Separa las dos estaciones con «>»/);
  assert.match(say('/trayecto Alcalá de Henares > Atocha')[0].text, /^Dime también la franja/);
  assert.match(say('/trayecto Alcalá de Henares > Atocha 9-7')[0].text, /^La franja tiene que ir de una hora a otra más tarde/);
  assert.match(say('/trayecto Alcalá de Henares > Atocha 7-9 a veces')[0].text, /^No entiendo los días «a veces»/);
  assert.match(say('/trayecto Narnia > Atocha 7-9')[0].text, /^No encuentro la estación «Narnia» en el catálogo del radar/);
  assert.match(say('/trayecto Guadalajara > Guadalajara 7-9')[0].text, /^El origen y el destino son la misma estación/);
  assert.match(say(`/start ${trayectoKey({ origin: '99999', destination: ST.at.code, from: 420, to: 540, days: 1 })}`)[0].text,
    /^Ese trayecto no lo puedo seguir: alguna de sus estaciones no está en el catálogo/, 'un enlace inventado');
  assert.deepEqual(bot.stats(), { chats: 0, subs: 0 });
});

test('un enlace (/start <clave del trayecto>) lo sigue; cuenta en el tope de cosas por chat y en el uso, sin el número del chat', () => {
  const { say, bot } = setup({ limits: { subsPerChat: 2 } });
  assert.match(say(`/start ${KEY}`)[0].text, new RegExp(`^Hecho: te aviso de ${NAME.replace(/[()]/g, '\\$&')}\\.`));
  say('/provincia Madrid');
  assert.match(say('/trayecto Guadalajara > Madrid-Atocha Cercanías 7-8')[0].text, /^Ya sigues 2 cosas, el máximo/);
  const usage = bot.usage();
  assert.deepEqual(usage.follows, { servicio: 0, linea: 0, parada: 0, trayecto: 1, carretera: 0, provincia: 1 });
  assert.equal(usage.top.some((t) => t.kind === 'trayecto'), false, 'un trayecto es personal: nunca en lo más seguido');
  assert.equal(usage.totals.commands.enlace, 1);
  assert.equal(usage.totals.commands.trayecto, 1);
  assert.doesNotMatch(JSON.stringify(usage), /1001/);
});

test('rondas: avisa una vez de lo nuevo de sus trenes (lo que ya había al seguirlo, no); retraso por escalones', () => {
  const { say, world, tick } = setup();
  world.events = [cancelled('ya-estaba', '21500', '06:57')];
  assert.match(say(`/start ${KEY}`)[0].text, /- 06:57 Cercanías C2 21500: cancelado\./, 'lo que ya había se cuenta al seguirlo');
  assert.deepEqual(tick(), [], 'y no se vuelve a avisar');
  world.events.push(cancelled('nueva', '21516', '07:37'), cancelled('fuera-de-franja', '21530', '09:17'));
  const [msg, ...more] = tick();
  assert.deepEqual(more, []);
  assert.equal(msg.chatId, CHAT);
  assert.equal(msg.text, `${NAME}:\n\nCercanías C2 21516 cancelado: Guadalajara → Madrid-Atocha Cercanías. Pasaba por Alcalá de Henares a las 07:37.\n\n`
    + `${CREDIT}\n\nMás en https://radarespana.es`);
  assert.deepEqual(tick(), [], 'una vez');
  world.vehicles = [md(10)];
  assert.deepEqual(tick(), [], 'menos de 15 min, nada');
  world.vehicles = [md(17)];
  assert.match(tick()[0].text, /Media Distancia 18001, el de las 07:10 en Alcalá de Henares, va con 17 min de retraso\. Próxima parada: Guadalajara\./);
  world.vehicles = [md(22)];
  assert.deepEqual(tick(), [], 'el mismo escalón');
  world.vehicles = [md(33)];
  assert.match(tick()[0].text, /va con 33 min de retraso/, 'empeora: otro aviso');
});

test('/estado y el parte cuentan cómo va el trayecto con lo demás que se sigue; lo guardado se recupera', async () => {
  const { say, world, tick, bot, disk } = setup();
  say(`/start ${KEY}`);
  say('/provincia Madrid');
  world.vehicles = [md(5)];
  world.events = [cancelled('c1', '21516', '07:37')];
  const [estado] = say('/estado');
  assert.match(estado.text, new RegExp(`^${NAME.replace(/[()]/g, '\\$&')}:\nTrenes de tu franja que se ven ahora \\(hora en Alcalá de Henares\\):\n`
    + '- 07:10 Media Distancia 18001: circula con 5 min de retraso\\. Próxima parada: Guadalajara\\.\n- 07:37 Cercanías C2 21516: cancelado\\.'));
  assert.match(estado.text, /\n\nAvisos en Madrid:\n/);
  say('/parte 06:05');
  let parte = [];
  for (let i = 0; i < 6 && !parte.length; i++) parte = tick().filter((r) => r.text.startsWith('Parte'));
  assert.match(parte[0].text, new RegExp(`^Parte de las 06:05:\n\n${NAME.replace(/[()]/g, '\\$&')}:\nTrenes de tu franja`));
  await bot.save({ always: true });
  assert.deepEqual(disk.value.chats[0].subs.map((s) => [s.key, s.name]), [[KEY, NAME]], 'se guarda su clave y su nombre, como lo demás');
  const other = setup();
  other.disk.value = disk.value;
  await other.bot.load();
  assert.equal(other.say('/mis')[0].text.split('\n')[2], `1. ${NAME}`);
  assert.match(say('/dejar 1')[0].text, new RegExp(`^Hecho: ya no te aviso de ${NAME.replace(/[()]/g, '\\$&')}\\.`));
});

test('las paradas de los vehículos se piden como mucho una vez por minuto, y el catálogo de estaciones cada tanto', () => {
  const { say, world, tick } = setup();
  let asked = 0;
  world.stops = { has: () => true, get: () => { asked++; return MD_STOPS; } };
  world.vehicles = [md(3)];
  say(`/start ${KEY}`);
  for (let i = 0; i < 5; i++) say('/estado');
  assert.equal(asked, 1, 'en el mismo minuto, de lo que ya se tiene');
  tick();
  say('/estado');
  assert.equal(asked, 2);
  for (const t of ['Alcalá > Madrid-Atocha Cercanías 6-9', 'Guadalajara > Madrid-Atocha Cercanías 6-9']) say(`/trayecto ${t}`);
  assert.equal(world.stationsAsked, 1);
});

test('si fallan las paradas de un viaje, ese tren no cuenta y la ronda de todos sigue (se apunta en el registro)', () => {
  const warned = [];
  let now = T0;
  const byCode = new Map(CATALOG.map((s) => [s.code, s]));
  const world = { vehicles: [md(0), { ...md(0), id: 'roto', follow: [] }] };
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => [], station: (code) => byCode.get(code) ?? null },
    trayectos: {
      stops: (id) => {
        if (id === 'roto') throw new Error('fichero de paradas roto');
        return { stops: MD_STOPS };
      },
      stations: () => CATALOG,
    },
    store: { load: async () => null, save: async () => {} },
    clock: { now: () => now },
    creditOf: () => CREDIT,
    webUrl: 'https://radarespana.es',
    log: { info() {}, warn: (m) => warned.push(m), error() {} },
  });
  assert.match(bot.handle({ chatId: CHAT, text: `/start ${KEY}` }).replies[0].text, /^Hecho: te aviso de /);
  now += 60_000;
  bot.tick();
  world.vehicles = [md(20), { ...md(20), id: 'roto', follow: [] }];
  now += 60_000;
  const out = bot.tick();
  assert.equal(out.length, 1);
  assert.match(out[0].text, /Media Distancia 18001, el de las 07:10 en Alcalá de Henares, va con 20 min de retraso/);
  assert.equal(warned.length, 1, 'una vez, no por cada vehículo ni cada ronda');
  assert.match(warned[0], /paradas de un viaje: fichero de paradas roto/);
});

test('lo mismo no llega dos veces en la misma ronda: el retraso de un tren seguido también en un trayecto; la misma cancelación en dos trayectos', () => {
  const { say, world, tick } = setup();
  const SERVICE = numberedServiceKey({ operator: 'Renfe', number: '18001' });
  const OTHER = trayectoKey({ origin: ST.al.code, destination: ST.at.code, from: 7 * 60, to: 8 * 60, days: 0x7f });
  world.vehicles = [md(0)];
  say(`/start ${KEY}`);
  say(`/start ${SERVICE}`);
  say(`/start ${OTHER}`);
  tick();
  world.vehicles = [md(20)];
  world.events = [cancelled('c1', '21516', '07:37')];
  const out = tick();
  const all = out.map((m) => m.text).join('\n----\n');
  assert.equal(all.match(/va con 20 min de retraso/g).length, 1, all);
  assert.equal(all.match(/Cercanías C2 21516 cancelado/g).length, 1, all);
  assert.match(out[0].text, new RegExp(`^${NAME.replace(/[()]/g, '\\$&')}:`), 'en lo primero que sigue');
});

test('un trayecto que ningún tren que se ve une: se sigue, pero se dice; con un tren que lo une, no', () => {
  const { say, world } = setup();
  const [lonely] = say('/trayecto Guadalajara > Alcalá de Henares 6-9');
  assert.match(lonely.text, /^Hecho: te aviso de Guadalajara → Alcalá de Henares/);
  assert.match(lonely.text, /Ahora no veo ningún tren que vaya de Guadalajara a Alcalá de Henares: si no hay trenes directos entre ellas, no te llegará nada; comprueba las estaciones\./);
  world.vehicles = [md(0)];
  const [ok] = say('/trayecto Alcalá de Henares > Madrid-Atocha Cercanías 6-9');
  assert.doesNotMatch(ok.text, /no veo ningún tren/);
});

test('/parte con la hora sola («7», «7h») y, sin seguir nada, la hora mal escrita se dice antes', () => {
  const { say } = setup();
  assert.match(say('/parte 7', 5)[0].text, /^Primero sigue algo/);
  assert.match(say('/parte 123', 5)[0].text, /^Dime la hora, en hora peninsular/, 'mal escrita: eso primero');
  assert.match(say('/parte 25:00', 5)[0].text, /^Dime la hora/);
  say(`/start ${KEY}`);
  assert.match(say('/parte 7')[0].text, /^Hecho: cada día a las 07:00 \(hora peninsular\)/);
  assert.match(say('/parte 8h')[0].text, /a las 08:00/);
  assert.match(say('/summary 7pm')[0].text, /at 19:00/, 'en inglés, también');
});

test('claves de enlace: la misma cosa escrita de otra forma es la misma; un trayecto por enlace, con lo que comprueba /trayecto', async () => {
  const { say, bot, disk } = setup();
  const esc = (s) => [...new TextEncoder().encode(s)].map((b) => `_${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  assert.match(say(`/start ${KEY}`)[0].text, /^Hecho: te aviso de /);
  const same = KEY.replace(`t-${ST.al.code}-`, `t-${esc(ST.al.code)}-`);
  assert.notEqual(same, KEY);
  assert.match(say(`/start ${same}`)[0].text, /^Ya sigues /, 'escrita de otra forma: la misma');
  assert.match(say('/start p-70103')[0].text, /^Hecho: te aviso de Estación Alcalá de Henares/);
  assert.match(say(`/start p-${esc('70103')}`)[0].text, /^Ya sigues Estación Alcalá de Henares/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 2 });
  // Origen y destino, la misma estación escrita de dos formas; o de redes distintas: no se sigue.
  assert.match(say(`/start t-${ST.al.code}-${esc(ST.al.code)}-07000900-1f`, 2)[0].text, /^Eso no es algo que se pueda seguir/);
  const otherNet = { code: 'tmb:P.1', name: 'Pinar', place: null, lat: 41.4, lon: 2.1, network: 'Metro de Barcelona (TMB)', networkId: 'tmb' };
  CATALOG.push(otherNet);
  try {
    const { say: say2 } = setup();
    assert.match(say2(`/start t-${ST.al.code}-tmb_3AP_2E1-07000900-1f`, 3)[0].text, /^Alcalá de Henares y Pinar · Metro de Barcelona \(TMB\) no son de la misma red/);
  } finally {
    CATALOG.pop();
  }
  // Lo guardado con dos formas de la misma clave: una.
  await bot.save({ always: true });
  disk.value.chats[0].subs.push({ ...disk.value.chats[0].subs[0], key: same });
  const b = setup();
  b.disk.value = disk.value;
  await b.bot.load();
  assert.deepEqual(b.bot.stats(), { chats: 1, subs: 2 });
});

test('/start t-… y /estado t-… no rehacen el directorio (un trayecto nunca está en él)', () => {
  const { say, world } = setup();
  let reads = 0;
  // Sólo el directorio mira de dónde viene cada vehículo (para nombrarlo).
  const counted = { id: 'v', mode: 'bus', operator: 'X', line: '1', follow: ['l-x-1'], delay: 0, get origin() { reads++; return 'A'; } };
  world.vehicles = [counted];
  say('/start p-70103'); // la primera vez se rehace (aún no se ha hecho nunca)
  reads = 0;
  say(`/start ${KEY}`);
  say(`/estado ${KEY}`);
  assert.equal(reads, 0, 'antes se recorrían todos los vehículos cada vez');
  say('/start s-renfe-99999');
  assert.ok(reads > 0, 'lo que sí puede estar en él, sí');
});

test('entradas raras: «<b>hola</b>» no es un trayecto; un enlace con una hora que no existe; una franja con horas que no lo son', () => {
  const { say } = setup();
  assert.doesNotMatch(say('/seguir <b>hola</b>')[0].text, /estaciones|Separa/, 'se busca como texto, no como trayecto');
  assert.match(say('/seguir Alcalá de Henares > Madrid-Atocha Cercanías 7-9')[0].text, /^Hecho: te aviso de Alcalá de Henares → Madrid-Atocha Cercanías/);
  assert.match(say('/start s-renfe-C1-abc-9999', 2)[0].text, /^Hola\. Soy el bot/, 'no es una clave (antes: «el de las 99:99»)');
  assert.match(say('/start s-renfe-C1-abc1234-2500', 3)[0].text, /^Hecho: te aviso de /, 'pasada la medianoche de su horario (25:00), sí');
  assert.match(say('/trayecto Alcalá de Henares > Atocha 99-100')[0].text, /^La franja tiene que ir de una hora a otra más tarde/);
});
