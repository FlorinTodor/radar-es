// Caso de uso: el bot «Sigue tu tren». Atiende lo que escribe cada chat (seguir, dejar, estado, provincia…) y,
// en cada ronda (`tick`), avisa de lo nuevo de lo que sigue. No sabe nada de Telegram: recibe mensajes ya
// leídos ({ chatId, text } o { chatId, callback }) y devuelve respuestas ({ chatId, text, buttons }); el
// adaptador de entrada (adapters/inbound/telegram) las trae y las lleva. Vale para cualquier vehículo: lo que se
// sigue son claves `follow` (domain/seguir.js), sin mirar de qué fuente ni de qué tipo es.
// Cada chat tiene su idioma (domain/seguidos/idioma.js): español salvo que elija otro con /idioma, con un botón o
// desde la web en inglés (su enlace lo dice). Se guarda con lo demás del chat; mientras no siga nada, sólo en
// memoria, como todo lo de quien no sigue nada.
import { isFollowKey, followKind, stopCode } from '../../domain/seguir.js';
import { entryLabel, guessedName, knownNames, searchDirectory, updateDirectory } from '../../domain/seguidos/directorio.js';
import {
  DELAY_MIN, SEEN_MAX, collectFacts, factsMessage, fitMessage, madridDay, madridHourMinute, newFacts, packBlocks, provinceSub,
  statusOf, trackFacts,
} from '../../domain/seguidos/avisos.js';
import {
  LANG_NAMES, botProfiles, commandsFor, dataText, helpText, langLabel, parseCommand, parseHour, smallTalk, smallTalkText, welcomeText,
} from '../../domain/seguidos/ordenes.js';
import {
  BOT_LANGS, DEFAULT_LANG, ES, frase, isBotLang, offerEnglish, parseLang, parseStartPayload, translator,
} from '../../domain/seguidos/idioma.js';
import { cutText } from '../../domain/seguidos/texto.js';
import { countEvent, emptyTotals, parseTotals, usageOf } from '../../domain/seguidos/uso.js';
import { findProvince, provinceById } from '../../domain/provincias.js';

/** Topes: chats en total, cosas seguidas por chat (provincias incluidas), provincias por chat y menús. */
export const LIMITS = Object.freeze({
  chats: 20_000, subsPerChat: 20, provincesPerChat: 5, menuItems: 8, menuTtlMs: 30 * 60_000, delayMin: DELAY_MIN,
  // Mensajes por minuto de un mismo chat: más es una inundación (cada búsqueda recorre el directorio entero).
  messagesPerMinute: 20,
});
// Lo que se sigue aunque no haya nada que avisar: cada tanto se guarda igualmente (la hora de la última ronda).
const SAVE_EVERY_MS = 10 * 60_000;
// El directorio de lo que se puede seguir se pone al día como mucho cada tanto (son miles de vehículos).
const DIRECTORY_EVERY_MS = 5 * 60_000;
const BUTTON_MAX = 60;
const EN = translator('en');

const num = (x) => (Number.isFinite(x) ? x : 0);
const clipLabel = (s) => cutText(s, BUTTON_MAX);

/** La web en un idioma: la de siempre o, en otro, con ?lang= (la web en inglés se enlaza así). */
function webIn(webUrl, lang) {
  if (lang === DEFAULT_LANG) return webUrl;
  try {
    const url = new URL(webUrl);
    url.searchParams.set('lang', lang);
    return url.href;
  } catch {
    return webUrl;
  }
}

/**
 * @typedef {{ chatId: number, text: string, buttons?: Array<Array<{ text: string, data: string }>> }} Reply
 * @typedef {{ chatId: number, text?: string, callback?: string, callbackId?: string, clientLang?: string }} Incoming
 *   clientLang: el idioma del Telegram de quien escribe (language_code), sólo para ofrecerle el inglés.
 * @typedef {{ replies: Reply[], answer?: string, menu?: { chatId: number, commands: Array<[string, string]> } }} Handled
 *   menu: el menú de órdenes de ese chat cambia (ha elegido otro idioma).
 */

/**
 * @param {{ read: { vehicles: () => object[], events: () => object[], station?: (code: string) => object|null },
 *           store: import('../ports.js').FollowStorePort, clock: import('../ports.js').ClockPort,
 *           creditOf?: (source: string, operator?: string) => string|null, webUrl: string,
 *           log?: import('../ports.js').LoggerPort, limits?: Partial<typeof LIMITS> }} deps
 *   read: lo que se ve ahora (query-situation: vehículos, incidencias en vigor y la ficha de una estación).
 *   creditOf: la atribución que pide la licencia de una fuente (por su id y, si agrupa a varios, el operador).
 */
