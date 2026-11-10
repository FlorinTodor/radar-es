// El bot de Telegram por fuera: la API (sin el token en los errores), la cola con los límites de Telegram, el
// bucle que lee, avisa y manda (con un Telegram falso y sin esperas reales), el almacén y el turno en disco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TelegramError, createTelegramApi, isBotToken, isBotUsername } from '../../server/adapters/outbound/telegram/telegram-api.js';
import { createSendQueue } from '../../server/adapters/inbound/telegram/send-queue.js';
import { createTelegramBot, toIncoming } from '../../server/adapters/inbound/telegram/telegram-bot.js';
import { createFollowStore } from '../../server/adapters/outbound/persistence/follow-store.js';
import { createFileLease } from '../../server/adapters/outbound/persistence/file-lease.js';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { numberedServiceKey } from '../../server/domain/seguir.js';

const TOKEN = '123456789:AAHsecretsecretsecretsecretsecret_-1';
const quietLog = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
};

test('forma del token y del usuario del bot', () => {
  assert.equal(isBotToken(TOKEN), true);
  assert.equal(isBotToken('123:abc'), false);
  assert.equal(isBotUsername('RadarEspanaBot'), true);
  assert.equal(isBotUsername('radar_es_bot'), true);
  assert.equal(isBotUsername('RadarEspana'), false);
  assert.equal(isBotUsername('@RadarEspanaBot'), false);
});

