// El bot «Sigue tu tren», sin Telegram: seguir (por enlace, buscando o con botones), dejar, borrar, ver lo que
// guarda, el parte diario, los topes y las rondas de avisos (sólo lo nuevo, una vez). Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';
import { MAX_MESSAGES, SEEN_MAX } from '../../server/domain/seguidos/avisos.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // 06:00 en Madrid
const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const C4A = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' });
const C4B = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4b' });
const EMT27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const CHAT = 1001;

function setup({ limits } = {}) {
  let now = T0;
  const world = {
    vehicles: [
      { id: 'renfe-ld:08058', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058', delay: 2,
        origin: 'Valladolid-Campo Grande', destination: 'Madrid-Chamartín-Clara Campoamor', follow: [AVANT, AVANT_LINE] },
      { id: 'c4a', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C4a', label: '27100', delay: 0,
        origin: 'Alcobendas', destination: 'Parla', follow: [numberedServiceKey({ operator: 'Renfe', number: '27100' }), C4A] },
      { id: 'c4b', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C4b', label: '27200', delay: 0,
        origin: 'Colmenar Viejo', destination: 'Parla', follow: [numberedServiceKey({ operator: 'Renfe', number: '27200' }), C4B] },
      { id: 'emt-malaga:661', source: 'emt-malaga', mode: 'bus', operator: 'EMT Málaga', line: '27', label: '661', delay: null, follow: [EMT27] },
    ],
    events: [],
  };
  const disk = { value: null, saves: 0 };
  const store = { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); disk.saves++; } };
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, station: (code) => (code === '10600' ? { code, name: 'Valladolid-Campo Grande', lat: 41.64, lon: -4.73 } : null) },
    store,
    clock: { now: () => now },
    creditOf: (source) => (source.startsWith('renfe') ? 'Origen de los datos: Renfe Operadora' : null),
    webUrl: 'https://radarespana.es',
    limits,
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  const press = (data, chatId = CHAT) => bot.handle({ chatId, callback: data, callbackId: 'q1' });
  return { bot, world, disk, say, press, tick: (ms = 60_000) => { now += ms; return bot.tick(); }, at: () => now };
}

const cancellation = (over = {}) => ({
  id: 'renfe-cancelado:ld:08058', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado',
  title: 'Avant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor', credit: 'Origen de los datos: Renfe Operadora',
  trip: { operator: 'Renfe', mode: 'av', service: 'Avant', number: '08058', follow: [AVANT, AVANT_LINE],
    stops: [{ name: 'Valladolid-Campo Grande', time: '06:23', lat: 41.64, lon: -4.73 }, { name: 'Madrid-Chamartín-Clara Campoamor', time: '07:24' }] },
  ...over,
});

test('enlace de la web (/start <clave>): sigue directamente y cuenta cómo va', () => {
  const { say, bot } = setup();
  const [r] = say(`/start ${AVANT}`);
  assert.match(r.text, /^Hecho: te aviso de Avant 08058\.\n\nAhora:\nAvant 08058: circula con 2 min, de Valladolid-Campo Grande a Madrid-Chamartín-Clara Campoamor\./);
  assert.match(r.text, /Origen de los datos: Renfe Operadora/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 1 });
  assert.match(say(`/start ${AVANT}`)[0].text, /^Ya sigues Avant 08058/);
  assert.match(say('/start')[0].text, /^Hola\. Soy el bot de Radar España/);
  assert.match(say('/start no-es-una-clave')[0].text, /^Hola/);
  assert.match(say(`/start ${numberedServiceKey({ operator: 'Renfe', number: '25535' })}`)[0].text, /^Hecho: te aviso de Renfe 25535\./,
    'un enlace a algo que ahora no se ve: el nombre, de su clave');
});

