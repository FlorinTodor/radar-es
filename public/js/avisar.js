// Botón «Avisarme por Telegram» de las fichas: abre el bot «Sigue tu tren» con la clave de lo que se quiere
// seguir (t.me/<bot>?start=<clave>; ver docs/telegram.md y domain/seguir.js). Para cualquier vehículo: sale de
// sus claves `follow`, y el nombre de cada tipo («tren», «autobús»…), del registro de tipos (/api/modes). Sólo si
// el servidor tiene bot: lo dice /api/about.
import { esc } from './format.js';

const KEY_RE = /^[slp]-[A-Za-z0-9_-]{1,62}$/;
const BOT_RE = /^[A-Za-z][A-Za-z0-9_]{1,28}[Bb][Oo][Tt]$/;
let bot = null;
let nouns = {};

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

/**
 * Los enlaces para seguir algo por Telegram, o '' si no hay bot o no tiene claves.
 * @param {string[]|string|undefined} follow  las claves de un vehículo o de un viaje (o la de una estación)
 * @param {string} [mode]  su tipo, para decir «este tren», «este autobús»…
 */
export function telegramFollow(follow, mode) {
  if (!bot) return '';
  const keys = (Array.isArray(follow) ? follow : [follow]).filter((k) => typeof k === 'string' && KEY_RE.test(k));
  const seen = new Set();
  const links = [];
  for (const key of keys) {
    const kind = key[0];
    if (seen.has(kind)) continue; // un servicio y una línea: la primera de cada
    seen.add(kind);
    const what = kind === 's' ? `de este ${nouns[mode] ?? 'servicio'}` : kind === 'l' ? 'de su línea' : 'de esta estación';
    links.push(`<a href="https://t.me/${esc(bot)}?start=${esc(key)}" target="_blank" rel="noopener">${what}</a>`);
  }
  return links.length ? `<p class="tg-follow">Avisarme por Telegram ${links.join(' · ')}</p>` : '';
}
