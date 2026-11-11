// Adaptador de entrada: el bot de Telegram. Igual que la API HTTP atiende peticiones, éste lee lo que la gente
// escribe al bot (long polling) y se lo pasa al caso de uso follow-bot; cada minuto le pide los avisos de la
// ronda; y lo manda todo por una cola con los límites de Telegram (send-queue.js).
// Sólo un servidor atiende el bot a la vez (LeasePort): si dos leyeran sus mensajes, Telegram los repartiría y
// los dos mandarían los mismos avisos. En un relevo, el nuevo espera a que el viejo lo suelte al apagarse.
// Los textos y el idioma de cada chat son cosa del caso de uso: aquí sólo se llevan y se traen.
import { createSendQueue } from './send-queue.js';

/** El idioma del Telegram de quien escribe (language_code, «en», «pt-br»), si tiene esa forma; si no, nada. */
const clientLang = (from) => (typeof from?.language_code === 'string' && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/.test(from.language_code)
  ? { clientLang: from.language_code } : {});

/**
 * Lo que el caso de uso entiende de una actualización de Telegram: el texto de un chat privado o el botón que se
 * ha pulsado, con el idioma del Telegram de quien lo manda. Lo demás (grupos, canales, ediciones…) se ignora: null.
 * @returns {{ chatId: number, text?: string, callback?: string, callbackId?: string, clientLang?: string }|null}
 */