test('buscar: uno, varios con botones (y el botón sigue), nada; texto sin orden pregunta antes', () => {
  const { say, press, bot } = setup();
  assert.match(say('/seguir 08058')[0].text, /^Hecho: te aviso de Avant 08058/);
  const [many] = say('/seguir C4');
  assert.equal(many.text, 'He encontrado varias cosas. ¿Cuál quieres seguir?');
  const data = many.buttons.map((row) => row[0].data);
  assert.match(data[0], /^a:[0-9a-z]{1,8}:0$/, 'cada botón dice de qué lista es');
  assert.equal(data[1], data[0].replace(/:0$/, ':1'));
  assert.ok(data.every((d) => Buffer.byteLength(d) <= 64), 'el tope de Telegram para callback_data');
  assert.match(many.buttons[0][0].text, /^Cercanías C4a · Renfe \(Madrid\) \(Alcobendas – Parla\)$/);
  const pressed = press(data[1]);
  assert.equal(pressed.answer, 'Hecho');
  assert.match(pressed.replies[0].text, /^Hecho: te aviso de Cercanías C4b · Renfe \(Madrid\)\./);
  assert.match(press(data[0]).replies[0].text, /^Esa lista ya no vale/, 'cada lista se usa una vez');
  const [ask] = say('27 EMT Málaga');
  assert.equal(ask.text, '¿Quieres seguir esto?');
  assert.match(press(ask.buttons[0][0].data).replies[0].text, /^Hecho: te aviso de Autobús 27 · EMT Málaga/);
  assert.match(say('/seguir tranvía de la luna')[0].text, /^No encuentro nada así/);
  assert.match(say('/seguir')[0].text, /^Dime qué quieres seguir/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 3 });
});

test('provincias: por su nombre (también buscando), una vez, con tope', () => {
  const { say, bot } = setup({ limits: { provincesPerChat: 2 } });
  assert.match(say('/provincia València')[0].text, /^Hecho: te aviso en Valencia de los avisos naranja y rojo de AEMET/);
  assert.match(say('/provincia valencia')[0].text, /^Ya sigues los avisos de Valencia/);
  assert.match(say('/seguir Soria')[0].text, /^Hecho: te aviso en Soria/, 'si no hay líneas, una provincia');
  assert.match(say('/provincia Cádiz')[0].text, /^Ya sigues 2 provincias, el máximo/);
  assert.match(say('/provincia Atlántida')[0].text, /^No conozco la provincia «Atlántida»/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 2 });
});

test('/mis, /dejar (con número, por nombre y con botones), /datos y /baja; quien no sigue nada no queda guardado', () => {
  const { say, press, bot } = setup();
  say(`/start ${AVANT}`);
  say('/provincia Valencia');
  assert.equal(say('/mis')[0].text, 'Sigues:\n\n1. Avant 08058\n2. Avisos en Valencia\n\nPara dejar algo: /dejar (o /dejar y su número).');
  const data = say('/datos')[0].text;
  assert.match(data, /^Esto es todo lo que guardo de este chat:\n- Número del chat: 1001\n/);
  assert.match(data, /Lo que sigues: Avant 08058/);
  assert.match(data, /Provincias: Valencia/);
  assert.match(say('/dejar 2')[0].text, /^Hecho: ya no te mando los avisos de Valencia\.$/);
  const [menu] = say('/dejar');
  assert.deepEqual(menu.buttons.map((row) => row[0].text), ['Avant 08058']);
  assert.match(press(menu.buttons[0][0].data).replies[0].text, /^Hecho: ya no te aviso de Avant 08058\. No sigues nada más, así que no guardo nada de este chat\.$/);
  assert.deepEqual(bot.stats(), { chats: 0, subs: 0 });
  assert.match(say('/datos')[0].text, /^De este chat no guardo nada/);
  say(`/start ${AVANT}`);
  assert.match(say('/dejar avant')[0].text, /^Hecho: ya no te aviso de Avant 08058/);
  say(`/start ${AVANT}`);
  assert.match(say('/baja')[0].text, /^Hecho: he borrado todo lo de este chat/);
  assert.match(say('/baja')[0].text, /^De este chat no tenía nada guardado/);
});

