// Botón «Avísame por Telegram» de las fichas: abre el bot «Sigue tu tren» con la clave de lo que se quiere
// seguir (t.me/<bot>?start=<clave>; ver docs/telegram.md y domain/seguir.js). Para cualquier vehículo: sale de
// sus claves `follow`, y el nombre de cada tipo («tren», «autobús»…), del registro de tipos (/api/modes). Sólo si
// el servidor tiene bot: lo dice /api/about. Va arriba de la ficha y bien visible: es lo que más interesa a quien
// espera ese tren o ese autobús.
import { parseFollowKey } from '../../server/domain/seguir.js';
import { esc } from './format.js';
import { t } from './i18n.js';
import { followNameText } from './siguiendo.js';

const KEY_RE = /^[slp]-[A-Za-z0-9_-]{1,62}$/;
const BOT_RE = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
let bot = null;
let nouns = {};

// El avión de papel (dibujo propio, no el logotipo de Telegram), sobre un círculo blanco.
const PLANE = '<svg class="tg-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.6 4.1 3.4 10.8c-1.1.4-1.1 1.4-.1 1.7l4.4 1.4 1.7 5.2c.2.6.9.8 1.4.4l2.5-2.1 4.6 3.4c.6.4 1.3.1 1.5-.6l2.9-13.8c.2-1-.7-1.8-1.7-1.3Zm-3.4 3.6-7.6 6.9-.3 3-1.2-3.9 8.6-6.4c.4-.3.8.1.5.4Z"/></svg>';

/** Qué bot hay (de /api/about) y cómo se llama cada tipo de vehículo (de /api/modes). */
export function setTelegram(about, modes = []) {
  const name = about?.telegram?.bot;
  bot = typeof name === 'string' && BOT_RE.test(name) ? name : null;
  nouns = Object.fromEntries((Array.isArray(modes) ? modes : []).filter((m) => m?.id && m.noun).map((m) => [m.id, m.noun]));
}

/** Lo pide al servidor una vez, al cargar el mapa. Si falla, no hay botón. */
export function loadTelegram() {
  const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return Promise.all([json('/api/about'), json('/api/modes')]).then(([about, modes]) => setTelegram(about, modes ?? []));
}

/** ¿Hay bot configurado? (para enseñar o no lo relacionado con Telegram) */
export const hasTelegram = () => bot !== null;

const startUrl = (key) => `https://t.me/${esc(bot)}?start=${esc(key)}`;

/**
 * Cómo se nombra una línea en el botón: «la línea C2», «los Alvia» (cuando la «línea» es el propio producto,
 * como en la larga distancia) o, sin nombre, «su línea».
 * @param {{ line?: string|null, service?: string|null }} [names]
 */
function lineWords({ line = null, service = null, network = false, operator = null } = {}) {
  if (network) {
    const all = operator ? t('toda la red de {operator}', { operator }) : t('toda la red');
    return { all, of: all };
  }
  if (!line) return { all: t('toda su línea'), of: t('su línea') };
  if (service && line === service) return { all: t('todos los {line}', { line }), of: t('los {line}', { line }) };
  return { all: t('toda la línea {line}', { line }), of: t('la línea {line}', { line }) };
}

/**
 * El botón para seguir algo por Telegram, o '' si no hay bot o no tiene claves válidas. Con servicio y línea,
 * el botón es el del servicio y la línea va debajo como segunda opción.
 * @param {string[]|string|undefined} follow  las claves de un vehículo o de un viaje (o la de una estación)
 * @param {string} [mode]  su tipo, para decir «este tren», «este autobús»…
 * @param {{ line?: string|null, service?: string|null, operator?: string|null }} [names]  su producto y su operador
 *   (la línea se nombra por su clave; el operador, para «toda la red de …»)
 */
export function telegramFollow(follow, mode, names = {}) {
  if (!bot) return '';
  const keys = (Array.isArray(follow) ? follow : [follow]).filter((k) => typeof k === 'string' && KEY_RE.test(k));
  const first = (kind) => keys.find((k) => k[0] === kind) ?? null;
  const service = first('s');
  const line = first('l');
  const stop = first('p');
  // La línea, por su propia clave (como el botón «Seguir la línea …»): en una cancelación que junta el mismo tren
  // de dos feeds, la línea de la ficha (R16) puede ser de la otra clave (Regional Exprés).
  const parts = line ? parseFollowKey(line)?.parts ?? [] : [];
  const words = lineWords({ line: parts.at(-1) ?? null, service: names.service ?? null, network: Boolean(line) && !parts.length, operator: names.operator ?? null });
  let main = null;
  let alt = null;
  if (service) {
    main = { key: service, what: t('si este {noun} se cancela o va con retraso', { noun: t(nouns[mode] ?? 'servicio') }) };
    if (line) alt = { key: line, text: t('o de {what}', { what: words.all }) };
  } else if (line) {
    main = { key: line, what: t('de las cancelaciones y avisos de {what}', { what: words.of }) };
  } else if (stop) {
    // No todas las redes publican cancelaciones (los metros y tranvías casi nunca): no prometer más de lo que hay.
    main = { key: stop, what: t('de las cancelaciones que su operador publique en esta estación') };
  }
  if (!main) return '';
  return `<div class="tg-cta"><a class="tg-btn" href="${startUrl(main.key)}" target="_blank" rel="noopener">${PLANE}`
    + `<span class="tg-txt"><strong>${t('Avísame por Telegram')}</strong><small>${esc(main.what)}</small></span></a>`
    + `${alt ? `<a class="tg-alt" href="${startUrl(alt.key)}" target="_blank" rel="noopener">${esc(alt.text)}</a>` : ''}</div>`;
}

/**
 * Botón pequeño «Telegram» para una clave ya elegida (la lista de «Siguiendo»), o '' si no hay bot.
 * @param {string} key  @param {string} [name]  su nombre, para el texto accesible
 */
export function telegramLink(key, name = '') {
  if (!bot || typeof key !== 'string' || !KEY_RE.test(key)) return '';
  // El bot habla en español: con la web en inglés, el texto accesible lo dice.
  const label = name ? t('Avisos por Telegram de {name}', { name: followNameText(name) }) : t('Avisos por Telegram');
  return `<a class="tg-mini" href="${startUrl(key)}" target="_blank" rel="noopener" aria-label="${esc(label)}" title="${esc(label)}">${PLANE}<span>${t('Avisos en Telegram')}</span></a>`;
}
