// Adaptador de salida: la API de bots de Telegram (https://core.telegram.org/bots/api), por el cliente HTTP
// compartido. Cumple el puerto ChatChannel: recibir mensajes (long polling con getUpdates, sin webhook: no hay
// que abrir nada hacia dentro), contestar, responder a los botones y poner el menú de órdenes.
// El token va en la ruta de cada llamada: no sale nunca en un error ni en el registro (el cliente HTTP sólo
// dice el host, y aquí se tapa por si acaso).
const API = 'https://api.telegram.org';

/** ¿Tiene forma de token de bot («123456789:AA…»)? */
export const isBotToken = (t) => typeof t === 'string' && /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/.test(t);
/** ¿Tiene forma de usuario de bot (5 a 32 caracteres, acaba en «bot»)? */
export const isBotUsername = (u) => typeof u === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/.test(u);

/** Un error de Telegram, sin el token: su estado HTTP, lo que dice y, si pide esperar, cuánto. */
export class TelegramError extends Error {
  /** @param {string} method @param {{ status?: number, description?: string, retryAfter?: number }} info */
  constructor(method, { status = null, description = null, retryAfter = null }) {
    super(`Telegram ${method}: ${status ? `HTTP ${status}` : 'sin respuesta'}${description ? ` (${description})` : ''}`);
    this.name = 'TelegramError';
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }

  /** El chat ya no está: ha bloqueado el bot, se ha borrado la cuenta o no existe. */
  get gone() {
    return this.status === 403 || (this.status === 400 && /chat not found|user is deactivated|bot was blocked/i.test(this.description ?? ''));
  }
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, token: string, timeoutMs?: number }} deps
 * @returns {import('../../../application/ports.js').ChatChannelPort}
 */
export function createTelegramApi({ http, token, timeoutMs = 15_000 }) {
  if (!isBotToken(token)) throw new TypeError('El token del bot de Telegram no tiene la forma esperada');
  const base = `${API}/bot${token}/`;
  const hide = (s) => (typeof s === 'string' ? s.replaceAll(token, '***').slice(0, 300) : null);

  async function call(method, body, timeout = timeoutMs) {
    let res;
    try {
      res = await http.postJson(`${base}${method}`, body, { timeout, maxBytes: 8 * 1024 * 1024 });
    } catch (err) {
      throw new TelegramError(method, {
        status: err.status ?? null,
        description: hide(err.body?.description) ?? (err.status ? null : hide(err.name === 'TimeoutError' ? 'tiempo de espera agotado' : err.message)),
        retryAfter: Number.isFinite(err.body?.parameters?.retry_after) ? err.body.parameters.retry_after : null,
      });
    }
    if (!res?.ok) throw new TelegramError(method, { status: 200, description: hide(res?.description) ?? 'respuesta sin ok' });
    return res.result;
  }

  return {
    async receive({ offset, waitSec }) {
      const updates = await call('getUpdates', { offset, timeout: waitSec, limit: 100, allowed_updates: ['message', 'callback_query'] },
        (waitSec + 15) * 1000);
      return Array.isArray(updates) ? updates : [];
    },
    async send({ chatId, text, buttons }) {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        link_preview_options: { is_disabled: true },
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
      });
    },
    async answer({ id, text }) {
      await call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text: text.slice(0, 200) } : {}) });
    },
    async setCommands(commands) {
      await call('setMyCommands', { commands: commands.map(([command, description]) => ({ command, description: description.slice(0, 256) })) });
    },
  };
}