test('uso para las métricas: altas, bajas (dejar, /baja, bloqueo), órdenes, avisos y partes, sin el número del chat', () => {
  const { say, press, bot, world, tick } = setup();
  const totals = () => bot.usage().totals;
  say(`/start ${AVANT}`);
  say('/provincia Valencia', 2002);
  say('/parte 06:05', 2002);
  assert.deepEqual(bot.usage(), {
    chats: 2, digest: 1, follows: { servicio: 1, linea: 0, parada: 0, trayecto: 0, carretera: 0, provincia: 1 },
    distinct: { servicio: 1, linea: 0, parada: 0, trayecto: 0, carretera: 0, provincia: 1 },
    top: [], // lo que sigue una sola persona no sale en lo más seguido
    totals: { since: T0, added: 2, removed: { dejar: 0, baja: 0, bloqueo: 0 }, notices: { aviso: 0, parte: 0 }, commands: { enlace: 1, provincia: 1, parte: 1 } },
  });
  say('/start');
  say('hola');
  say('/inventada');
  assert.deepEqual(totals().commands, { enlace: 1, provincia: 1, parte: 1, start: 1, buscar: 1, desconocida: 1 });
  world.events = [cancellation()];
  const out = [];
  for (let i = 0; i < 5; i++) out.push(...tick());
  assert.equal(out.length, 2);
  assert.deepEqual(totals().notices, { aviso: 1, parte: 1 });
  const [menu] = say('/dejar');
  press(menu.buttons[0][0].data);
  say('/baja', 2002);
  say('/baja', 2002);
  say(`/start ${AVANT}`, 3003);
  bot.forget(3003);
  bot.forget(3003);
  assert.equal(totals().added, 3);
  assert.deepEqual(totals().removed, { dejar: 1, baja: 1, bloqueo: 1 }, 'la segunda /baja y el segundo bloqueo no tenían nada que borrar');
  for (let i = 0; i < 22; i++) say('/mis', 4004);
  assert.equal(totals().commands.limite, 2, 'lo que pasa del tope por minuto, aparte');
  assert.equal(totals().commands.boton, 1);
  assert.equal(bot.usage().chats, 0);
  assert.doesNotMatch(JSON.stringify(bot.usage()), /1001|2002|3003|4004/);
});

test('los totales no se pierden al arrancar ni en un relevo: se guardan con lo demás y siguen contando', async () => {
  const a = setup();
  a.say(`/start ${AVANT}`);
  a.say('/provincia Valencia', 2002);
  a.say('/baja', 2002);
  await a.bot.save({ always: true });
  assert.deepEqual(a.disk.value.totals, a.bot.usage().totals);
  // Otro servidor (o el mismo, tras reiniciarse) con el mismo disco, una hora después.
  const b = setup();
  b.disk.value = a.disk.value;
  assert.equal(b.bot.usage().totals.added, 0, 'antes de cargar, nada');
  await b.bot.load();
  assert.deepEqual(b.bot.usage().totals, a.bot.usage().totals);
  b.say(`/start ${C4A}`, 5005);
  assert.equal(b.bot.usage().totals.added, 3);
  assert.equal(b.bot.usage().totals.since, T0, 'cuenta desde la primera vez, no desde el arranque');
  // Un fichero de antes (sin totales) empieza a contar al cargarlo; lo que llegue mal se descarta.
  const c = setup();
  c.disk.value = { ...structuredClone(a.disk.value), totals: { since: 'ayer', added: -4, removed: { baja: 2.5 }, commands: { mis: 3, 'no vale': 9 } } };
  await c.bot.load();
  assert.deepEqual(c.bot.usage().totals, { since: T0, added: 0, removed: { dejar: 0, baja: 0, bloqueo: 0 }, notices: { aviso: 0, parte: 0 }, commands: { mis: 3 } });
  // Un fichero de antes de los totales (el de producción hasta esta versión): quienes ya siguen algo son altas,
  // desde la primera de ellas.
  const d = setup();
  d.tick(3 * 3600_000);
  const { totals: _, ...old } = structuredClone(a.disk.value);
  d.disk.value = old;
  await d.bot.load();
  assert.deepEqual(d.bot.usage().totals, { ...emptyAt(T0), added: 1 });
  await d.bot.save({ force: true });
  assert.equal(d.disk.value.totals.added, 1, 'y se guarda');
});

const emptyAt = (since) => ({ since, added: 0, removed: { dejar: 0, baja: 0, bloqueo: 0 }, notices: { aviso: 0, parte: 0 }, commands: {} });

test('topes: cosas por chat y chats en total', () => {
  const { say } = setup({ limits: { subsPerChat: 2, chats: 1 } });
  say(`/start ${AVANT}`);
  say(`/start ${C4A}`);
  assert.match(say(`/start ${C4B}`)[0].text, /^Ya sigues 2 cosas, el máximo/);
  assert.match(say(`/start ${C4B}`, 2002)[0].text, /^Ahora mismo no puedo atender a más gente/);
});

