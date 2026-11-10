// El bot en inglés, por chat: cómo se elige (/idioma, un botón, el enlace de la web en inglés, la oferta del primer
// /start), que se guarda con lo demás del chat, y que todo lo que escribe sale en su idioma con los nombres, lo que
// publica cada fuente y las atribuciones tal cual. Sin Telegram y con reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // 06:00 en Madrid
const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const C4A = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' });
const C4B = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4b' });
const EMT27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const CHAT = 1001;
const CREDIT = 'Origen de los datos: Renfe Operadora';

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
  const disk = { value: null };
  const store = { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } };
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, station: (code) => (code === '10600' ? { code, name: 'Valladolid-Campo Grande', lat: 41.64, lon: -4.73 } : null) },
    store,
    clock: { now: () => now },
    creditOf: (source) => (source.startsWith('renfe') ? CREDIT : null),
    webUrl: 'https://radarespana.es',
    limits,
  });
  const say = (text, chatId = CHAT, clientLang) => bot.handle({ chatId, text, ...(clientLang ? { clientLang } : {}) }).replies;
  const press = (data, chatId = CHAT) => bot.handle({ chatId, callback: data, callbackId: 'q1' });
  return { bot, world, disk, say, press, tick: (ms = 60_000) => { now += ms; return bot.tick(); } };
}

const cancellation = (over = {}) => ({
  id: 'renfe-cancelado:ld:08058', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado',
  title: 'Avant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor', credit: CREDIT,
  trip: { operator: 'Renfe', mode: 'av', service: 'Avant', number: '08058', follow: [AVANT, AVANT_LINE], reason: 'Incidencia en la infraestructura.',
    stops: [{ name: 'Valladolid-Campo Grande', time: '06:23', lat: 41.64, lon: -4.73 }, { name: 'Madrid-Chamartín-Clara Campoamor', time: '07:24' }] },
  ...over,
});
const redWarning = { id: 'aemet:1', source: 'aemet-avisos', category: 'meteo', level: 'rojo', title: 'Aviso rojo por lluvias · Litoral sur de Valencia',
  credit: '© AEMET', lat: 39.0, lon: -0.2, issued: T0, start: T0, end: T0 + 3600_000 };

// Palabras nuestras en español que no deberían quedar en inglés, quitados antes los nombres, lo que publican las
// fuentes y sus atribuciones (que van tal cual).
const VERBATIM = [CREDIT, '© AEMET', 'Aviso rojo por lluvias · Litoral sur de Valencia', 'Incidencia en la infraestructura.', 'Valladolid-Campo Grande',
  'Madrid-Chamartín-Clara Campoamor', 'EMT Málaga', 'Cercanías', 'Colmenar Viejo', 'A Coruña', 'Illes Balears', 'Valencia', 'Bizkaia', 'Atlántida', 'Soria'];
const SPANISH = /\b(de|del|la|las|los|el|con|sin|hoy|ahora|retraso|hacia|línea|estación|sigues|seguir|circula|cancelad[oa]s?|paradas?|que|por|para|aviso|avisos|nada|hecho|parte|órdenes)\b|[¿¡«»]/i;
function assertEnglish(text, what = '') {
  let rest = text;
  for (const v of VERBATIM) rest = rest.replaceAll(v, '');
  assert.doesNotMatch(rest, SPANISH, `${what}: «${text}»`);
}

test('/idioma pregunta en los dos idiomas con un botón por idioma; el botón cambia el idioma y el menú de ese chat', () => {
  const { say, press } = setup();
  const [ask] = say('/language');
  assert.equal(ask.text, '¿En qué idioma te escribo? · Which language should I write in?');
  assert.deepEqual(ask.buttons, [[{ text: 'Español', data: 'l:es' }], [{ text: 'English', data: 'l:en' }]]);
  const chosen = press('l:en');
  assert.equal(chosen.answer, 'Done');
  assert.equal(chosen.replies[0].text, "Done: from now on I'll write to you in English. /help to see what I do; /language to change it.");
  assert.equal(chosen.menu.chatId, CHAT);
  assert.deepEqual(chosen.menu.commands.map(([c]) => c), ['follow', 'status', 'province', 'following', 'unfollow', 'summary', 'data', 'stop', 'language', 'help']);
  const help = say('/help')[0].text;
  assert.match(help, /^I alert you about what you follow/);
  assert.match(help, /\/follow: Follow a train, bus, metro or line: \/follow 08058, \/follow C4 Madrid\n\/status: /);
  assert.match(help, /https:\/\/radarespana\.es\/\?lang=en/, 'la web, en inglés');
  assertEnglish(help, 'ayuda');
  // Con el idioma escrito, sin botones; y de vuelta al español.
  assert.match(say('/idioma español')[0].text, /^Hecho: a partir de ahora te escribo en español\./);
  assert.match(say('/ayuda')[0].text, /^Te aviso de lo que sigas/);
  assert.match(say('/language english')[0].text, /^Done: from now on/);
  assert.match(press('l:fr').replies[0].text, /^That list is no longer valid/, 'un idioma que no hay: como un botón viejo');
});

