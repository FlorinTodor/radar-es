// Caso de uso: el bot «Sigue tu tren». Atiende lo que escribe cada chat (seguir, dejar, estado, provincia…) y,
// en cada ronda (`tick`), avisa de lo nuevo de lo que sigue. No sabe nada de Telegram: recibe mensajes ya
// leídos ({ chatId, text } o { chatId, callback }) y devuelve respuestas ({ chatId, text, buttons }); el
// adaptador de entrada (adapters/inbound/telegram) las trae y las lleva. Vale para cualquier vehículo: lo que se
// sigue son claves `follow` (domain/seguir.js), sin mirar de qué fuente ni de qué tipo es.
import { isFollowKey, followKind, stopCode } from '../../domain/seguir.js';
import { entryLabel, guessedName, knownNames, searchDirectory, updateDirectory } from '../../domain/seguidos/directorio.js';
import {
  DELAY_MIN, SEEN_MAX, collectFacts, factsMessage, fitMessage, fmtWhen, madridDay, madridHourMinute, newFacts, packBlocks, provinceSub,
  statusOf, trackFacts,
} from '../../domain/seguidos/avisos.js';
import { dataText, helpText, parseCommand, parseHour, smallTalk, smallTalkText, welcomeText } from '../../domain/seguidos/ordenes.js';
import { cutText } from '../../domain/seguidos/texto.js';
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

const num = (x) => (Number.isFinite(x) ? x : 0);
const clipLabel = (s) => cutText(s, BUTTON_MAX);