test('rondas: avisa una vez de lo nuevo; lo que ya había al seguirlo, no; retraso por escalones', () => {
  const { say, world, tick } = setup();
  world.events = [cancellation({ id: 'ya-estaba' })];
  assert.match(say(`/start ${AVANT}`)[0].text, /Avant 08058 cancelado/, 'lo que ya había se cuenta al seguirlo');
  assert.deepEqual(tick(), [], 'y no se vuelve a avisar');
  world.events.push(cancellation());
  const [msg] = tick();
  assert.equal(msg.chatId, CHAT);
  assert.equal(msg.text, 'Avant 08058:\n\nAvant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor.\n\n'
    + 'Origen de los datos: Renfe Operadora\n\nMás en https://radarespana.es');
  assert.deepEqual(tick(), [], 'una vez');
  world.vehicles[0].delay = 17;
  assert.match(tick()[0].text, /Avant 08058 va con 17 min de retraso/);
  world.vehicles[0].delay = 20;
  assert.deepEqual(tick(), [], 'el mismo escalón');
  world.vehicles[0].delay = 33;
  assert.match(tick()[0].text, /va con 33 min de retraso/, 'empeora: otro aviso');
});

test('rondas: una parada seguida se entera de las cancelaciones que pasaban por ella; una provincia, de sus avisos', () => {
  const { say, world, tick } = setup();
  say(`/start ${stopKey('10600')}`);
  say('/provincia Valencia');
  world.events = [cancellation(), { id: 'aemet:1', source: 'aemet-avisos', category: 'meteo', level: 'rojo', title: 'Aviso rojo por lluvias · Litoral sur de Valencia', lat: 39.0, lon: -0.2, issued: T0, start: T0, end: T0 + 3600_000 }];
  const out = tick();
  assert.equal(out.length, 2);
  assert.match(out[0].text, /^Estación Valladolid-Campo Grande:\n\nAvant 08058 cancelado.*Por esta estación pasaba a las 06:23\./s);
  assert.match(out[1].text, /^Avisos en Valencia:\n\nAviso rojo por lluvias/);
});

test('parte diario: a su hora, una vez al día; si hoy ya pasó, desde mañana', () => {
  const { say, tick, at } = setup();
  say(`/start ${AVANT}`);
  assert.match(say('/parte 06:05')[0].text, /^Hecho: cada día a las 06:05/);
  assert.deepEqual(tick(), [], '06:01');
  const day = [];
  for (let i = 0; i < 5; i++) day.push(...tick()); // 06:02 … 06:06
  assert.equal(day.length, 1);
  assert.match(day[0].text, /^Parte de las 06:05:\n\nAvant 08058:\nAvant 08058: circula con 2 min/);
  assert.match(say('/parte 05:00')[0].text, /^Hecho/);
  assert.deepEqual(tick(), [], 'las 05:00 ya han pasado hoy');
  assert.equal(new Date(at()).getUTCHours(), 5);
  assert.match(say('/parte no')[0].text, /ya no te mando el parte/);
  assert.match(say('/parte mañana')[0].text, /^Dime la hora/);
});

test('se guarda y se recupera tal cual (otro servidor, el mismo disco); lo que llega mal del disco se descarta', async () => {
  const a = setup();
  a.say(`/start ${AVANT}`);
  a.say('/provincia Valencia');
  a.say('/parte 07:00');
  a.bot.setOffset(42);
  assert.equal(await a.bot.save(), true);
  assert.equal(await a.bot.save(), false, 'sin cambios no se escribe');
  const saved = a.disk.value;
  saved.chats.push({ id: 'no-es-un-numero', subs: [{ key: AVANT, name: 'x' }] }, { id: 7, subs: [{ key: 'no-es-una-clave', name: 'x' }] });
  const b = setup();
  b.disk.value = saved;
  assert.equal(await b.bot.load(), 1);
  assert.equal(b.bot.offset, 42);
  assert.equal(b.say('/mis')[0].text, 'Sigues:\n\n1. Avant 08058\n2. Avisos en Valencia\n\nParte diario: a las 07:00.\n\nPara dejar algo: /dejar (o /dejar y su número).');
  a.world.events = [cancellation()];
  b.world.events = [cancellation()];
  assert.equal(a.tick().length, 1);
  assert.equal(await a.bot.save(), true);
  const c = setup();
  c.disk.value = a.disk.value;
  await c.bot.load();
  c.world.events = [cancellation()];
  assert.deepEqual(c.tick(120_000), [], 'lo ya avisado no se repite tras un relevo');
});