export function makeFollowBot({ read, store, clock, creditOf = () => null, webUrl, log, limits: custom = {} }) {
  const limits = { ...LIMITS, ...custom };
  /** @type {Map<number, { id: number, since: number, subs: Map<string, { name: string, since: number, checkedAt: number }>,
   *   provinces: Map<string, { since: number, checkedAt: number }>, digest: string|null, digestDay: string|null, lang: string }>} */
  let chats = new Map();
  let seen = new Map();
  let offset = 0;
  const directory = new Map();
  const menus = new Map(); // chat → { kind: 'add'|'drop', items, at }: los botones de la última lista
  const rate = new Map(); // chat → { from, count }: sus mensajes del último minuto
  // El idioma de los chats que no siguen nada (sólo si no es el de siempre): en memoria, nunca en disco, como todo
  // lo de quien no sigue nada. Al seguir algo pasa a su chat.
  const spoken = new Map();
  // A quién se le ha ofrecido ya el inglés (en memoria): se ofrece una vez, no en cada /start.
  const offered = new Set();
  // Altas, bajas, avisos y mensajes por orden desde que se empezó a contar (domain/seguidos/uso.js): se guardan con
  // lo demás, así que un arranque o un relevo no los pone a cero.
  let totals = emptyTotals(clock.now());
  let dirty = false;
  let savedAt = 0;
  let directoryAt = -Infinity;
  let known = null; // operadores y ámbitos del directorio (knownNames), hasta que cambie
  let menuSeq = 0;
  const webs = Object.fromEntries(BOT_LANGS.map((l) => [l, webIn(webUrl, l)]));
  /** La web que se cita a un chat, en su idioma. */
  const web = (tr) => webs[tr.lang] ?? webUrl;
  /** Pone al día el directorio si hace falta: cada DIRECTORY_EVERY_MS o, con `key`, si aún no la tiene. */
  const refreshDirectory = (c, key = null) => {
    if (c.now - directoryAt < DIRECTORY_EVERY_MS && (!key || directory.has(key))) return;
    updateDirectory(directory, c);
    directoryAt = c.now;
    known = null;
  };
  const knownOf = () => (known ??= knownNames(directory));
  const note = (event, detail = '') => {
    countEvent(totals, event, detail);
    dirty = true;
  };

  /** El idioma de un chat: el de su chat guardado, el elegido sin seguir nada o el de siempre. */
  const langOf = (chatId) => chats.get(chatId)?.lang ?? spoken.get(chatId) ?? DEFAULT_LANG;
  const trOf = (chatId) => translator(langOf(chatId));
  /** Recuerda en memoria el idioma de un chat que no sigue nada (el más viejo sale si hay demasiados). */
  const remember = (chatId, lang) => {
    spoken.delete(chatId);
    if (lang === DEFAULT_LANG) return;
    spoken.set(chatId, lang);
    if (spoken.size > limits.chats) spoken.delete(spoken.keys().next().value);
  };
  function setLang(chatId, lang) {
    const chat = chats.get(chatId);
    if (!chat) return remember(chatId, lang);
    if (chat.lang !== lang) {
      chat.lang = lang;
      dirty = true;
    }
  }

  const stationOf = (code) => (code && read.station ? read.station(code) : null);
  const ctx = () => ({ vehicles: read.vehicles(), events: read.events(), now: clock.now(), stationOf, creditOf });
  const reply = (chatId, text, buttons) => ({ chatId, text: fitMessage(text), ...(buttons?.length ? { buttons } : {}) });
  const count = (chat) => (chat ? chat.subs.size + chat.provinces.size : 0);
  const provinceTitle = (p, tr) => tr.t('Avisos en {province}', { province: p.name });

  /** El nombre de lo que se ve (directorio o catálogo de estaciones), en español como se guarda; null si ahora no se conoce. */
  function knownName(key) {
    if (followKind(key) === 'parada') {
      const st = stationOf(stopCode(key));
      return st?.name ? ES.t('Estación {name}', { name: st.name }) : null;
    }
    return directory.get(key)?.name ?? null;
  }

  // Algo que no se ve ahora (un enlace guardado, o de noche tras un reinicio): un nombre sin el texto libre de su
  // clave, que se puede inventar (guessedName); se renueva cuando se vuelve a ver (tick).
  const nameOf = (key) => knownName(key) ?? guessedName(key, knownOf()) ?? (followKind(key) === 'parada' ? frase('esa estación') : frase('eso'));

  /** Cómo está ahora, en texto: sus líneas y sus fuentes. */
  function statusText(sub, c, tr) {
    const { lines, credits } = statusOf(sub, { ...c, tr });
    return [lines.join('\n'), credits.length ? credits.join(' · ') : null].filter(Boolean).join('\n\n');
  }

  /** Lo que ya se ve de algo al empezar a seguirlo no se avisa: se cuenta en la respuesta. */
  function baseline(sub, c) {
    const facts = sub.startsWith('prov:')
      ? collectFacts({ keys: [], provinces: [sub.slice(5)], ...c })
      : collectFacts({ keys: [sub], ...c });
    seen = trackFacts(seen, facts, c.now);
  }

  function chatFor(chatId, now) {
    let chat = chats.get(chatId);
    if (chat) return chat;
    if (chats.size >= limits.chats) return null;
    chat = { id: chatId, since: now, subs: new Map(), provinces: new Map(), digest: null, digestDay: null, lang: langOf(chatId) };
    spoken.delete(chatId);
    chats.set(chatId, chat);
    note('alta');
    return chat;
  }

  /** Quita un chat que ya no sigue nada: no se guarda nada de quien no sigue nada (su idioma, sólo en memoria). */
  function dropIfEmpty(chat) {
    if (chat && !count(chat) && chats.delete(chat.id)) {
      remember(chat.id, chat.lang);
      note('baja', 'dejar');
    }
  }

  function follow(chatId, key, name = null) {
    const tr = trOf(chatId);
    const { t } = tr;
    if (!isFollowKey(key)) return [reply(chatId, t('Eso no es algo que se pueda seguir. Búscalo con /seguir o desde la web.'))];
    const c = ctx();
    const station = followKind(key) === 'parada';
    // Una estación está en el catálogo o no existe: de una que no está nunca llegaría nada.
    if (station && !stationOf(stopCode(key))) {
      return [reply(chatId, t('Esa estación no la encuentro en el catálogo del radar. Búscala en el mapa y pulsa «Avísame por Telegram» en su ficha: {web}',
        { web: web(tr) }))];
    }
    // Un enlace de la web trae sólo la clave: su nombre, de lo que se ve ahora.
    if (!name && !station) refreshDirectory(c, key);
    const existing = chats.get(chatId);
    if (existing?.subs.has(key)) {
      return [reply(chatId, `${t('Ya sigues {name}.', { name: tr.name(existing.subs.get(key).name) })}\n\n${t('Ahora:')}\n${statusText(key, c, tr)}`)];
    }
    if (count(existing) >= limits.subsPerChat) {
      return [reply(chatId, t('Ya sigues {n} cosas, el máximo. Deja alguna con /dejar.', { n: limits.subsPerChat }))];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, t('Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.'))];
    const label = name ?? knownName(key);
    baseline(key, c);
    chat.subs.set(key, label ? { name: label, since: c.now, checkedAt: c.now } : { name: nameOf(key), since: c.now, checkedAt: c.now, guessed: true });
    dirty = true;
    return [reply(chatId, `${t('Hecho: te aviso de {name}.', { name: tr.name(chat.subs.get(key).name) })}\n\n${t('Ahora:')}\n${statusText(key, c, tr)}`
      + `\n\n${t('/mis para ver lo que sigues · /dejar para dejar de seguirlo')}`)];
  }

  function followProvince(chatId, p) {
    const tr = trOf(chatId);
    const { t } = tr;
    const sub = provinceSub(p.id);
    const c = ctx();
    const existing = chats.get(chatId);
    if (existing?.provinces.has(p.id)) {
      return [reply(chatId, `${t('Ya sigues los avisos de {province}.', { province: p.name })}\n\n${t('Ahora:')}\n${statusText(sub, c, tr)}`)];
    }
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, t('Ya sigues {n} cosas, el máximo. Deja alguna con /dejar.', { n: limits.subsPerChat }))];
    if ((existing?.provinces.size ?? 0) >= limits.provincesPerChat) {
      return [reply(chatId, t('Ya sigues {n} provincias, el máximo. Deja alguna con /dejar.', { n: limits.provincesPerChat }))];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, t('Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.'))];
    baseline(sub, c);
    chat.provinces.set(p.id, { since: c.now, checkedAt: c.now });
    dirty = true;
    return [reply(chatId, `${t('Hecho: te aviso en {province} de los avisos naranja y rojo de AEMET, de los terremotos que puedan '
      + 'sentirse y de los avisos oficiales (planes de emergencia y cortes de luz). La zona de cada provincia es aproximada: '
      + 'cerca de su límite puede llegarte alguno de la vecina.', { province: p.name })}\n\n${t('Ahora:')}\n${statusText(sub, c, tr)}`)];
  }

  /**
   * Lo que sigue un chat, en orden: lo que se ve en /mis y lo que numeran /dejar y los botones. `name`, en el idioma
   * del chat; `saved`, el nombre guardado (en español), para buscarlo también por él.
   */
  function listOf(chat, tr) {
    if (!chat) return [];
    return [
      ...[...chat.subs].map(([key, s]) => ({ sub: key, name: tr.name(s.name), saved: s.name })),
      ...[...chat.provinces.keys()].map((id) => ({ sub: provinceSub(id), name: provinceTitle(provinceById(id), tr), saved: provinceById(id).name })),
    ];
  }

  function unfollow(chatId, sub) {
    const tr = trOf(chatId);
    const { t } = tr;
    const chat = chats.get(chatId);
    if (!chat) return [reply(chatId, t('No sigues nada.'))];
    let name = null;
    if (sub.startsWith('prov:')) {
      const id = sub.slice(5);
      if (chat.provinces.delete(id)) name = provinceTitle(provinceById(id), tr);
    } else if (chat.subs.has(sub)) {
      name = tr.name(chat.subs.get(sub).name);
      chat.subs.delete(sub);
    }
    if (!name) return [reply(chatId, t('Eso ya no lo sigues.'))];
    dirty = true;
    dropIfEmpty(chat);
    return [reply(chatId, chats.has(chatId) ? t('Hecho: ya no te aviso de {name}.', { name })
      : t('Hecho: ya no te aviso de {name}. No sigues nada más, así que no guardo nada de este chat.', { name }))];
  }

  /**
   * Los botones de una lista. Cada lista lleva su id en los botones («a:<id>:<n>», muy por debajo de los 64 bytes
   * de Telegram): los mensajes viejos siguen en el chat con sus botones, y sin el id un botón de una lista
   * anterior escogía lo que estuviera en ese puesto de la última.
   */
  function menu(chatId, kind, items, now) {
    menuSeq = (menuSeq + 1) % 1296;
    const id = `${Math.floor(now / 1000).toString(36).slice(-5)}${menuSeq.toString(36).padStart(2, '0')}`;
    menus.set(chatId, { kind, id, items, at: now });
    return items.map((it, i) => [{ text: clipLabel(it.label ?? it.name), data: `${kind === 'add' ? 'a' : 'd'}:${id}:${i}` }]);
  }

  /** Busca lo que se quiere seguir. Con `confirm` (texto sin orden), aunque sólo haya uno, se pregunta con un botón. */
  function search(chatId, arg, { confirm = false } = {}) {
    const tr = trOf(chatId);
    const { t } = tr;
    const c = ctx();
    if (!arg) {
      return [reply(chatId, t('Dime qué quieres seguir: un número de tren («08058»), una línea con su ciudad u operador («C4 Madrid», '
        + '«27 EMT Málaga») o una provincia (/provincia Valencia).'))];
    }
    if (isFollowKey(arg)) return follow(chatId, arg);
    refreshDirectory(c);
    const all = searchDirectory(directory, arg, { limit: Infinity });
    const found = all.slice(0, limits.menuItems);
    if (!found.length) {
      const p = findProvince(arg);
      if (p) return followProvince(chatId, p);
      return [reply(chatId, t('No encuentro nada así entre lo que circula ahora o ha circulado hace poco. Prueba con el número '
        + '(«08058»), la línea y su ciudad u operador («C4 Madrid»), o búscalo en el mapa y pulsa «Avísame por Telegram» en su ficha: {web}',
      { web: web(tr) }))];
    }
    if (found.length === 1 && !confirm) return follow(chatId, found[0].key, found[0].name);
    // Se sigue con el nombre en español (el que se guarda); el botón, en el idioma del chat.
    const buttons = menu(chatId, 'add', found.map((e) => ({ sub: e.key, name: e.name, label: tr.name(entryLabel(e)) })), c.now);
    // Si hay más de las que caben en la lista, se dice: quien busca «C1» sabe que tiene que decir la ciudad.
    const text = found.length === 1 ? t('¿Quieres seguir esto?')
      : all.length > found.length ? t('He encontrado {total}; aquí van las {n} primeras. Si no está la que buscas, añade la '
        + 'ciudad o el operador («C1 Madrid», «27 EMT Málaga»). ¿Cuál quieres seguir?', { total: all.length, n: found.length })
        : t('He encontrado varias cosas. ¿Cuál quieres seguir?');
    return [reply(chatId, text, buttons)];
  }

  function status(chatId, arg) {
    const tr = trOf(chatId);
    const { t } = tr;
    const c = ctx();
    const chat = chats.get(chatId);
    const blocks = [];
    if (!arg) {
      if (!chat) return [reply(chatId, t('No sigues nada todavía. Dime qué quieres seguir con /seguir, o mira cómo va algo: /estado 08058.'))];
      for (const it of listOf(chat, tr)) blocks.push(`${it.name}:\n${statusText(it.sub, c, tr)}`);
    } else if (isFollowKey(arg)) {
      if (followKind(arg) !== 'parada') refreshDirectory(c, arg);
      blocks.push(`${tr.name(nameOf(arg))}:\n${statusText(arg, c, tr)}`);
    } else {
      refreshDirectory(c);
      const found = searchDirectory(directory, arg, { limit: 3 });
      const p = !found.length ? findProvince(arg) : null;
      if (p) blocks.push(`${provinceTitle(p, tr)}:\n${statusText(provinceSub(p.id), c, tr)}`);
      for (const e of found) blocks.push(`${tr.name(entryLabel(e))}:\n${statusText(e.key, c, tr)}`);
      if (!blocks.length) return [reply(chatId, t('No encuentro nada así entre lo que circula ahora o ha circulado hace poco.'))];
    }
    return packed(blocks, tr).map((text) => reply(chatId, text));
  }

  /** Lo de cada cosa seguida, entero, en uno o varios mensajes (packBlocks), con la web al final. */
  const packed = (blocks, tr) => packBlocks(blocks, {
    footer: tr.t('Más en {web}', { web: web(tr) }),
    more: (n) => tr.tn('…y otra cosa que no cabe aquí: pídela con /estado y su nombre, o mírala en la web.',
      '…y {n} cosas más que no caben aquí: pídelas con /estado y su nombre, o míralas en la web.', n),
  });

  function provinceCmd(chatId, arg) {
    const { t } = trOf(chatId);
    if (!arg) return [reply(chatId, t('Dime la provincia: /provincia Valencia, /provincia A Coruña, /provincia Bizkaia…'))];
    const p = findProvince(arg);
    if (!p) return [reply(chatId, t('No conozco la provincia «{name}». Escríbela como en el mapa: /provincia Valencia, /provincia Illes Balears…', { name: arg }))];
    return followProvince(chatId, p);
  }

  function mine(chatId) {
    const tr = trOf(chatId);
    const { t } = tr;
    const chat = chats.get(chatId);
    const list = listOf(chat, tr);
    if (!list.length) return [reply(chatId, t('No sigues nada. Dime qué quieres seguir con /seguir.'))];
    return [reply(chatId, [t('Sigues:'), list.map((it, i) => `${i + 1}. ${it.name}`).join('\n'),
      chat.digest ? t('Parte diario: a las {hour}.', { hour: chat.digest }) : null, t('Para dejar algo: /dejar (o /dejar y su número).')]
      .filter(Boolean).join('\n\n'))];
  }

  function drop(chatId, arg) {
    const tr = trOf(chatId);
    const { t } = tr;
    const list = listOf(chats.get(chatId), tr);
    if (!list.length) return [reply(chatId, t('No sigues nada.'))];
    // Un número es el de /mis: si no está en la lista, se dice, sin buscar esa cifra en los nombres (con «/dejar 4»
    // y tres cosas se dejaba de seguir el «AVE 04375»).
    if (/^[+-]?\d+(?:[.,]\d+)?$/.test(arg)) {
      const n = Number(arg.replace(',', '.'));
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return unfollow(chatId, list[n - 1].sub);
      const text = list.length === 1 ? t('En tu lista no hay un {n}: sólo tiene el 1. ¿Qué quieres dejar de seguir?', { n: arg })
        : t('En tu lista no hay un {n}: va del 1 al {max}. ¿Qué quieres dejar de seguir?', { n: arg, max: list.length });
      return [reply(chatId, text, menu(chatId, 'drop', list, clock.now()))];
    }
    if (arg) {
      // Por su nombre en el idioma del chat o por el guardado («Bus 27» o «Autobús 27»).
      const q = arg.toLowerCase();
      const hits = list.filter((it) => it.name.toLowerCase().includes(q) || it.saved.toLowerCase().includes(q));
      if (hits.length === 1) return unfollow(chatId, hits[0].sub);
    }
    return [reply(chatId, t('¿Qué quieres dejar de seguir?'), menu(chatId, 'drop', list, clock.now()))];
  }

  function digestCmd(chatId, arg) {
    const { t } = trOf(chatId);
    const chat = chats.get(chatId);
    if (!chat) return [reply(chatId, t('Primero sigue algo (/seguir): el parte cuenta cómo va lo que sigues.'))];
    if (/^(?:no|off|nada|ninguno|quitar|none|cancel)$/i.test(arg)) {
      chat.digest = null;
      dirty = true;
      return [reply(chatId, t('Hecho: ya no te mando el parte diario.'))];
    }
    const hour = parseHour(arg);
    if (!hour) return [reply(chatId, t('Dime la hora, en hora peninsular: /parte 07:30. Para quitarlo: /parte no.'))];
    const now = clock.now();
    chat.digest = hour;
    // Si hoy ya ha pasado esa hora, el primero es mañana.
    chat.digestDay = madridHourMinute(now) >= hour ? madridDay(now) : null;
    dirty = true;
    return [reply(chatId, t('Hecho: cada día a las {hour} (hora peninsular) te mando cómo va lo que sigues.', { hour }))];
  }

  function erase(chatId) {
    const { t } = trOf(chatId);
    const chat = chats.get(chatId);
    menus.delete(chatId);
    if (chat) {
      chats.delete(chatId);
      // Lo guardado se borra entero; el idioma, mientras dure la conversación, sólo en memoria.
      remember(chatId, chat.lang);
      note('baja', 'baja');
    }
    return [reply(chatId, chat ? t('Hecho: he borrado todo lo de este chat. Si vuelves a seguir algo, empezará de cero.')
      : t('De este chat no tenía nada guardado.'))];
  }

  function data(chatId) {
    const tr = trOf(chatId);
    const chat = chats.get(chatId);
    const view = chat && {
      id: chat.id, since: chat.since, digest: chat.digest, lang: chat.lang,
      subs: [...chat.subs.values()].map((s) => ({ name: tr.name(s.name) })),
      provinces: [...chat.provinces.keys()].map((id) => ({ name: provinceById(id)?.name ?? id })),
    };
    return [reply(chatId, dataText(view, { tr }))];
  }

  function start(chatId, arg) {
    // La web en inglés pone el idioma delante de la clave («en-s-renfe-8058»): el bot habla ya en ese idioma.
    const { lang, rest } = parseStartPayload(arg);
    if (lang) setLang(chatId, lang);
    if (isFollowKey(rest)) return follow(chatId, rest);
    const prov = /^prov-([a-z0-9-]{2,40})$/.exec(rest);
    if (prov && provinceById(prov[1])) return followProvince(chatId, provinceById(prov[1]));
    const tr = trOf(chatId);
    return [reply(chatId, welcomeText({ webUrl: web(tr), limits, tr }))];
  }

  /** Los botones para elegir idioma: cada uno, con su nombre en su idioma. */
  const langButtons = (langs = BOT_LANGS) => langs.map((l) => [{ text: langLabel(l), data: `l:${l}` }]);

  /** /idioma: con el idioma, lo cambia; sin él (o si no se entiende), pregunta en todos con un botón por idioma. */
  function language(chatId, arg) {
    const lang = parseLang(arg);
    if (lang) return changeLang(chatId, lang);
    const ask = BOT_LANGS.map((l) => translator(l).t('¿En qué idioma te escribo?')).join(' · ');
    return { replies: [reply(chatId, ask, langButtons())] };
  }

  /** @returns {Handled} */
  function changeLang(chatId, lang) {
    setLang(chatId, lang);
    const tr = trOf(chatId);
    return {
      replies: [reply(chatId, tr.t('Hecho: a partir de ahora te escribo en {lang}. /ayuda para ver lo que hago; /idioma para cambiarlo.',
        { lang: tr.t(LANG_NAMES[lang]) }))],
      answer: tr.t('Hecho'),
      // Su menú de órdenes, en su idioma (sin esto, el que corresponde al idioma de su Telegram).
      menu: { chatId, commands: commandsFor(lang) },
    };
  }

  /** @returns {Handled} */
  function callback(chatId, dataStr) {
    const { t } = trOf(chatId);
    // Un botón de idioma vale siempre: no es de una lista.
    const chosen = /^l:([a-z]{2})$/.exec(String(dataStr ?? ''));
    if (chosen && isBotLang(chosen[1])) return changeLang(chatId, chosen[1]);
    const m = /^([ad]):([0-9a-z]{1,8}):(\d{1,2})$/.exec(String(dataStr ?? ''));
    const open = menus.get(chatId);
    // Sólo vale la última lista de cada chat, y un rato: un botón de un mensaje anterior no escoge nada.
    if (!m || !open || open.id !== m[2] || clock.now() - open.at > limits.menuTtlMs || open.kind !== (m[1] === 'a' ? 'add' : 'drop')) {
      return {
        replies: [reply(chatId, t('Esa lista ya no vale: es de antes (has pedido otra después o ha pasado mucho rato). Vuelve a buscarlo, por favor.'))],
        answer: t('Lista caducada'),
      };
    }
    const item = open.items[Number(m[3])];
    if (!item) return { replies: [], answer: t('No está en la lista') };
    menus.delete(chatId);
    if (open.kind === 'drop') return { replies: unfollow(chatId, item.sub), answer: t('Hecho') };
    return { replies: follow(chatId, item.sub, item.name), answer: t('Hecho') };
  }

  return {
    /** Lo guardado (al arrancar o al pasar a ser el servidor que atiende el bot): lo de memoria se cambia por ello. */
    async load() {
      const saved = await store.load();
      chats = new Map();
      seen = new Map();
      offset = 0;
      totals = parseTotals(saved?.version === 1 ? saved.totals : null, clock.now());
      if (!saved || saved.version !== 1) return 0;
      offset = Number.isSafeInteger(saved.offset) ? saved.offset : 0;
      for (const c of Array.isArray(saved.chats) ? saved.chats.slice(0, limits.chats) : []) {
        if (!Number.isSafeInteger(c?.id)) continue;
        const subs = new Map();
        for (const s of Array.isArray(c.subs) ? c.subs.slice(0, limits.subsPerChat) : []) {
          if (!isFollowKey(s?.key) || typeof s.name !== 'string') continue;
          subs.set(s.key, { name: cutText(s.name, 200), since: num(s.since), checkedAt: num(s.checkedAt), ...(s.guessed === true ? { guessed: true } : {}) });
        }
        const provinces = new Map();
        for (const p of Array.isArray(c.provinces) ? c.provinces.slice(0, limits.provincesPerChat) : []) {
          if (provinceById(p?.id)) provinces.set(p.id, { since: num(p.since), checkedAt: num(p.checkedAt) });
        }
        if (!subs.size && !provinces.size) continue;
        chats.set(c.id, {
          id: c.id, since: num(c.since), subs, provinces, digest: parseHour(c.digest),
          digestDay: /^\d{4}-\d{2}-\d{2}$/.test(c.digestDay ?? '') ? c.digestDay : null,
          // Los guardados antes de haber idiomas, y lo que llegue mal, en el de siempre.
          lang: isBotLang(c.lang) ? c.lang : DEFAULT_LANG,
        });
      }
      for (const row of Array.isArray(saved.seen) ? saved.seen.slice(0, SEEN_MAX) : []) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && Number.isFinite(row[2])) seen.set(row[0], { first: row[1], last: row[2] });
      }
      dirty = false;
      if (saved.totals === undefined && chats.size) {
        // Un fichero de antes de los totales: quienes ya siguen algo cuentan como altas, desde la primera (las bajas de
        // entonces no constan). Se guarda en la siguiente ronda.
        totals.added = chats.size;
        totals.since = [...chats.values()].reduce((min, c) => (c.since > 0 && c.since < min ? c.since : min), totals.since);
        dirty = true;
      }
      return chats.size;
    },

    /** Lo que hay que guardar para seguir igual tras un reinicio o un relevo. El idioma, sólo si no es el de siempre. */
    snapshot() {
      return {
        version: 1,
        offset,
        chats: [...chats.values()].map((c) => ({
          id: c.id, since: c.since, digest: c.digest, digestDay: c.digestDay, ...(c.lang !== DEFAULT_LANG ? { lang: c.lang } : {}),
          subs: [...c.subs].map(([key, s]) => ({ key, name: s.name, since: s.since, checkedAt: s.checkedAt, ...(s.guessed ? { guessed: true } : {}) })),
          provinces: [...c.provinces].map(([id, s]) => ({ id, since: s.since, checkedAt: s.checkedAt })),
        })),
        seen: [...seen].map(([k, v]) => [k, v.first, v.last]),
        totals: structuredClone(totals),
      };
    },

    /**
     * Guarda si ha cambiado algo; con `force`, también cada SAVE_EVERY_MS (por la hora de la última ronda); con
     * `always`, siempre (al apagarse).
     */
    async save({ force = false, always = false } = {}) {
      const now = clock.now();
      if (!always && !dirty && !(force && now - savedAt >= SAVE_EVERY_MS)) return false;
      dirty = false;
      savedAt = now;
      await store.save(this.snapshot());
      return true;
    },

    get offset() {
      return offset;
    },
    setOffset(n) {
      if (Number.isSafeInteger(n) && n > offset) {
        offset = n;
        dirty = true;
      }
    },

    /**
     * Lo que Telegram enseña del bot en cada idioma: su menú de órdenes, su descripción y su descripción corta. El
     * primero, el de siempre (para quien no tiene Telegram en ninguno de los otros).
     */
    profiles: () => botProfiles(),

    /**
     * Un mensaje de un chat: lo que contesta el bot y, si era un botón, el texto breve que lo confirma; si el chat
     * ha cambiado de idioma, su menú de órdenes nuevo.
     * @param {Incoming} msg
     * @returns {Handled}
     */
    handle(msg) {
      const chatId = msg?.chatId;
      if (!Number.isSafeInteger(chatId)) return { replies: [] };
      const now = clock.now();
      const r = rate.get(chatId);
      if (!r || now - r.from >= 60_000) {
        if (rate.size > 2 * limits.chats) for (const [id, x] of rate) if (now - x.from >= 60_000) rate.delete(id);
        rate.set(chatId, { from: now, count: 1 });
      } else if (++r.count > limits.messagesPerMinute) {
        // Se avisa una vez; lo demás de ese minuto se ignora.
        note('orden', 'limite');
        return { replies: r.count === limits.messagesPerMinute + 1 ? [reply(chatId, trOf(chatId).t('Demasiados mensajes seguidos. Espera un minuto, por favor.'))] : [] };
      }
      if (msg.callback !== undefined) {
        note('orden', 'boton');
        return callback(chatId, msg.callback);
      }
      const { command, arg } = parseCommand(msg.text);
      const payload = command === 'start' ? parseStartPayload(arg) : null;
      // /start con una clave o una provincia: llega desde un enlace de la web («Avísame por Telegram»).
      note('orden', payload && (isFollowKey(payload.rest) || /^prov-/.test(payload.rest)) ? 'enlace' : command);
      // La primera vez (nada de este chat, ni en memoria), si su Telegram está en otro idioma, se le ofrece el inglés.
      const offer = payload && !payload.lang && !chats.has(chatId) && !spoken.has(chatId) && !offered.has(chatId) && offerEnglish(msg.clientLang);
      const run = {
        start: () => start(chatId, arg),
        seguir: () => search(chatId, arg),
        // Texto sin orden: una búsqueda, salvo que sea charla («hola», «gracias», «vale»).
        buscar: () => {
          const talk = smallTalk(arg);
          if (!talk) return search(chatId, arg, { confirm: true });
          const tr = trOf(chatId);
          return [reply(chatId, talk === 'ayuda' ? helpText({ webUrl: web(tr), limits, tr }) : smallTalkText(talk, tr))];
        },
        estado: () => status(chatId, arg),
        provincia: () => provinceCmd(chatId, arg),
        mis: () => mine(chatId),
        dejar: () => drop(chatId, arg),
        parte: () => digestCmd(chatId, arg),
        datos: () => data(chatId),
        baja: () => erase(chatId),
        idioma: () => language(chatId, arg),
        ayuda: () => {
          const tr = trOf(chatId);
          return [reply(chatId, helpText({ webUrl: web(tr), limits, tr }))];
        },
      }[command];
      const out = run ? run() : [reply(chatId, trOf(chatId).t('No conozco esa orden. Mira /ayuda.'))];
      const handled = Array.isArray(out) ? { replies: out } : out;
      if (offer && langOf(chatId) === DEFAULT_LANG) {
        if (offered.size >= limits.chats) offered.clear();
        offered.add(chatId);
        handled.replies.push(reply(chatId, EN.t('¿Prefieres que te escriba en inglés? Pulsa el botón, o escribe /idioma cuando quieras.'),
          langButtons(['en'])));
      }
      return handled;
    },

    /**
     * Una ronda: pone al día el directorio y avisa a cada chat de lo nuevo de lo que sigue (un mensaje por cosa
     * seguida, en su idioma) y, si le toca, le manda el parte diario.
     * @returns {Reply[]}
     */
    tick() {
      const c = ctx();
      const { now } = c;
      refreshDirectory(c);
      for (const [id, m] of menus) if (now - m.at > limits.menuTtlMs) menus.delete(id);
      // Lo que sigue cada idioma: los hechos se buscan una vez para todos (en español, que da sus ids) y, para los
      // demás idiomas, otra vez sólo con lo que siguen sus chats.
      const keys = new Map(BOT_LANGS.map((l) => [l, new Set()]));
      const provinces = new Map(BOT_LANGS.map((l) => [l, new Set()]));
      for (const chat of chats.values()) {
        for (const k of chat.subs.keys()) keys.get(chat.lang).add(k);
        for (const p of chat.provinces.keys()) provinces.get(chat.lang).add(p);
      }
      const allKeys = new Set(BOT_LANGS.flatMap((l) => [...keys.get(l)]));
      const allProvinces = new Set(BOT_LANGS.flatMap((l) => [...provinces.get(l)]));
      if (!allKeys.size && !allProvinces.size) return [];
      const facts = collectFacts({ keys: allKeys, provinces: allProvinces, ...c });
      seen = trackFacts(seen, facts, now);
      const factsIn = new Map([[DEFAULT_LANG, facts]]);
      /** Los hechos nuevos de una suscripción, con su texto en el idioma del chat (los mismos ids, en el mismo orden). */
      const sayIn = (lang, sub, fresh) => {
        if (lang === DEFAULT_LANG) return fresh;
        if (!factsIn.has(lang)) factsIn.set(lang, collectFacts({ keys: keys.get(lang), provinces: provinces.get(lang), ...c, tr: translator(lang) }));
        const ids = new Set(fresh.map((f) => f.id));
        return (factsIn.get(lang).get(sub) ?? []).filter((f) => ids.has(f.id));
      };
      const out = [];
      const today = madridDay(now);
      const hour = madridHourMinute(now);
      for (const chat of chats.values()) {
        const tr = translator(chat.lang);
        for (const [key, s] of chat.subs) {
          // Lo que se siguió sin verse lleva un nombre provisional: el de verdad, en cuanto se vuelve a ver.
          if (s.guessed) {
            const name = knownName(key);
            if (name) {
              s.name = name;
              delete s.guessed;
              dirty = true;
            }
          }
          const fresh = newFacts(key, facts.get(key), seen, s.checkedAt);
          s.checkedAt = now;
          if (fresh.length) {
            out.push(reply(chat.id, factsMessage(tr.name(s.name), sayIn(chat.lang, key, fresh), { webUrl: web(tr), tr })));
            note('aviso', 'aviso');
          }
        }
        for (const [id, s] of chat.provinces) {
          const sub = provinceSub(id);
          const fresh = newFacts(sub, facts.get(sub), seen, s.checkedAt);
          s.checkedAt = now;
          if (fresh.length) {
            out.push(reply(chat.id, factsMessage(provinceTitle(provinceById(id), tr), sayIn(chat.lang, sub, fresh), { webUrl: web(tr), tr })));
            note('aviso', 'aviso');
          }
        }
        if (chat.digest && chat.digestDay !== today && hour >= chat.digest) {
          chat.digestDay = today;
          const blocks = listOf(chat, tr).map((it) => `${it.name}:\n${statusText(it.sub, c, tr)}`);
          for (const text of packed([tr.t('Parte de las {hour}:', { hour: chat.digest }), ...blocks], tr)) out.push(reply(chat.id, text));
          note('aviso', 'parte');
        }
      }
      if (out.length) dirty = true;
      return out;
    },

    /** Telegram dice que ese chat ya no existe o ha bloqueado el bot: se borra todo lo suyo, también de memoria. */
    forget(chatId) {
      menus.delete(chatId);
      spoken.delete(chatId);
      offered.delete(chatId);
      if (chats.delete(chatId)) {
        note('baja', 'bloqueo');
        log?.info(`[telegram] un chat ha bloqueado el bot o ya no existe: borrado (quedan ${chats.size})`);
      }
    },

    stats: () => ({ chats: chats.size, subs: [...chats.values()].reduce((n, c) => n + count(c), 0) }),

    /** Cuánto se usa, en conjunto y sin el número de ningún chat (domain/seguidos/uso.js): para las métricas. */
    usage: () => ({ ...usageOf(chats.values()), totals: structuredClone(totals) }),
  };
}