test('el enlace de la web en inglés (start=en-<clave>) sigue y contesta ya en inglés; los de siempre, en español', () => {
  const { say, bot } = setup();
  const [r] = say(`/start en-${AVANT}`);
  assert.equal(r.text, "Done: I'll alert you about Avant 08058.\n\nNow:\nAvant 08058: running 2 min late, from Valladolid-Campo Grande to "
    + `Madrid-Chamartín-Clara Campoamor.\n\n${CREDIT}\n\n/following to see what you follow · /unfollow to stop following it`);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 1 });
  assert.equal(bot.usage().totals.commands.enlace, 1, 'cuenta como un enlace');
  assert.match(say('/start en-prov-valencia')[0].text, /^Done: I'll alert you in Valencia about orange and red AEMET weather warnings/);
  assert.match(say('/start en', 2002)[0].text, /^Hello\. I'm the Radar España bot\./);
  assert.match(say(`/start ${C4A}`, 3003)[0].text, /^Hecho: te aviso de Cercanías C4a · Renfe \(Madrid\)\./, 'sin idioma, el de siempre');
  assert.match(say('/start fr-s-renfe-8058', 4004)[0].text, /^Hola\. Soy el bot/, 'un idioma que no hay: no es una clave');
});

test('el primer /start de un Telegram en otro idioma ofrece el inglés con un botón, sin imponerlo; en español o catalán, no', () => {
  const { say, press } = setup();
  const replies = say('/start', CHAT, 'en-GB');
  assert.equal(replies.length, 2);
  assert.match(replies[0].text, /^Hola\. Soy el bot de Radar España/, 'la bienvenida, en el de siempre');
  assert.equal(replies[1].text, 'Would you like me to write in English? Tap the button, or send /language at any time.');
  assert.deepEqual(replies[1].buttons, [[{ text: 'English', data: 'l:en' }]]);
  assert.equal(say('/start', CHAT, 'en-GB').length, 1, 'no se ofrece cada vez: ya ha hablado con el bot');
  assert.match(press('l:en').replies[0].text, /^Done/);
  assert.equal(say('/start', 2002, 'es-ES').length, 1);
  assert.equal(say('/start', 3003, 'ca').length, 1, 'quien tiene Telegram en catalán está en España');
  assert.equal(say(`/start ${AVANT}`, 4004, 'de').length, 2, 'también si llega desde un enlace');
  assert.equal(say(`/start en-${AVANT}`, 5005, 'de').length, 1, 'si el enlace ya es en inglés, no hace falta');
});