test('lo que no es de un chat válido, o un botón inventado, no hace nada', () => {
  const { bot, press } = setup();
  assert.deepEqual(bot.handle({ chatId: 'x', text: '/baja' }), { replies: [] });
  assert.deepEqual(bot.handle(null), { replies: [] });
  assert.match(press('a:99').replies[0].text, /^Esa lista ya no vale/);
  assert.match(press('zzz').replies[0].text, /^Esa lista ya no vale/);
  assert.match(bot.handle({ chatId: CHAT, text: '/inventada' }).replies[0].text, /^No conozco esa orden/);
});

test('un chat que bloquea el bot se olvida', () => {
  const { say, bot } = setup();
  say(`/start ${AVANT}`);
  bot.forget(CHAT);
  assert.deepEqual(bot.stats(), { chats: 0, subs: 0 });
});

test('una inundación de mensajes de un chat: se avisa una vez y lo demás de ese minuto se ignora', () => {
  const { say } = setup({ limits: { messagesPerMinute: 3 } });
  for (let i = 0; i < 3; i++) assert.equal(say('/ayuda').length, 1);
  assert.match(say('/ayuda')[0].text, /^Demasiados mensajes seguidos/);
  assert.deepEqual(say('/ayuda'), []);
  assert.equal(say('/ayuda', 2002).length, 1, 'los demás chats, igual');
});

test('un botón de una lista anterior no escoge nada de la última (cada lista lleva su id)', () => {
  const { say, press, bot } = setup();
  const [first] = say('/seguir C4');
  const [second] = say('27 EMT Málaga');
  const old = first.buttons[0][0].data;
  assert.notEqual(old.split(':')[1], second.buttons[0][0].data.split(':')[1]);
  const r = press(old);
  assert.equal(r.answer, 'Lista caducada');
  assert.match(r.replies[0].text, /^Esa lista ya no vale: es de antes/);
  assert.deepEqual(bot.stats(), { chats: 0, subs: 0 }, 'no sigue lo que estaba en ese puesto de la lista nueva');
  assert.match(press('a:0').replies[0].text, /^Esa lista ya no vale/, 'el formato de antes del cambio, tampoco');
  assert.match(press(second.buttons[0][0].data).replies[0].text, /^Hecho: te aviso de Autobús 27 · EMT Málaga/, 'la última, sí');
});

test('/dejar con un número que no está en la lista: lo dice y no busca esa cifra en los nombres', () => {
  const { say, press, bot } = setup();
  say(`/start ${AVANT}`);
  say(`/start ${C4A}`);
  say('/provincia Valencia');
  for (const n of ['4', '0', '58', '-1', '1.5']) {
    const [r] = say(`/dejar ${n}`);
    assert.match(r.text, new RegExp(`^En tu lista no hay un ${n.replace('.', '\\.')}: va del 1 al 3\\. ¿Qué quieres dejar de seguir\\?$`));
    assert.equal(r.buttons.length, 3);
  }
  assert.deepEqual(bot.stats(), { chats: 1, subs: 3 }, 'no ha dejado nada («Avant 08058» tiene un 0, un 5 y un 8)');
  assert.match(say('/dejar 1')[0].text, /^Hecho: ya no te aviso de Avant 08058/);
  const [menu] = say('/dejar 9');
  assert.match(press(menu.buttons[1][0].data).replies[0].text, /^Hecho: ya no te mando los avisos de Valencia/);
  assert.match(say('/dejar 3')[0].text, /^En tu lista no hay un 3: sólo tiene el 1\./);
});