/**
 * @typedef {{ chatId: number, text: string, buttons?: Array<Array<{ text: string, data: string }>> }} Reply
 * @typedef {{ chatId: number, text?: string, callback?: string, callbackId?: string }} Incoming
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
   *   provinces: Map<string, { since: number, checkedAt: number }>, digest: string|null, digestDay: string|null }>} */
  let chats = new Map();
  let seen = new Map();
  let offset = 0;
  const directory = new Map();
  const menus = new Map(); // chat → { kind: 'add'|'drop', items, at }: los botones de la última lista
  const rate = new Map(); // chat → { from, count }: sus mensajes del último minuto
  let dirty = false;
  let savedAt = 0;
  let directoryAt = -Infinity;
  let known = null; // operadores y ámbitos del directorio (knownNames), hasta que cambie
  let menuSeq = 0;
  /** Pone al día el directorio si hace falta: cada DIRECTORY_EVERY_MS o, con `key`, si aún no la tiene. */
  const refreshDirectory = (c, key = null) => {
    if (c.now - directoryAt < DIRECTORY_EVERY_MS && (!key || directory.has(key))) return;
    updateDirectory(directory, c);
    directoryAt = c.now;
    known = null;
  };
  const knownOf = () => (known ??= knownNames(directory));

  const stationOf = (code) => (code && read.station ? read.station(code) : null);
  const ctx = () => ({ vehicles: read.vehicles(), events: read.events(), now: clock.now(), stationOf, creditOf });
  const reply = (chatId, text, buttons) => ({ chatId, text: fitMessage(text), ...(buttons?.length ? { buttons } : {}) });
  const count = (chat) => (chat ? chat.subs.size + chat.provinces.size : 0);
  const provinceTitle = (p) => `Avisos en ${p.name}`;

  /** El nombre de lo que se ve (directorio o catálogo de estaciones); null si ahora no se conoce. */
  function knownName(key) {
    if (followKind(key) === 'parada') {
      const st = stationOf(stopCode(key));
      return st?.name ? `Estación ${st.name}` : null;
    }
    return directory.get(key)?.name ?? null;
  }

  // Algo que no se ve ahora (un enlace guardado, o de noche tras un reinicio): un nombre sin el texto libre de su
  // clave, que se puede inventar (guessedName); se renueva cuando se vuelve a ver (tick).
  const nameOf = (key) => knownName(key) ?? guessedName(key, knownOf()) ?? (followKind(key) === 'parada' ? 'esa estación' : 'eso');

  /** Cómo está ahora, en texto: sus líneas y sus fuentes. */
  function statusText(sub, c = ctx()) {
    const { lines, credits } = statusOf(sub, c);
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
    chat = { id: chatId, since: now, subs: new Map(), provinces: new Map(), digest: null, digestDay: null };
    chats.set(chatId, chat);
    return chat;
  }

  /** Quita un chat que ya no sigue nada: no se guarda nada de quien no sigue nada. */
  function dropIfEmpty(chat) {
    if (chat && !count(chat)) chats.delete(chat.id);
  }

  function follow(chatId, key, name = null) {
    if (!isFollowKey(key)) return [reply(chatId, 'Eso no es algo que se pueda seguir. Búscalo con /seguir o desde la web.')];
    const c = ctx();
    const station = followKind(key) === 'parada';
    // Una estación está en el catálogo o no existe: de una que no está nunca llegaría nada.
    if (station && !stationOf(stopCode(key))) {
      return [reply(chatId, `Esa estación no la encuentro en el catálogo del radar. Búscala en el mapa y pulsa «Avísame por Telegram» en su ficha: ${webUrl}`)];
    }
    // Un enlace de la web trae sólo la clave: su nombre, de lo que se ve ahora.
    if (!name && !station) refreshDirectory(c, key);
    const existing = chats.get(chatId);
    if (existing?.subs.has(key)) return [reply(chatId, `Ya sigues ${existing.subs.get(key).name}.\n\nAhora:\n${statusText(key, c)}`)];
    if (count(existing) >= limits.subsPerChat) {
      return [reply(chatId, `Ya sigues ${limits.subsPerChat} cosas, el máximo. Deja alguna con /dejar.`)];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, 'Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.')];
    const label = name ?? knownName(key);
    baseline(key, c);
    chat.subs.set(key, label ? { name: label, since: c.now, checkedAt: c.now } : { name: nameOf(key), since: c.now, checkedAt: c.now, guessed: true });
    dirty = true;
    return [reply(chatId, `Hecho: te aviso de ${chat.subs.get(key).name}.\n\nAhora:\n${statusText(key, c)}\n\n/mis para ver lo que sigues · /dejar para dejar de seguirlo`)];
  }

  function followProvince(chatId, p) {
    const sub = provinceSub(p.id);
    const c = ctx();
    const existing = chats.get(chatId);
    if (existing?.provinces.has(p.id)) return [reply(chatId, `Ya sigues los avisos de ${p.name}.\n\nAhora:\n${statusText(sub, c)}`)];
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, `Ya sigues ${limits.subsPerChat} cosas, el máximo. Deja alguna con /dejar.`)];
    if ((existing?.provinces.size ?? 0) >= limits.provincesPerChat) {
      return [reply(chatId, `Ya sigues ${limits.provincesPerChat} provincias, el máximo. Deja alguna con /dejar.`)];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, 'Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.')];
    baseline(sub, c);
    chat.provinces.set(p.id, { since: c.now, checkedAt: c.now });
    dirty = true;
    return [reply(chatId, `Hecho: te aviso en ${p.name} de los avisos naranja y rojo de AEMET, de los terremotos que puedan `
      + `sentirse y de los avisos oficiales (planes de emergencia y cortes de luz). La zona de cada provincia es aproximada: `
      + `cerca de su límite puede llegarte alguno de la vecina.\n\nAhora:\n${statusText(sub, c)}`)];
  }

  /** Lo que sigue un chat, en orden: lo que se ve en /mis y lo que numeran /dejar y los botones. */
  function listOf(chat) {
    if (!chat) return [];
    return [
      ...[...chat.subs].map(([key, s]) => ({ sub: key, name: s.name })),
      ...[...chat.provinces.keys()].map((id) => ({ sub: provinceSub(id), name: provinceTitle(provinceById(id)) })),
    ];
  }

  function unfollow(chatId, sub) {
    const chat = chats.get(chatId);
    if (!chat) return [reply(chatId, 'No sigues nada.')];
    let name = null;
    if (sub.startsWith('prov:')) {
      const id = sub.slice(5);
      if (chat.provinces.delete(id)) name = provinceTitle(provinceById(id));
    } else if (chat.subs.has(sub)) {
      name = chat.subs.get(sub).name;
      chat.subs.delete(sub);
    }
    if (!name) return [reply(chatId, 'Eso ya no lo sigues.')];
    dirty = true;
    dropIfEmpty(chat);
    return [reply(chatId, `Hecho: ya no te aviso de ${name}.${chats.has(chatId) ? '' : ' No sigues nada más, así que no guardo nada de este chat.'}`)];
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
    const c = ctx();
    if (!arg) {
      return [reply(chatId, 'Dime qué quieres seguir: un número de tren («08058»), una línea con su ciudad u operador («C4 Madrid», '
        + '«27 EMT Málaga») o una provincia (/provincia Valencia).')];
    }
    if (isFollowKey(arg)) return follow(chatId, arg);
    refreshDirectory(c);
    const all = searchDirectory(directory, arg, { limit: Infinity });
    const found = all.slice(0, limits.menuItems);
    if (!found.length) {
      const p = findProvince(arg);
      if (p) return followProvince(chatId, p);
      return [reply(chatId, `No encuentro nada así entre lo que circula ahora o ha circulado hace poco. Prueba con el número `
        + `(«08058»), la línea y su ciudad u operador («C4 Madrid»), o búscalo en el mapa y pulsa «Avísame por Telegram» en su ficha: ${webUrl}`)];
    }
    if (found.length === 1 && !confirm) return follow(chatId, found[0].key, found[0].name);
    const buttons = menu(chatId, 'add', found.map((e) => ({ sub: e.key, name: e.name, label: entryLabel(e) })), c.now);
    // Si hay más de las que caben en la lista, se dice: quien busca «C1» sabe que tiene que decir la ciudad.
    const text = found.length === 1 ? '¿Quieres seguir esto?'
      : all.length > found.length ? `He encontrado ${all.length}; aquí van las ${found.length} primeras. Si no está la que buscas, añade la `
        + 'ciudad o el operador («C1 Madrid», «27 EMT Málaga»). ¿Cuál quieres seguir?'
        : 'He encontrado varias cosas. ¿Cuál quieres seguir?';
    return [reply(chatId, text, buttons)];
  }

  function status(chatId, arg) {
    const c = ctx();
    const chat = chats.get(chatId);
    const blocks = [];
    if (!arg) {
      if (!chat) return [reply(chatId, 'No sigues nada todavía. Dime qué quieres seguir con /seguir, o mira cómo va algo: /estado 08058.')];
      for (const it of listOf(chat)) blocks.push(`${it.name}:\n${statusText(it.sub, c)}`);
    } else if (isFollowKey(arg)) {
      if (followKind(arg) !== 'parada') refreshDirectory(c, arg);
      blocks.push(`${nameOf(arg)}:\n${statusText(arg, c)}`);
    } else {
      refreshDirectory(c);
      const found = searchDirectory(directory, arg, { limit: 3 });
      const p = !found.length ? findProvince(arg) : null;
      if (p) blocks.push(`${provinceTitle(p)}:\n${statusText(provinceSub(p.id), c)}`);
      for (const e of found) blocks.push(`${entryLabel(e)}:\n${statusText(e.key, c)}`);
      if (!blocks.length) return [reply(chatId, 'No encuentro nada así entre lo que circula ahora o ha circulado hace poco.')];
    }
    return packed(blocks).map((text) => reply(chatId, text));
  }

  /** Lo de cada cosa seguida, entero, en uno o varios mensajes (packBlocks), con la web al final. */
  const packed = (blocks) => packBlocks(blocks, {
    footer: `Más en ${webUrl}`,
    more: (n) => `…y ${n === 1 ? 'otra cosa que no cabe' : `${n} cosas más que no caben`} aquí: pídela${n === 1 ? '' : 's'} con /estado y su nombre, o mírala${n === 1 ? '' : 's'} en la web.`,
  });

  function provinceCmd(chatId, arg) {
    if (!arg) return [reply(chatId, 'Dime la provincia: /provincia Valencia, /provincia A Coruña, /provincia Bizkaia…')];
    const p = findProvince(arg);
    if (!p) return [reply(chatId, `No conozco la provincia «${arg}». Escríbela como en el mapa: /provincia Valencia, /provincia Illes Balears…`)];
    return followProvince(chatId, p);
  }

  function mine(chatId) {
    const chat = chats.get(chatId);
    const list = listOf(chat);
    if (!list.length) return [reply(chatId, 'No sigues nada. Dime qué quieres seguir con /seguir.')];
    return [reply(chatId, ['Sigues:', list.map((it, i) => `${i + 1}. ${it.name}`).join('\n'),
      chat.digest ? `Parte diario: a las ${chat.digest}.` : null, 'Para dejar algo: /dejar (o /dejar y su número).'].filter(Boolean).join('\n\n'))];
  }

  function drop(chatId, arg) {
    const list = listOf(chats.get(chatId));
    if (!list.length) return [reply(chatId, 'No sigues nada.')];
    // Un número es el de /mis: si no está en la lista, se dice, sin buscar esa cifra en los nombres (con «/dejar 4»
    // y tres cosas se dejaba de seguir el «AVE 04375»).
    if (/^[+-]?\d+(?:[.,]\d+)?$/.test(arg)) {
      const n = Number(arg.replace(',', '.'));
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return unfollow(chatId, list[n - 1].sub);
      const range = list.length === 1 ? 'sólo tiene el 1' : `va del 1 al ${list.length}`;
      return [reply(chatId, `En tu lista no hay un ${arg}: ${range}. ¿Qué quieres dejar de seguir?`, menu(chatId, 'drop', list, clock.now()))];
    }
    if (arg) {
      const t = arg.toLowerCase();
      const hits = list.filter((it) => it.name.toLowerCase().includes(t));
      if (hits.length === 1) return unfollow(chatId, hits[0].sub);
    }
    return [reply(chatId, '¿Qué quieres dejar de seguir?', menu(chatId, 'drop', list, clock.now()))];
  }

  function digestCmd(chatId, arg) {
    const chat = chats.get(chatId);
    if (!chat) return [reply(chatId, 'Primero sigue algo (/seguir): el parte cuenta cómo va lo que sigues.')];
    if (/^(?:no|off|nada|ninguno|quitar)$/i.test(arg)) {
      chat.digest = null;
      dirty = true;
      return [reply(chatId, 'Hecho: ya no te mando el parte diario.')];
    }
    const hour = parseHour(arg);
    if (!hour) return [reply(chatId, 'Dime la hora, en hora peninsular: /parte 07:30. Para quitarlo: /parte no.')];
    const now = clock.now();
    chat.digest = hour;
    // Si hoy ya ha pasado esa hora, el primero es mañana.
    chat.digestDay = madridHourMinute(now) >= hour ? madridDay(now) : null;
    dirty = true;
    return [reply(chatId, `Hecho: cada día a las ${hour} (hora peninsular) te mando cómo va lo que sigues.`)];
  }

  function erase(chatId) {
    const had = chats.delete(chatId);
    menus.delete(chatId);
    if (had) dirty = true;
    return [reply(chatId, had ? 'Hecho: he borrado todo lo de este chat. Si vuelves a seguir algo, empezará de cero.'
      : 'De este chat no tenía nada guardado.')];
  }

  function data(chatId) {
    const chat = chats.get(chatId);
    const view = chat && {
      id: chat.id, since: chat.since, digest: chat.digest,
      subs: [...chat.subs.values()], provinces: [...chat.provinces.keys()].map((id) => ({ name: provinceById(id)?.name ?? id })),
    };
    return [reply(chatId, dataText(view, { fmtWhen }))];
  }

  function start(chatId, arg) {
    if (isFollowKey(arg)) return follow(chatId, arg);
    const prov = /^prov-([a-z0-9-]{2,40})$/.exec(arg ?? '');
    if (prov && provinceById(prov[1])) return followProvince(chatId, provinceById(prov[1]));
    return [reply(chatId, welcomeText({ webUrl, limits }))];
  }

  function callback(chatId, dataStr) {
    const m = /^([ad]):([0-9a-z]{1,8}):(\d{1,2})$/.exec(String(dataStr ?? ''));
    const open = menus.get(chatId);
    // Sólo vale la última lista de cada chat, y un rato: un botón de un mensaje anterior no escoge nada.
    if (!m || !open || open.id !== m[2] || clock.now() - open.at > limits.menuTtlMs || open.kind !== (m[1] === 'a' ? 'add' : 'drop')) {
      return {
        replies: [reply(chatId, 'Esa lista ya no vale: es de antes (has pedido otra después o ha pasado mucho rato). Vuelve a buscarlo, por favor.')],
        answer: 'Lista caducada',
      };
    }
    const item = open.items[Number(m[3])];
    if (!item) return { replies: [], answer: 'No está en la lista' };
    menus.delete(chatId);
    if (open.kind === 'drop') return { replies: unfollow(chatId, item.sub), answer: 'Hecho' };
    return { replies: follow(chatId, item.sub, item.name), answer: 'Hecho' };
  }

  return {
    /** Lo guardado (al arrancar o al pasar a ser el servidor que atiende el bot): lo de memoria se cambia por ello. */
    async load() {
      const saved = await store.load();
      chats = new Map();
      seen = new Map();
      offset = 0;
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
        });
      }
      for (const row of Array.isArray(saved.seen) ? saved.seen.slice(0, SEEN_MAX) : []) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && Number.isFinite(row[2])) seen.set(row[0], { first: row[1], last: row[2] });
      }
      dirty = false;
      return chats.size;
    },

    /** Lo que hay que guardar para seguir igual tras un reinicio o un relevo. */
    snapshot() {
      return {
        version: 1,
        offset,
        chats: [...chats.values()].map((c) => ({
          id: c.id, since: c.since, digest: c.digest, digestDay: c.digestDay,
          subs: [...c.subs].map(([key, s]) => ({ key, name: s.name, since: s.since, checkedAt: s.checkedAt, ...(s.guessed ? { guessed: true } : {}) })),
          provinces: [...c.provinces].map(([id, s]) => ({ id, since: s.since, checkedAt: s.checkedAt })),
        })),
        seen: [...seen].map(([k, v]) => [k, v.first, v.last]),
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
     * Un mensaje de un chat: lo que contesta el bot y, si era un botón, el texto breve que lo confirma.
     * @param {Incoming} msg
     * @returns {{ replies: Reply[], answer?: string }}
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
        return { replies: r.count === limits.messagesPerMinute + 1 ? [reply(chatId, 'Demasiados mensajes seguidos. Espera un minuto, por favor.')] : [] };
      }
      if (msg.callback !== undefined) return callback(chatId, msg.callback);
      const { command, arg } = parseCommand(msg.text);
      const run = {
        start: () => start(chatId, arg),
        seguir: () => search(chatId, arg),
        // Texto sin orden: una búsqueda, salvo que sea charla («hola», «gracias», «vale»).
        buscar: () => {
          const talk = smallTalk(arg);
          if (!talk) return search(chatId, arg, { confirm: true });
          return [reply(chatId, talk === 'ayuda' ? helpText({ webUrl, limits }) : smallTalkText(talk))];
        },
        estado: () => status(chatId, arg),
        provincia: () => provinceCmd(chatId, arg),
        mis: () => mine(chatId),
        dejar: () => drop(chatId, arg),
        parte: () => digestCmd(chatId, arg),
        datos: () => data(chatId),
        baja: () => erase(chatId),
        ayuda: () => [reply(chatId, helpText({ webUrl, limits }))],
      }[command];
      return { replies: run ? run() : [reply(chatId, 'No conozco esa orden. Mira /ayuda.')] };
    },

    /**
     * Una ronda: pone al día el directorio y avisa a cada chat de lo nuevo de lo que sigue (un mensaje por cosa
     * seguida) y, si le toca, le manda el parte diario.
     * @returns {Reply[]}
     */
    tick() {
      const c = ctx();
      const { now } = c;
      refreshDirectory(c);
      for (const [id, m] of menus) if (now - m.at > limits.menuTtlMs) menus.delete(id);
      const keys = new Set();
      const provinces = new Set();
      for (const chat of chats.values()) {
        for (const k of chat.subs.keys()) keys.add(k);
        for (const p of chat.provinces.keys()) provinces.add(p);
      }
      if (!keys.size && !provinces.size) return [];
      const facts = collectFacts({ keys, provinces, ...c });
      seen = trackFacts(seen, facts, now);
      const out = [];
      const today = madridDay(now);
      const hour = madridHourMinute(now);
      for (const chat of chats.values()) {
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
          if (fresh.length) out.push(reply(chat.id, factsMessage(s.name, fresh, { webUrl })));
        }
        for (const [id, s] of chat.provinces) {
          const sub = provinceSub(id);
          const fresh = newFacts(sub, facts.get(sub), seen, s.checkedAt);
          s.checkedAt = now;
          if (fresh.length) out.push(reply(chat.id, factsMessage(provinceTitle(provinceById(id)), fresh, { webUrl })));
        }
        if (chat.digest && chat.digestDay !== today && hour >= chat.digest) {
          chat.digestDay = today;
          const blocks = listOf(chat).map((it) => `${it.name}:\n${statusText(it.sub, c)}`);
          for (const text of packed([`Parte de las ${chat.digest}:`, ...blocks])) out.push(reply(chat.id, text));
        }
      }
      if (out.length) dirty = true;
      return out;
    },

    /** Telegram dice que ese chat ya no existe o ha bloqueado el bot: se borra todo lo suyo. */
    forget(chatId) {
      menus.delete(chatId);
      if (chats.delete(chatId)) {
        dirty = true;
        log?.info(`[telegram] un chat ha bloqueado el bot o ya no existe: borrado (quedan ${chats.size})`);
      }
    },

    stats: () => ({ chats: chats.size, subs: [...chats.values()].reduce((n, c) => n + count(c), 0) }),
  };
}
