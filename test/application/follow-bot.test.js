// El bot «Sigue tu tren», sin Telegram: seguir (por enlace, buscando o con botones), dejar, borrar, ver lo que
// guarda, el parte diario, los topes y las rondas de avisos (sólo lo nuevo, una vez). Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // 06:00 en Madrid
const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const C4A = lineKey({ operator: 'Renfe', scope: '10', line: 'C4a' });
const C4B = lineKey({ operator: 'Renfe', scope: '10', line: 'C4b' });
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
});

test('buscar: uno, varios con botones (y el botón sigue), nada; texto sin orden pregunta antes', () => {
  const { say, press, bot } = setup();
  assert.match(say('/seguir 08058')[0].text, /^Hecho: te aviso de Avant 08058/);
  const [many] = say('/seguir C4');
  assert.equal(many.text, 'He encontrado varias cosas. ¿Cuál quieres seguir?');
  assert.deepEqual(many.buttons.map((row) => row[0].data), ['a:0', 'a:1']);
  assert.match(many.buttons[0][0].text, /^Tren C4a · Cercanías · Renfe \(Alcobendas – Parla\)$/);
  const pressed = press('a:1');
  assert.equal(pressed.answer, 'Hecho');
  assert.match(pressed.replies[0].text, /^Hecho: te aviso de Tren C4b · Cercanías · Renfe\./);
  assert.match(press('a:0').replies[0].text, /^Esa lista ya no vale/, 'cada lista se usa una vez');
  const [ask] = say('27 EMT Málaga');
  assert.equal(ask.text, '¿Quieres seguir esto?');
  assert.match(press('a:0').replies[0].text, /^Hecho: te aviso de Autobús 27 · EMT Málaga/);
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
  assert.match(say('/dejar 2')[0].text, /^Hecho: ya no te aviso de Avisos en Valencia\.$/);
  const [menu] = say('/dejar');
  assert.deepEqual(menu.buttons.map((row) => row[0].text), ['Avant 08058']);
  assert.match(press('d:0').replies[0].text, /^Hecho: ya no te aviso de Avant 08058\. No sigues nada más, así que no guardo nada de este chat\.$/);
  assert.deepEqual(bot.stats(), { chats: 0, subs: 0 });
  assert.match(say('/datos')[0].text, /^De este chat no guardo nada/);
  say(`/start ${AVANT}`);
  assert.match(say('/dejar avant')[0].text, /^Hecho: ya no te aviso de Avant 08058/);
  say(`/start ${AVANT}`);
  assert.match(say('/baja')[0].text, /^Hecho: he borrado todo lo de este chat/);
  assert.match(say('/baja')[0].text, /^De este chat no tenía nada guardado/);
});

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