test('/estado y el parte: cada cosa entera, en varios mensajes si hace falta; y si ni así cabe, cuántas quedan fuera', () => {
  const { say, world, tick } = setup();
  // 20 líneas con un aviso largo cada una: ~1.000 caracteres por cosa, más de 3.800 entre todas.
  const lines = Array.from({ length: 20 }, (_, i) => lineKey({ operator: 'EMT Málaga', line: String(100 + i) }));
  world.vehicles.push(...lines.map((k, i) => ({ id: `emt:${i}`, source: 'emt-malaga', mode: 'bus', operator: 'EMT Málaga', line: String(100 + i), delay: null, follow: [k] })));
  const notice = (k, i, j) => ({ id: `aviso:${i}:${j}`, source: 'emt-malaga', category: 'urbano', type: 'aviso', title: `Aviso ${j} línea ${100 + i}`,
    description: `Desvío por obras. ${'Texto del aviso. '.repeat(60)}`, follow: [k], credit: `Fuente ${i}.${j}: ${'atribución larga '.repeat(18)}` });
  world.events = lines.flatMap((k, i) => [notice(k, i, 1), notice(k, i, 2)]);
  for (const k of lines.slice(0, 6)) say(`/start ${k}`);
  const six = say('/estado');
  assert.ok(six.length >= 2, 'más de un mensaje');
  assert.ok(six.every((r) => r.text.length <= 3800));
  assert.deepEqual(six.map((r) => r.text).join('\n\n').match(/^Autobús \d+ · EMT Málaga:/gm).length, 6, 'las seis, enteras');
  assert.match(six.at(-1).text, /Más en https:\/\/radarespana\.es$/);
  assert.ok(!six.some((r) => /…$/.test(r.text)), 'nada cortado a media frase');
  tick(); // un minuto: no es una inundación
  for (const k of lines.slice(6)) say(`/start ${k}`);
  const all = say('/estado');
  assert.equal(all.length, MAX_MESSAGES, 'como mucho MAX_MESSAGES mensajes');
  const shown = all.map((r) => r.text).join('\n\n').match(/^Autobús \d+ · EMT Málaga:/gm).length;
  assert.match(all.at(-1).text, new RegExp(`…y ${20 - shown} cosas más que no caben aquí: pídelas con /estado y su nombre`));
  say('/parte 06:30');
  let parte = [];
  for (let i = 0; i < 40 && !parte.length; i++) parte = tick();
  assert.equal(parte.length, MAX_MESSAGES, 'el parte, también en varios mensajes');
  assert.match(parte[0].text, /^Parte de las 06:30:\n\nAutobús 100 · EMT Málaga:/);
  assert.ok(parte.every((r) => r.text.length <= 3800));
  assert.match(parte.at(-1).text, /…y \d+ cosas más que no caben aquí[^]*Más en https:\/\/radarespana\.es$/);
  assert.deepEqual(tick(), [], 'una vez');
});

test('estaciones: una que no está en el catálogo no se sigue; en una que sí, las retiradas no cuentan como canceladas', () => {
  const { say, world } = setup();
  assert.match(say(`/start ${stopKey('00000')}`)[0].text, /^Esa estación no la encuentro en el catálogo del radar/);
  assert.match(say('/mis')[0].text, /^No sigues nada/);
  world.events = [cancellation(), cancellation({ id: 'retirada', withdrawn: T0 - 60_000, title: 'Avant 08060 cancelado: Valladolid-Campo Grande 06:50 → Madrid' })];
  const [r] = say(`/start ${stopKey('10600')}`);
  assert.match(r.text, /^Hecho: te aviso de Estación Valladolid-Campo Grande\.\n\nAhora:\nPasaban hoy por Valladolid-Campo Grande y están cancelados o con paradas suprimidas: 1\.\n- Avant 08058/);
  assert.match(r.text, /Además, 1 que se había cancelado y su operador ya no publica: puede que al final circule\./);
});

test('claves inventadas o de lo que ahora no se ve: nombre sin el texto de la clave; se renueva al verse', async () => {
  const { say, world, tick, bot, disk } = setup();
  const [injected] = say('/start l-renfe-_0A_0AHecho_3A_20baja');
  assert.equal(injected.text.split('\n')[0], 'Hecho: te aviso de una línea de Renfe.', 'ni saltos de línea ni el texto de la clave');
  assert.match(say('/start s-noexiste-1')[0].text, /^Hecho: te aviso de ese servicio \(ahora no se ve\)\./);
  const C10 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C10' });
  assert.match(say(`/start ${C10}`)[0].text, /^Hecho: te aviso de Línea C10 · Renfe \(Madrid\)\./, 'operador y ámbito conocidos');
  // Cuando se ve, su nombre de verdad
  world.vehicles.push({ id: 'c10', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C10', label: '29001', delay: 0,
    origin: 'Villalba', destination: 'Fuente de la Mora', follow: [numberedServiceKey({ operator: 'Renfe', number: '29001' }), C10] });
  tick(6 * 60_000);
  assert.match(say('/mis')[0].text, /\n3\. Cercanías C10 · Renfe \(Madrid\)\n/);
  // Lo provisional se guarda como tal: tras un reinicio, también se renueva.
  const EMT31 = lineKey({ operator: 'EMT Málaga', line: '31' });
  assert.match(say(`/start ${EMT31}`)[0].text, /^Hecho: te aviso de Línea 31 · EMT Málaga\./);
  await bot.save();
  assert.equal(disk.value.chats[0].subs.find((x) => x.key === EMT31).guessed, true);
  await bot.load();
  world.vehicles.push({ id: 'emt:31', source: 'emt-malaga', mode: 'bus', operator: 'EMT Málaga', line: '31', delay: null, follow: [EMT31] });
  tick(6 * 60_000);
  assert.match(say('/mis')[0].text, /\n4\. Autobús 31 · EMT Málaga\n/);
  await bot.save();
  assert.equal(disk.value.chats[0].subs.find((x) => x.key === EMT31).guessed, undefined, 'ya no es provisional');
});