test('API: cada llamada va a su método con su cuerpo; los errores dicen el estado y cuánto esperar, nunca el token', async () => {
  const calls = [];
  let fail = null;
  const http = {
    postJson: async (url, body, opts) => {
      calls.push({ url, body, opts });
      if (fail) throw fail;
      return { ok: true, result: url.endsWith('/getUpdates') ? [{ update_id: 5 }] : true };
    },
  };
  const api = createTelegramApi({ http, token: TOKEN });
  assert.deepEqual(await api.receive({ offset: 3, waitSec: 50 }), [{ update_id: 5 }]);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
  assert.deepEqual(calls[0].body, { offset: 3, timeout: 50, limit: 100, allowed_updates: ['message', 'callback_query'] });
  assert.equal(calls[0].opts.timeout, 65_000, 'más que la espera del long polling');
  await api.send({ chatId: 7, text: 'hola', buttons: [[{ text: 'Uno', data: 'a:0' }]] });
  assert.deepEqual(calls[1].body, { chat_id: 7, text: 'hola', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Uno', callback_data: 'a:0' }]] } });
  await api.setCommands([['seguir', 'Seguir algo']]);
  assert.deepEqual(calls[2].body, { commands: [{ command: 'seguir', description: 'Seguir algo' }] });
  // El menú de quien tiene Telegram en inglés, el de un chat y las descripciones de cada idioma.
  await api.setCommands([['follow', 'Follow something']], { lang: 'en' });
  assert.deepEqual(calls[3].body, { commands: [{ command: 'follow', description: 'Follow something' }], language_code: 'en' });
  await api.setCommands([['follow', 'Follow something']], { chatId: 7 });
  assert.deepEqual(calls[4].body, { commands: [{ command: 'follow', description: 'Follow something' }], scope: { type: 'chat', chat_id: 7 } });
  await api.setDescriptions({ description: 'D'.repeat(600), shortDescription: 'Corta', lang: 'en' });
  assert.ok(calls[5].url.endsWith('/setMyDescription'));
  assert.deepEqual(calls[5].body, { description: 'D'.repeat(512), language_code: 'en' }, 'el tope de Telegram');
  assert.ok(calls[6].url.endsWith('/setMyShortDescription'));
  assert.deepEqual(calls[6].body, { short_description: 'Corta', language_code: 'en' });
  await api.setDescriptions({ description: 'Larga', shortDescription: 'Corta' });
  assert.deepEqual(calls[7].body, { description: 'Larga' }, 'sin idioma, la de siempre');
  calls.length = 0;

  fail = Object.assign(new Error('HTTP 429 en api.telegram.org'), { status: 429, body: { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } });
  const slow = await api.send({ chatId: 7, text: 'x' }).catch((e) => e);
  assert.ok(slow instanceof TelegramError);
  assert.equal(slow.status, 429);
  assert.equal(slow.retryAfter, 7);
  fail = Object.assign(new Error('HTTP 403 en api.telegram.org'), { status: 403, body: { description: 'Forbidden: bot was blocked by the user' } });
  assert.equal((await api.send({ chatId: 7, text: 'x' }).catch((e) => e)).gone, true);
  fail = new Error(`fetch failed para https://api.telegram.org/bot${TOKEN}/sendMessage`);
  const net = await api.send({ chatId: 7, text: 'x' }).catch((e) => e);
  assert.doesNotMatch(net.message, /AAHsecret/, 'el token no sale nunca');
  assert.equal(net.status, null);
  assert.throws(() => createTelegramApi({ http, token: 'malo' }), /token del bot/);
});

test('cola: uno por segundo a cada chat, 25 por segundo en total, reintentos con espera, tope y olvidar un chat', () => {
  const q = createSendQueue({ max: 4 });
  q.push({ chatId: 1, text: 'a' });
  q.push({ chatId: 1, text: 'b' });
  q.push({ chatId: 2, text: 'c' });
  assert.equal(q.next(0).text, 'a');
  assert.equal(q.next(10), null, 'entre dos mensajes cualesquiera, 40 ms');
  assert.equal(q.next(40).text, 'c', 'el segundo del chat 1 espera; el del chat 2, no');
  assert.equal(q.next(100), null);
  assert.equal(q.next(1000).text, 'b');
  const m = { chatId: 3, text: 'd', tries: 0 };
  assert.equal(q.retry(m, 1000, 7000), true);
  assert.equal(q.next(2000), null);
  assert.equal(q.next(8000).text, 'd');
  assert.equal(q.retry(m, 8000, 1), true);
  assert.equal(q.retry(m, 8000, 1), false, 'al tercer intento, se tira');
  for (const t of ['e', 'f', 'g', 'h', 'i', 'j']) q.push({ chatId: 4, text: t });
  assert.equal(q.size(), 4);
  assert.equal(q.takeDropped(), 3);
  q.forget(4);
  assert.equal(q.size(), 0);
  q.push({ chatId: 5, text: 'k' });
  q.pause(9000, 5000);
  assert.equal(q.next(10_000), null, 'Telegram pide esperar a todo el bot');
  assert.equal(q.next(14_000).text, 'k');
});

test('toIncoming: textos y botones de chats privados, con el idioma de su Telegram; lo demás, nada', () => {
  assert.deepEqual(toIncoming({ update_id: 1, message: { chat: { id: 9, type: 'private' }, text: '/seguir 08058' } }), { chatId: 9, text: '/seguir 08058' });
  assert.deepEqual(toIncoming({ update_id: 1, message: { chat: { id: 9, type: 'private' }, from: { id: 9, language_code: 'pt-br' }, text: '/start' } }),
    { chatId: 9, text: '/start', clientLang: 'pt-br' });
  assert.deepEqual(toIncoming({ update_id: 1, message: { chat: { id: 9, type: 'private' }, from: { language_code: '<b>x</b>' }, text: '/start' } }),
    { chatId: 9, text: '/start' }, 'lo que no tiene forma de idioma, no');
  assert.deepEqual(toIncoming({ update_id: 3, callback_query: { id: 'q', data: 'l:en', from: { language_code: 'en' }, message: { chat: { id: 9, type: 'private' } } } }),
    { chatId: 9, callback: 'l:en', callbackId: 'q', clientLang: 'en' });
  assert.deepEqual(toIncoming({ update_id: 2, message: { chat: { id: 9, type: 'private' }, sticker: {} } }), { chatId: 9, text: '' });
  assert.deepEqual(toIncoming({ update_id: 3, callback_query: { id: 'q', data: 'a:0', message: { chat: { id: 9, type: 'private' } } } }),
    { chatId: 9, callback: 'a:0', callbackId: 'q' });
  assert.equal(toIncoming({ update_id: 4, message: { chat: { id: -100, type: 'group' }, text: '/baja' } }), null);
  assert.equal(toIncoming({ update_id: 5, edited_message: {} }), null);
});

/** Un bot completo con un Telegram falso, un turno en memoria y un reloj simulado. */
function harness({ claim = true } = {}) {
  let now = Date.parse('2026-11-10T07:00:00Z');
  const sent = [];
  const answered = [];
  const inbox = [];
  const api = {
    failNext: null,
    receive: async ({ offset }) => {
      if (api.failNext) {
        const e = api.failNext;
        api.failNext = null;
        throw e;
      }
      return inbox.splice(0).filter((u) => u.update_id >= offset);
    },
    send: async (m) => {
      if (api.sendFail) {
        const e = api.sendFail;
        api.sendFail = null;
        throw e;
      }
      sent.push(m);
    },
    answer: async (a) => { answered.push(a); },
    menus: [],
    descriptions: [],
    setCommands: async (commands, opts = {}) => { api.menus.push({ commands, ...opts }); },
    setDescriptions: async (d) => { api.descriptions.push(d); },
  };
  const lease = { owned: false, claim: async () => (lease.owned = claim), release: async () => { lease.owned = false; } };
  const key = numberedServiceKey({ operator: 'Renfe', number: '08058' });
  const world = { vehicles: [{ id: 'v', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', label: '08058', delay: 0, follow: [key] }], events: [] };
  const disk = { value: null };
  const log = quietLog();
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events },
    store: { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } },
    clock: { now: () => now },
    webUrl: 'https://radarespana.es',
  });
  const sleeps = [];
  const tg = createTelegramBot({ api, bot, lease, log, now: () => now, sleep: async (ms) => { sleeps.push(ms); } });
  return { tg, api, bot, inbox, sent, answered, world, disk, log, key, sleeps, lease, advance: (ms) => { now += ms; } };
}

test('bucle: sin turno no lee; con turno, lee, contesta por la cola, responde a los botones y avanza el offset', async () => {
  const h = harness({ claim: false });
  h.inbox.push({ update_id: 10, message: { chat: { id: 9, type: 'private' }, text: `/start ${h.key}` } });
  assert.equal(await h.tg.claimOnce(), false);
  assert.equal(await h.tg.pollOnce(), 0, 'otro servidor atiende el bot');
  const g = harness();
  g.inbox.push({ update_id: 10, message: { chat: { id: 9, type: 'private' }, text: `/start ${g.key}` } });
  assert.equal(await g.tg.claimOnce(), true);
  assert.equal(await g.tg.pollOnce(), 1);
  assert.equal(g.bot.offset, 11);
  assert.equal(await g.tg.drainOnce(), true);
  assert.match(g.sent[0].text, /^Hecho: te aviso de Avant 08058/);
  g.inbox.push({ update_id: 11, message: { chat: { id: 9, type: 'private' }, text: '/dejar' } });
  await g.tg.pollOnce();
  g.advance(2000);
  await g.tg.drainOnce();
  const data = g.sent.at(-1).buttons[0][0].data;
  assert.match(data, /^d:[0-9a-z]+:0$/);
  g.inbox.push({ update_id: 12, callback_query: { id: 'q7', data, message: { chat: { id: 9, type: 'private' } } } });
  await g.tg.pollOnce();
  assert.deepEqual(g.answered, [{ id: 'q7', text: 'Hecho' }]);
  g.advance(2000);
  await g.tg.drainOnce();
  assert.match(g.sent.at(-1).text, /^Hecho: ya no te aviso de Avant 08058/);
});

test('bucle: al coger el turno pone el menú y las descripciones de cada idioma (una vez); si un chat cambia de idioma, su menú', async () => {
  const h = harness();
  await h.tg.claimOnce();
  assert.deepEqual(h.api.menus.map((m) => [m.lang, m.commands[0][0]]), [[null, 'seguir'], ['en', 'follow']], 'el de siempre, en español; el inglés, por language_code');
  assert.deepEqual(h.api.descriptions.map((d) => d.lang), [null, 'en']);
  assert.match(h.api.descriptions[1].description, /^I alert you about what you follow on Radar España/);
  await h.lease.release();
  await h.tg.claimOnce();
  assert.equal(h.api.menus.length, 2, 'no se repite al volver a cogerlo');
  h.inbox.push({ update_id: 1, message: { chat: { id: 9, type: 'private' }, from: { language_code: 'en' }, text: '/start' } });
  await h.tg.pollOnce();
  h.inbox.push({ update_id: 2, callback_query: { id: 'q1', data: 'l:en', message: { chat: { id: 9, type: 'private' } } } });
  await h.tg.pollOnce();
  assert.deepEqual(h.answered, [{ id: 'q1', text: 'Done' }]);
  assert.equal(h.api.menus.at(-1).chatId, 9);
  assert.equal(h.api.menus.at(-1).commands[0][0], 'follow', 'su menú, en inglés');
  for (let i = 0; i < 3; i++) {
    h.advance(1000);
    await h.tg.drainOnce();
  }
  assert.deepEqual(h.sent.map((m) => m.text.split('\n')[0]), ['Hola. Soy el bot de Radar España.',
    'Would you like me to write in English? Tap the button, or send /language at any time.', "Done: from now on I'll write to you in English. /help to see what I do; /language to change it."]);
  assert.deepEqual(h.sent[1].buttons, [[{ text: 'English', data: 'l:en' }]]);
});

test('bucle: la ronda manda los avisos y guarda; un chat que bloquea el bot se olvida; 429 espera; token malo, desactivado', async () => {
  const h = harness();
  await h.tg.claimOnce();
  h.inbox.push({ update_id: 1, message: { chat: { id: 9, type: 'private' }, text: `/start ${h.key}` } });
  await h.tg.pollOnce();
  h.advance(2000);
  await h.tg.drainOnce();
  h.world.vehicles[0].delay = 25;
  h.advance(60_000);
  assert.equal(await h.tg.tickOnce(), 1);
  assert.ok(h.disk.value, 'se guarda tras la ronda');
  h.api.sendFail = new TelegramError('sendMessage', { status: 429, retryAfter: 3 });
  await h.tg.drainOnce();
  assert.equal(h.tg.queue.size(), 1, 'vuelve a la cola');
  h.advance(1000);
  assert.equal(await h.tg.drainOnce(), false, 'espera lo que pide Telegram');
  h.advance(3000);
  await h.tg.drainOnce();
  assert.match(h.sent.at(-1).text, /va con 25 min de retraso/);
  // Bloquea el bot: al mandarle algo, Telegram dice 403 y se borra todo lo suyo.
  h.world.vehicles[0].delay = 45;
  h.advance(60_000);
  await h.tg.tickOnce();
  h.api.sendFail = new TelegramError('sendMessage', { status: 403, description: 'Forbidden: bot was blocked by the user' });
  await h.tg.drainOnce();
  assert.deepEqual(h.bot.stats(), { chats: 0, subs: 0 });
  // Otro programa lee el mismo bot: se avisa una vez y se espera.
  h.api.failNext = Object.assign(new TelegramError('getUpdates', { status: 409 }));
  await h.tg.pollOnce();
  assert.ok(h.log.lines.some(([level, m]) => level === 'warn' && /otro programa está leyendo este bot/.test(m)));
  assert.equal(h.sleeps.at(-1), 30_000);
  h.api.failNext = new TelegramError('getUpdates', { status: 401, description: 'Unauthorized' });
  await h.tg.pollOnce();
  assert.ok(h.log.lines.some(([level, m]) => level === 'error' && /no acepta el token/.test(m)));
  h.inbox.push({ update_id: 50, message: { chat: { id: 9, type: 'private' }, text: '/ayuda' } });
  assert.equal(await h.tg.pollOnce(), 0, 'desactivado: ya no lee');
  await h.tg.stop();
  assert.equal(h.lease.owned, false, 'al parar suelta el turno');
});

test('almacén y turno en disco: se guarda y se lee; el turno es de uno solo hasta que lo suelta o caduca', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-bot-'));
  try {
    const url = pathToFileURL(`${dir}/bot/`);
    const log = quietLog();
    const store = createFollowStore({ dir: url, log });
    assert.equal(await store.load(), null);
    await store.save({ version: 1, chats: [] });
    assert.deepEqual(await store.load(), { version: 1, chats: [] });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'bot', 'seguidos.v1.json'), 'utf8')), { version: 1, chats: [] });

    let now = 1_000_000;
    const a = createFileLease({ dir: url, id: 'a', ttlMs: 90_000, now: () => now });
    const b = createFileLease({ dir: url, id: 'b', ttlMs: 90_000, now: () => now });
    assert.equal(await a.claim(), true);
    assert.equal(await b.claim(), false);
    assert.equal(await a.claim(), true, 'renovar');
    now += 91_000;
    assert.equal(await b.claim(), true, 'el de a ha caducado');
    assert.equal(await a.claim(), false);
    await a.release();
    assert.equal(await b.claim(), true, 'a no puede soltar el de b');
    await b.release();
    assert.equal(await a.claim(), true, 'b lo ha soltado');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