export function toIncoming(update) {
  const m = update?.message;
  if (m) {
    if (m.chat?.type !== 'private' || !Number.isSafeInteger(m.chat.id)) return null;
    return { chatId: m.chat.id, text: typeof m.text === 'string' ? m.text : '', ...clientLang(m.from) };
  }
  const q = update?.callback_query;
  const chat = q?.message?.chat;
  if (q && chat?.type === 'private' && Number.isSafeInteger(chat.id)) {
    return { chatId: chat.id, callback: typeof q.data === 'string' ? q.data : '', callbackId: String(q.id ?? ''), ...clientLang(q.from) };
  }
  return null;
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * @param {{ api: import('../../../application/ports.js').ChatChannelPort, bot: ReturnType<typeof import('../../../application/use-cases/follow-bot.js').makeFollowBot>,
 *           lease: import('../../../application/ports.js').LeasePort, log: import('../../../application/ports.js').LoggerPort,
 *           waitSec?: number, tickMs?: number, leaseMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} deps
 *   waitSec: cuánto espera cada getUpdates si no hay nada; tickMs: cada cuánto se mira si hay avisos; leaseMs:
 *   cada cuánto se coge o renueva el turno. now y sleep: el reloj y las esperas (en los tests, simulados).
 */
export function createTelegramBot({ api, bot, lease, log, waitSec = 50, tickMs = 60_000, leaseMs = 20_000, now = Date.now, sleep = realSleep }) {
  const queue = createSendQueue();
  let running = false;
  let active = false;
  let disabled = false;
  let commandsSet = false;
  let pollFailures = 0;
  let conflictWarnedAt = -Infinity;

  /**
   * El menú de órdenes y las descripciones del bot en cada idioma: el primero, el de siempre (sin language_code);
   * los demás, para quien tiene Telegram en ese idioma.
   */
  async function setProfiles() {
    for (const [i, p] of bot.profiles().entries()) {
      const lang = i === 0 ? null : p.lang;
      await api.setCommands(p.commands, { lang }).catch((err) => log.warn(`[telegram] no se pudo poner el menú de órdenes (${p.lang}): ${err.message}`));
      await api.setDescriptions({ description: p.description, shortDescription: p.shortDescription, lang })
        .catch((err) => log.warn(`[telegram] no se pudo poner la descripción del bot (${p.lang}): ${err.message}`));
    }
  }

  /** Coge o renueva el turno; al cogerlo, carga lo guardado (puede haberlo dejado otro servidor). */
  async function claimOnce() {
    let ok = false;
    try {
      ok = await lease.claim();
    } catch (err) {
      log.warn(`[telegram] no se pudo coger el turno: ${err.message}`);
    }
    if (ok && !active) {
      await bot.load();
      active = true;
      log.info(`[telegram] este servidor atiende el bot (${bot.stats().chats} chats)`);
      if (!commandsSet) {
        commandsSet = true;
        await setProfiles();
      }
    } else if (!ok && active) {
      active = false;
      log.info('[telegram] otro servidor atiende ahora el bot');
    }
    return active;
  }

  /** Una lectura de lo que ha llegado; cada mensaje, al caso de uso, y sus respuestas, a la cola. */
  async function pollOnce() {
    if (!active || disabled) return 0;
    let updates;
    try {
      updates = await api.receive({ offset: bot.offset, waitSec });
      pollFailures = 0;
    } catch (err) {
      if (err.status === 401 || err.status === 404) {
        disabled = true;
        log.error(`[telegram] Telegram no acepta el token del bot (${err.message}): el bot queda desactivado hasta que se corrija`);
        return 0;
      }
      if (err.status === 409) {
        // Otro programa lee este bot: el entorno de pruebas con el mismo token, o un webhook puesto a mano.
        if (now() - conflictWarnedAt > 3600_000) {
          conflictWarnedAt = now();
          log.warn('[telegram] otro programa está leyendo este bot (¿el mismo token en pruebas, o un webhook?): se reintenta en 30 s');
        }
        await sleep(30_000);
        return 0;
      }
      pollFailures++;
      if (pollFailures === 3) log.warn(`[telegram] no se pueden leer los mensajes del bot: ${err.message}`);
      await sleep(Math.min(60_000, 5_000 * 2 ** Math.min(pollFailures - 1, 4)));
      return 0;
    }
    for (const u of updates) {
      if (Number.isSafeInteger(u?.update_id)) bot.setOffset(u.update_id + 1);
      const msg = toIncoming(u);
      if (!msg) continue;
      let res;
      try {
        res = bot.handle(msg);
      } catch (err) {
        log.error(`[telegram] al atender un mensaje: ${err.stack ?? err.message}`);
        continue;
      }
      for (const r of res.replies) queue.push(r);
      if (msg.callbackId) await api.answer({ id: msg.callbackId, text: res.answer }).catch(() => {});
      // Ha cambiado de idioma: su menú de órdenes, en el suyo; tras /baja (sin órdenes), el de siempre.
      if (res.menu) {
        await api.setCommands(res.menu.commands, { chatId: res.menu.chatId })
          .catch((err) => log.warn(`[telegram] no se pudo poner el menú de órdenes de un chat: ${err.message}`));
      }
    }
    return updates.length;
  }

  /** Una ronda de avisos y, de paso, se guarda lo que haya cambiado. */
  async function tickOnce() {
    if (!active || disabled) return 0;
    let replies = [];
    try {
      replies = bot.tick();
    } catch (err) {
      log.error(`[telegram] en la ronda de avisos: ${err.stack ?? err.message}`);
    }
    for (const r of replies) queue.push(r);
    const dropped = queue.takeDropped();
    if (dropped) log.warn(`[telegram] cola llena: se han descartado ${dropped} mensajes`);
    await bot.save({ force: true });
    return replies.length;
  }

  /** Manda el siguiente mensaje de la cola, si ya se puede. */
  async function drainOnce() {
    const m = queue.next(now());
    if (!m) return false;
    try {
      await api.send(m);
    } catch (err) {
      if (err.gone) {
        bot.forget(m.chatId);
        queue.forget(m.chatId);
      } else if (err.status === 429) {
        const ms = Math.max(1, err.retryAfter ?? 5) * 1000;
        queue.pause(now(), ms);
        queue.retry(m, now(), ms);
      } else if (!err.status || err.status >= 500) {
        if (!queue.retry(m, now(), 5_000)) log.warn(`[telegram] mensaje descartado tras varios intentos: ${err.message}`);
      } else {
        log.warn(`[telegram] Telegram no acepta un mensaje: ${err.message}`);
      }
    }
    return true;
  }

  const loop = async (step, idleMs) => {
    while (running) {
      let busy = false;
      try {
        busy = await step();
      } catch (err) {
        log.error(`[telegram] ${err.stack ?? err.message}`);
      }
      if (!running) break;
      if (!busy) await sleep(idleMs);
    }
  };

  return {
    queue,
    claimOnce,
    pollOnce,
    tickOnce,
    drainOnce,
    get active() {
      return active;
    },

    /** Arranca los cuatro bucles: turno, lectura, rondas de avisos y envío. */
    start() {
      if (running) return;
      running = true;
      loop(async () => { await claimOnce(); return false; }, leaseMs);
      loop(async () => (active ? (await pollOnce()) > 0 : false), 1000);
      loop(async () => { await tickOnce(); return false; }, tickMs);
      loop(drainOnce, 100);
    },

    /** Para los bucles, guarda y suelta el turno para que lo coja el servidor que releva a éste. */
    async stop() {
      running = false;
      if (active) await bot.save({ always: true }).catch(() => {});
      active = false;
      await lease.release().catch(() => {});
    },
  };
}