test('rondas: un retraso que mejora no se avisa (lo seguía ya tarde); si empeora, sí', () => {
  const { say, world, tick } = setup();
  world.vehicles[0].delay = 50;
  say(`/start ${AVANT}`);
  for (const d of [35, 20, 16, 50]) {
    world.vehicles[0].delay = d;
    assert.deepEqual(tick(), [], `${d} min`);
  }
  world.vehicles[0].delay = 61;
  assert.match(tick()[0].text, /va con 61 min de retraso/);
});

test('charla y búsquedas ambiguas: «hola» no busca; con más de las que caben, se dice cuántas hay', () => {
  const { say, world } = setup();
  world.vehicles.push({ id: 'h', mode: 'bus', operator: 'Vectalia', line: '09', origin: 'Naciones-Holanda', follow: [lineKey({ operator: 'Vectalia', line: '09' })] });
  for (const t of ['Hola', 'hola!', 'vale', 'Gracias']) {
    const [r] = say(t);
    assert.ok(!r.buttons, t);
    assert.match(r.text, /Dime qué quieres seguir|Si quieres seguir algo más/);
  }
  assert.match(say('ayuda')[0].text, /^Te aviso de lo que sigas/);
  world.vehicles.push(...Array.from({ length: 10 }, (_, i) => ({ id: `b${i}`, mode: 'bus', operator: `Bus ${i}`, line: 'C4a', follow: [lineKey({ operator: `Bus ${i}`, line: 'C4a' })] })));
  const [r] = say('/seguir C4a');
  assert.match(r.text, /^He encontrado 11; aquí van las 8 primeras\. Si no está la que buscas, añade la ciudad o el operador/);
  assert.equal(r.buttons[0][0].text.split(' (')[0], 'Cercanías C4a · Renfe', 'a igual encaje, los trenes primero');
});

test('lo recordado de lo avisado, al cargarlo: lo de la última ronda guardada entero aunque pase del tope; lo de antes, hasta el tope', async () => {
  const a = setup();
  const last = T0 - 60_000;
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => [`${AVANT}|viejo-${i}`, last - 3600_000, last - 3600_000]),
    ...Array.from({ length: SEEN_MAX + 5 }, (_, i) => [`${AVANT}|hecho-${i}`, last, last]),
  ];
  a.disk.value = { version: 1, offset: 0, chats: [{ id: CHAT, since: T0, subs: [{ key: AVANT, name: 'Avant 08058', since: T0, checkedAt: last }] }], seen: rows };
  await a.bot.load();
  const seen = a.bot.snapshot().seen;
  assert.equal(seen.length, SEEN_MAX + 5, 'antes se recortaba a SEEN_MAX y lo olvidado se volvía a avisar tras un reinicio');
  assert.ok(!seen.some(([k]) => k.includes('|viejo-')), 'lo más viejo sale primero');
});

test('el parte de muchos chats a la vez: cada uno, lo suyo en su idioma y con sus focos (lo de cada cosa se calcula una vez por ronda)', () => {
  const { say, world, tick, bot } = setup();
  const orange = { id: 'aemet:1', source: 'aemet-avisos', category: 'meteo', type: 'lluvias', level: 'naranja', title: 'Aviso naranja por lluvias · Litoral sur de Valencia',
    lat: 39.0, lon: -0.2, issued: T0 - 3600_000, start: T0, end: T0 + 6 * 3600_000 };
  world.events = [orange];
  for (const chat of [1, 2, 3]) {
    say('/provincia Valencia', chat);
    say('/parte 06:05', chat);
  }
  say('/language english', 3);
  say('/provincia Valencia incendios', 2);
  const out = [];
  for (let i = 0; i < 6; i++) out.push(...tick());
  const parte = (chat) => out.filter((m) => m.chatId === chat).map((m) => m.text).join('\n');
  assert.match(parte(1), /^Parte de las 06:05:\n\nAvisos en Valencia:\nAviso naranja por lluvias · Litoral sur de Valencia/);
  assert.equal(parte(1).includes('Focos de calor'), false);
  assert.match(parte(2), /Avisos en Valencia \(con focos de calor\):\n.*\nFocos de calor por satélite: ahora ninguno/);
  assert.match(parte(3), /^Daily summary, 06:05:\n\nAlerts in Valencia:\nAviso naranja por lluvias · Litoral sur de Valencia/);
  assert.equal(bot.stats().chats, 3);
});