test('todo en inglés: seguir, buscar, /mis, /estado, /dejar, /parte, /datos y /baja; los nombres y las fuentes, tal cual', () => {
  const { say, press, world, tick } = setup();
  say('/language en');
  const [many] = say('/follow C4');
  assert.equal(many.text, 'I found several things. Which one do you want to follow?');
  assert.equal(many.buttons[0][0].text, 'Cercanías C4a · Renfe (Madrid) (Alcobendas – Parla)');
  assert.match(press(many.buttons[1][0].data).replies[0].text, /^Done: I'll alert you about Cercanías C4b · Renfe \(Madrid\)\.\n\nNow:\n1 train running now; it is less than 5 min late\./);
  const [ask] = say('27 EMT Málaga');
  assert.equal(ask.text, 'Do you want to follow this?');
  assert.equal(ask.buttons[0][0].text, 'Bus 27 · EMT Málaga');
  const pressed = press(ask.buttons[0][0].data);
  assert.equal(pressed.answer, 'Done');
  assert.match(pressed.replies[0].text, /^Done: I'll alert you about Bus 27 · EMT Málaga\.\n\nNow:\n1 bus running now\./);
  say(`/start ${stopKey('10600')}`);
  say('/province Valencia');
  const mine = say('/following')[0].text;
  assert.equal(mine, 'Following:\n\n1. Cercanías C4b · Renfe (Madrid)\n2. Bus 27 · EMT Málaga\n3. Valladolid-Campo Grande station\n4. Alerts in Valencia'
    + '\n\nTo unfollow something: /unfollow (or /unfollow and its number).');
  world.events = [cancellation(), redWarning];
  const status = say('/status').map((r) => r.text).join('\n\n');
  assert.match(status, /Valladolid-Campo Grande station:\nDue through Valladolid-Campo Grande today and cancelled or with skipped stops: 1\.\n- Avant 08058 cancelled: /);
  assert.match(status, /Alerts in Valencia:\nAviso rojo por lluvias · Litoral sur de Valencia, from 10\/11, 06:00 until 10\/11, 07:00\. Issued 10\/11, 06:00\.\n\n© AEMET/,
    'el aviso de AEMET, tal cual; lo nuestro y la fecha, en inglés');
  assert.match(status, /More at https:\/\/radarespana\.es\/\?lang=en$/);
  assertEnglish(status, '/status');
  assert.match(say('/status 08058')[0].text, /^Avant 08058:\nAvant 08058: running 2 min late, from Valladolid-Campo Grande to Madrid-Chamartín-Clara Campoamor\./);
  assert.match(say('/unfollow bus 27')[0].text, /^Done: I'll no longer alert you about Bus 27 · EMT Málaga\.$/, 'por su nombre en inglés');
  assert.match(say('/unfollow 9')[0].text, /^There is no 9 in your list: it goes from 1 to 3\. What do you want to unfollow\?$/);
  assert.match(say('/summary 7pm')[0].text, /^Done: every day at 19:00 \(mainland Spain time\) I'll send you how what you follow is doing\.$/);
  assert.match(say('/summary tomorrow')[0].text, /^Tell me the time, in mainland Spain time: \/summary 07:30\. To turn it off: \/summary off\.$/);
  const data = say('/data')[0].text;
  assert.match(data, /^This is everything I store about this chat:\n- Chat number: 1001\n- Since: 10\/11, 06:00\n- Following: Cercanías C4b · Renfe \(Madrid\); Valladolid-Campo Grande station\n- Provinces: Valencia\n- Daily summary: 19:00\n- Language: English\nNothing else/);
  assert.match(say('/foo')[0].text, /^I don't know that command\. See \/help\.$/);
  assert.match(say('hello')[0].text, /^Hello\. Tell me what you want to follow/);
  assert.match(say('thanks')[0].text, /^You're welcome\. To follow something else/);
  assert.match(say('/stop')[0].text, /^Done: I've deleted everything about this chat\./);
  assert.match(say('/data')[0].text, /^I store nothing about this chat: you aren't following anything\..*I only keep the language you chose in memory/,
    'tras /baja, el idioma sigue sólo en memoria y lo dice');
  void tick;
});

test('las rondas: a cada chat, en su idioma y a la vez; el título del servidor traducido, el motivo del operador y la atribución tal cual', () => {
  const { say, world, tick } = setup();
  say(`/start en-${AVANT}`);
  say(`/start ${AVANT}`, 2002);
  say('/start en-prov-valencia', 3003);
  world.events = [cancellation(), redWarning];
  const out = tick();
  const en = out.find((m) => m.chatId === CHAT).text;
  const es = out.find((m) => m.chatId === 2002).text;
  assert.equal(en, 'Avant 08058:\n\nAvant 08058 cancelled: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor. Reason: Incidencia en la infraestructura.'
    + `\n\n${CREDIT}\n\nMore at https://radarespana.es/?lang=en`);
  assert.equal(es, 'Avant 08058:\n\nAvant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor. Motivo: Incidencia en la infraestructura.'
    + `\n\n${CREDIT}\n\nMás en https://radarespana.es`);
  assert.equal(out.find((m) => m.chatId === 3003).text, 'Alerts in Valencia:\n\nAviso rojo por lluvias · Litoral sur de Valencia, from 10/11, 06:00 until 10/11, 07:00. '
    + 'Issued 10/11, 06:00.\n\n© AEMET\n\nMore at https://radarespana.es/?lang=en');
  world.vehicles[0].delay = 17;
  assert.match(tick().find((m) => m.chatId === CHAT).text, /^Avant 08058:\n\nAvant 08058 is running 17 min late \(from Valladolid-Campo Grande to Madrid-Chamartín-Clara Campoamor\)\./);
  say('/summary 06:05');
  let parte = [];
  for (let i = 0; i < 5 && !parte.length; i++) parte = tick().filter((m) => m.chatId === CHAT);
  assert.match(parte[0].text, /^Daily summary, 06:05:\n\nAvant 08058:\nAvant 08058: running 17 min late/);
});

test('el idioma se guarda con lo demás del chat (sólo si no es el de siempre) y se recupera; quien no sigue nada, sólo en memoria', async () => {
  const a = setup();
  a.say('/language en');
  await a.bot.save();
  assert.deepEqual(a.disk.value.chats, [], 'sin seguir nada no se guarda nada del chat (sólo los totales de uso)');
  a.say(`/start ${AVANT}`);
  a.say(`/start ${C4A}`, 2002);
  await a.bot.save();
  assert.equal(a.disk.value.chats.find((c) => c.id === CHAT).lang, 'en');
  assert.equal('lang' in a.disk.value.chats.find((c) => c.id === 2002), false, 'el de siempre no se escribe');
  const b = setup();
  b.disk.value = structuredClone(a.disk.value);
  b.disk.value.chats.push({ id: 7, lang: 'xx', subs: [{ key: AVANT, name: 'Avant 08058' }] });
  await b.bot.load();
  assert.match(b.say('/mis')[0].text, /^Following:/);
  assert.match(b.say('/mis', 2002)[0].text, /^Sigues:/);
  assert.match(b.say('/mis', 7)[0].text, /^Sigues:/, 'un idioma que no hay, el de siempre');
  // Deja de seguirlo todo: lo guardado se borra; el idioma sigue en memoria mientras no se reinicie.
  b.say('/unfollow 1');
  assert.equal(b.bot.stats().chats, 2);
  assert.match(b.say('/following')[0].text, /^You aren't following anything/);
  b.bot.forget(CHAT);
  assert.match(b.say('/mis')[0].text, /^No sigues nada/, 'un chat que bloquea el bot se olvida entero');
});