test('avisos largos de una línea: en varios mensajes, enteros y cada uno con su atribución y la web (no recortados)', () => {
  const { say, world, tick } = setup();
  say(`/start ${C4A}`);
  tick();
  const long = (i) => `${'Por obras de mejora entre Parla y Getafe Centro, los trenes circularán con horarios modificados. '.repeat(8)}[FIN ${i}]`;
  world.events = Array.from({ length: 6 }, (_, i) => ({ id: `renfe-aviso:${i}`, source: 'renfe-avisos', category: 'ferroviario', type: 'aviso',
    title: `Aviso Renfe · C4a (${i})`, description: long(i), follow: [C4A] }));
  const out = tick();
  assert.ok(out.length >= 2);
  for (const m of out) {
    assert.ok(m.text.length <= 3800);
    assert.match(m.text, /\n\nOrigen de los datos: Renfe Operadora\n\nMás en https:\/\/radarespana\.es$/);
  }
  for (let i = 0; i < 6; i++) assert.ok(out.some((m) => m.text.includes(long(i))), `aviso ${i} entero`);
});

test('/estado con una provincia escrita entera: la provincia, no lo que pasa por una estación que se llama así', () => {
  const { say } = setup();
  const blocks = say('/estado Valladolid').map((r) => r.text).join('\n');
  assert.match(blocks, /^Avisos en Valladolid:\n/);
  assert.doesNotMatch(blocks, /Avant 08058/, 'antes salía el Avant que sale de Valladolid-Campo Grande');
  assert.match(say('/status Valladolid fires')[0].text, /^Alerts in Valladolid:\n.*\nSatellite hotspots: none/, 'también con «incendios»');
  assert.match(say('/estado 08058')[0].text, /^Avant 08058:/, 'lo demás, como siempre');
});

test('/seguir algo que no se encuentra: /carretera sólo si parece una carretera', () => {
  const { say } = setup();
  assert.match(say('/seguir C1 Barcelona')[0].text, /^No encuentro nada así entre lo que circula/, 'no lo parece');
  assert.match(say('/seguir A-7')[0].text, /Si es una carretera, para sus cortes y accidentes: \/carretera A-7$/);
  assert.match(say('/seguir C-31')[0].text, /\/carretera C-31$/, 'con guion, puede serlo');
});

test('tras /baja no queda en lo guardado ni rastro de lo que seguía; y si ya nadie sigue nada, la ronda lo olvida todo', async () => {
  const { say, world, tick, bot, disk } = setup();
  world.events = [cancellation()];
  say(`/start ${AVANT}`);
  say(`/start ${C4A}`, 2);
  tick();
  await bot.save({ always: true });
  assert.ok(disk.value.seen.some(([k]) => k.startsWith(`${AVANT}|`)));
  say('/baja');
  await bot.save({ always: true });
  assert.equal(disk.value.seen.some(([k]) => k.startsWith(`${AVANT}|`)), false, 'antes quedaban las claves de lo que seguía');
  say('/baja', 2);
  tick();
  assert.deepEqual(bot.snapshot().seen, []);
  await bot.save({ always: true });
  assert.deepEqual(disk.value.seen, []);
});

test('/datos nombra todo lo que se guarda (también desde cuándo, la última vez que se miró, el último parte y lo avisado) y lo que vive en memoria', () => {
  const { say } = setup();
  say(`/start ${AVANT}`);
  const data = say('/datos')[0].text;
  assert.match(data, /- De cada cosa que sigues, desde cuándo y cuándo miré por última vez si había algo nuevo; del parte, el último día que te lo mandé; y, para no repetirte avisos, cuáles se han mandado ya/);
  assert.match(data, /En memoria, un rato y sin guardarlo: las listas de botones que te mando, cuántos mensajes me has escrito en el último minuto y si ya te he ofrecido el inglés\./);
  say('/baja');
  assert.match(say('/datos')[0].text, /^De este chat no guardo nada.*En memoria, un rato y sin guardarlo/);
});
