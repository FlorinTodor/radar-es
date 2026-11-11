// Caso de uso: el bot «Sigue tu tren». Atiende lo que escribe cada chat (seguir, dejar, estado, provincia…) y,
// en cada ronda (`tick`), avisa de lo nuevo de lo que sigue. No sabe nada de Telegram: recibe mensajes ya
// leídos ({ chatId, text } o { chatId, callback }) y devuelve respuestas ({ chatId, text, buttons }); el
// adaptador de entrada (adapters/inbound/telegram) las trae y las lleva. Vale para cualquier vehículo: lo que se
// sigue son claves `follow` (domain/seguir.js), sin mirar de qué fuente ni de qué tipo es.
// Cada chat tiene su idioma (domain/seguidos/idioma.js): español salvo que elija otro con /idioma, con un botón o
// desde la web en inglés (su enlace lo dice). Se guarda con lo demás del chat; mientras no siga nada, sólo en
// memoria, como todo lo de quien no sigue nada.
import { canonicalKey, isFollowKey, isRoadKey, followKind, stopCode } from '../../domain/seguir.js';
import { PROVINCE_TRAFFIC_TEXT, asksForRoad, parseRoadRequest, roadFollowedText, roadName, roadRequestHelp, roadSeen, roadSub, roadTitle } from '../../domain/seguidos/trafico.js';
import { entryLabel, guessedName, knownNames, searchDirectory, updateDirectory } from '../../domain/seguidos/directorio.js';
import {
  DELAY_MIN, SEEN_HARD_MAX, SEEN_MAX, capSeen, collectFacts, factsMessages, fitMessage, gravity, joinCredits, madridDay, madridHourMinute,
  markSeen, newFactsOf, packBlocks, provinceSub, statusOf, trackFacts,
} from '../../domain/seguidos/avisos.js';
import {
  LANG_NAMES, botProfiles, commandsFor, dataText, helpText, langLabel, parseCommand, parseHour, smallTalk, smallTalkText, welcomeText,
} from '../../domain/seguidos/ordenes.js';
import {
  BOT_LANGS, DEFAULT_LANG, ES, frase, isBotLang, offerEnglish, parseLang, parseStartPayload, spainLang, translator,
} from '../../domain/seguidos/idioma.js';
import { cutText } from '../../domain/seguidos/texto.js';
import { countEvent, emptyTotals, parseTotals, usageOf } from '../../domain/seguidos/uso.js';
import { provinceExtrasText, provinceFacts, provinceOption } from '../../domain/seguidos/zona.js';
import { withoutRepeats } from '../../domain/seguidos/estacion.js';
import { findProvince, provinceById } from '../../domain/provincias.js';
import {
  collectTrayectoFacts, connectedBy, looksLikeTrayecto, parseTrayectoText, passIndex, trayectoErrorText, trayectoHelpText, trayectoName,
  trayectoOptions, trayectoProblem, trayectoStations, trayectoStatus,
} from '../../domain/seguidos/trayectos.js';

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
// Cada cuánto, como mucho, se apunta en el registro un mismo problema de la ronda (lo recordado pasa del tope, no se
// pueden leer las paradas de un viaje).
const SEEN_WARN_EVERY_MS = 3600_000;

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
 * @typedef {{ replies: Reply[], answer?: string, menu?: { chatId: number, commands: Array<[string, string]>|null } }} Handled
 *   menu: el menú de órdenes de ese chat cambia (ha elegido otro idioma); sin órdenes (null), vuelve al de siempre (/baja).
 */

/**
 * @param {{ read: { vehicles: () => object[], events: () => object[], station?: (code: string) => object|null, alerts?: () => object[] },
 *           store: import('../ports.js').FollowStorePort, clock: import('../ports.js').ClockPort,
 *           creditOf?: (source: string, operator?: string) => string|null, webUrl: string, trayectos?: TrayectoReads,
 *           log?: import('../ports.js').LoggerPort, limits?: Partial<typeof LIMITS> }} deps
 *   read: lo que se ve ahora (query-situation: vehículos, incidencias en vigor, la ficha de una estación y las alertas
 *   abiertas, de las que el bot toma los posibles apagones de las islas).
 *   creditOf: la atribución que pide la licencia de una fuente (por su id y, si agrupa a varios, el operador).
 *   trayectos: lo que hace falta para «Mi trayecto» (query-situation): las paradas del viaje de un vehículo y el
 *   catálogo de estaciones. Sin ello, los trayectos no encuentran estaciones ni trenes.
 * @typedef {{ stops?: (vehicleId: string) => { stops: object[] }|null, stations?: () => object[] }} TrayectoReads
 */
export function makeFollowBot({ read, trayectos = {}, store, clock, creditOf = () => null, webUrl, log, limits: custom = {} }) {
  const limits = { ...LIMITS, ...custom };
  /** @type {Map<number, { id: number, since: number, subs: Map<string, { name: string, since: number, checkedAt: number }>,
   *   provinces: Map<string, { since: number, checkedAt: number, fires?: boolean }>, digest: string|null, digestDay: string|null, lang: string }>}
   *   fires: en esa provincia también quiere los focos de calor por satélite (/provincia Granada incendios). */
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
  // Quién ha elegido idioma a propósito (/idioma, un botón, un enlace de la web en un idioma), en memoria: a ésos no
  // se les cambia por escribir una orden en inglés.
  const chosen = new Set();
  const choose = (chatId) => {
    if (chosen.size >= limits.chats) chosen.clear();
    chosen.add(chatId);
  };
  // Altas, bajas, avisos y mensajes por orden desde que se empezó a contar (domain/seguidos/uso.js): se guardan con
  // lo demás, así que un arranque o un relevo no los pone a cero.
  let totals = emptyTotals(clock.now());
  let dirty = false;
  let savedAt = 0;
  let directoryAt = -Infinity;
  let known = null; // operadores y ámbitos del directorio (knownNames), hasta que cambie
  let menuSeq = 0;
  let seenWarnedAt = -Infinity;
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

  // Trayectos (domain/seguidos/trayectos.js): las paradas del viaje de cada vehículo, como mucho una vez por minuto
  // (las piden la ronda, /estado y los partes de ese minuto); por dónde pasan, una vez por consulta (la ronda, con los
  // partes de todos los chats, es una); el catálogo de estaciones, cada tanto.
  let tripStops = { at: -Infinity, byId: new Map() };
  let stopsFailedAt = -Infinity;
  const stopsOf = (id) => {
    const now = clock.now();
    if (now - tripStops.at >= 60_000) tripStops = { at: now, byId: new Map() };
    if (!tripStops.byId.has(id)) {
      // Si fallan las paradas de un viaje, ese vehículo no cuenta: la ronda de todos sigue.
      let stops = null;
      try {
        stops = trayectos.stops?.(id)?.stops ?? null;
      } catch (err) {
        if (now - stopsFailedAt >= SEEN_WARN_EVERY_MS) {
          stopsFailedAt = now;
          log?.warn(`[telegram] no se pudieron leer las paradas de un viaje: ${err.message}`);
        }
      }
      tripStops.byId.set(id, stops);
    }
    return tripStops.byId.get(id);
  };
  const passing = new WeakMap(); // ctx → passIndex
  const passingOf = (c) => {
    let index = passing.get(c);
    if (!index) passing.set(c, (index = passIndex(c.vehicles, stopsOf)));
    return index;
  };
  /** ¿Une algún tren que se ve ahora dos estaciones? (vehículos con sus paradas y cancelaciones con las suyas) */
  const connects = (c) => connectedBy({ index: passingOf(c), events: c.events });
  let catalog = { at: -Infinity, list: [] };
  const stationList = () => {
    if (clock.now() - catalog.at >= DIRECTORY_EVERY_MS) catalog = { at: clock.now(), list: trayectos.stations?.() ?? [] };
    return catalog.list;
  };
  /** Los hechos de lo que se sigue: los de avisos.js y los de los trayectos, con sus textos en el idioma de `tr`. */
  const factsOf = (keys, provinces, c, tr = ES) => {
    const facts = collectFacts({ keys, provinces, ...c, tr });
    for (const [key, list] of collectTrayectoFacts({ keys, ...c, stopsOf, tr })) facts.set(key, list);
    return facts;
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
  const ctx = () => ({ vehicles: read.vehicles(), events: read.events(), alerts: read.alerts?.() ?? [], now: clock.now(), stationOf, creditOf });
  const reply = (chatId, text, buttons) => ({ chatId, text: fitMessage(text), ...(buttons?.length ? { buttons } : {}) });
  const count = (chat) => (chat ? chat.subs.size + chat.provinces.size : 0);
  const provinceTitle = (p, tr) => tr.t('Avisos en {province}', { province: p.name });
  /** Lo que se añade al nombre de una provincia en la que se han pedido los focos de calor. */
  const firesNote = (s, tr) => (s?.fires ? ` ${tr.t('(con focos de calor)')}` : '');

  /** El nombre de lo que se ve (directorio o catálogo de estaciones), en español como se guarda; null si ahora no se conoce. */
  function knownName(key) {
    if (followKind(key) === 'trayecto') return trayectoName(key, stationOf);
    if (followKind(key) === 'parada') {
      const st = stationOf(stopCode(key));
      return st?.name ? ES.t('Estación {name}', { name: st.name }) : null;
    }
    return directory.get(key)?.name ?? null;
  }

  // Algo que no se ve ahora (un enlace guardado, o de noche tras un reinicio): un nombre sin el texto libre de su
  // clave, que se puede inventar (guessedName); se renueva cuando se vuelve a ver (tick).
  const nameOf = (key) => knownName(key) ?? guessedName(key, knownOf()) ?? (followKind(key) === 'parada' ? frase('esa estación') : frase('eso'));

  // Cómo está cada cosa, una vez por consulta (`c`) e idioma: en la ronda del parte, miles de chats piden las
  // mismas provincias y carreteras, y cada una cuesta recorrer todas las incidencias.
  const statusMemo = new WeakMap(); // ctx → «idioma|focos|sub» → { body, credits }
  /**
   * Cómo está ahora: sus líneas (`body`) y sus fuentes (`credits`, juntas). `fires`: en una provincia, también sus focos
   * de calor (quien los ha pedido).
   */
  function statusNow(sub, c, tr, fires = false) {
    let memo = statusMemo.get(c);
    if (!memo) statusMemo.set(c, (memo = new Map()));
    const k = `${tr.lang}|${fires && sub.startsWith('prov:') ? 1 : 0}|${sub}`;
    let st = memo.get(k);
    if (!st) {
      const { lines, credits } = followKind(sub) === 'trayecto'
        ? trayectoStatus(sub, { ...c, stopsOf, index: passingOf(c), tr })
        : statusOf(sub, { ...c, fires, tr });
      st = { body: lines.join('\n'), credits: joinCredits(credits) };
      memo.set(k, st);
    }
    return st;
  }
  /** Lo de una cosa como bloque de packBlocks: «<head>\n<cómo está>» con sus fuentes (en cada mensaje si se parte). */
  const statusBlock = (head, sub, c, tr, fires = false) => {
    const { body, credits } = statusNow(sub, c, tr, fires);
    return { text: `${head}\n${body}`, credits };
  };
  /** Una respuesta de varias partes (con cómo está algo), en uno o varios mensajes si no cabe: sin recortar nada. */
  const answer = (chatId, tr, blocks) => packed(blocks.filter(Boolean), tr, { footer: null }).map((text) => reply(chatId, text));

  /** Lo que ya se ve de algo al empezar a seguirlo no se avisa: se cuenta en la respuesta. */
  function baseline(sub, c) {
    const facts = sub.startsWith('prov:') ? factsOf([], [sub.slice(5)], c) : factsOf([sub], [], c);
    markSeen(seen, facts, c.now);
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

  function follow(chatId, link, name = null) {
    const tr = trOf(chatId);
    const { t } = tr;
    // Cada cosa con una sola clave: un enlace inventado puede escribir la misma de muchas formas («p-_37_30…»).
    const key = canonicalKey(link);
    if (!key) return [reply(chatId, t('Eso no es algo que se pueda seguir. Búscalo con /seguir o desde la web.'))];
    const c = ctx();
    const station = followKind(key) === 'parada';
    // Una estación está en el catálogo o no existe: de una que no está nunca llegaría nada.
    if (station && !stationOf(stopCode(key))) {
      return [reply(chatId, t('Esa estación no la encuentro en el catálogo del radar. Búscala en el mapa y pulsa «Avísame por Telegram» en su ficha: {web}',
        { web: web(tr) }))];
    }
    if (followKind(key) === 'trayecto' && !trayectoName(key, stationOf)) {
      return [reply(chatId, t('Ese trayecto no lo puedo seguir: alguna de sus estaciones no está en el catálogo del radar. Escríbelo con /trayecto.'))];
    }
    // Un trayecto por enlace, con lo mismo que comprueba /trayecto: estaciones distintas y de la misma red.
    const wrong = followKind(key) === 'trayecto' ? trayectoProblem(key, stationOf) : null;
    if (wrong) return [reply(chatId, trayectoErrorText(wrong, tr))];
    // Un enlace de la web trae sólo la clave: su nombre, de lo que se ve ahora.
    if (!name && !station) refreshDirectory(c, key);
    const existing = chats.get(chatId);
    if (existing?.subs.has(key)) {
      return answer(chatId, tr, [t('Ya sigues {name}.', { name: tr.name(existing.subs.get(key).name) }), statusBlock(t('Ahora:'), key, c, tr)]);
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
    return answer(chatId, tr, [t('Hecho: te aviso de {name}.', { name: tr.name(chat.subs.get(key).name) }), statusBlock(t('Ahora:'), key, c, tr),
      unlinked(key, c, tr), t('/mis para ver lo que sigues · /dejar para dejar de seguirlo')]);
  }

  /** De un trayecto que ningún tren que se ve une: que lo compruebe (se sigue igual: de noche apenas hay trenes). */
  function unlinked(key, c, tr) {
    const way = followKind(key) === 'trayecto' ? trayectoStations(key, stationOf) : null;
    if (!way || connects(c)(way.origin, way.destination)) return null;
    return tr.t('Ahora no veo ningún tren que vaya de {origin} a {destination}: si no hay trenes directos entre ellas, no te llegará nada; '
      + 'comprueba las estaciones.', { origin: way.origin.name, destination: way.destination.name });
  }

  /** Sigue una provincia; con `fires`, también sus focos de calor (y si ya la seguía, se los añade). */
  function followProvince(chatId, p, { fires = false } = {}) {
    const tr = trOf(chatId);
    const { t } = tr;
    const sub = provinceSub(p.id);
    const c = ctx();
    const existing = chats.get(chatId);
    const had = existing?.provinces.get(p.id);
    const province = p.name;
    if (had && fires && !had.fires) {
      had.fires = true;
      dirty = true;
      return answer(chatId, tr, [t('Hecho: en {province} ahora también te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: '
        + 'sólo los más claros, y nunca son un incendio confirmado. Para quitarlos: /provincia {province} sin incendios', { province }),
      statusBlock(t('Ahora:'), sub, c, tr, true)]);
    }
    if (had) {
      const already = had.fires ? t('Ya sigues los avisos de {province} (con focos de calor).', { province }) : t('Ya sigues los avisos de {province}.', { province });
      return answer(chatId, tr, [already, statusBlock(t('Ahora:'), sub, c, tr, had.fires)]);
    }
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, t('Ya sigues {n} cosas, el máximo. Deja alguna con /dejar.', { n: limits.subsPerChat }))];
    if ((existing?.provinces.size ?? 0) >= limits.provincesPerChat) {
      return [reply(chatId, t('Ya sigues {n} provincias, el máximo. Deja alguna con /dejar.', { n: limits.provincesPerChat }))];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, t('Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.'))];
    baseline(sub, c);
    chat.provinces.set(p.id, { since: c.now, checkedAt: c.now, ...(fires ? { fires: true } : {}) });
    dirty = true;
    return answer(chatId, tr, [`${t('Hecho: te aviso en {province} de los avisos naranja y rojo de AEMET, de los terremotos que puedan '
      + 'sentirse y de los avisos oficiales (planes de emergencia y cortes de luz).', { province })} ${t(PROVINCE_TRAFFIC_TEXT)} `
      + `${t('La zona de cada provincia es aproximada: cerca de su límite puede llegarte alguno de la vecina.')}`,
    statusBlock(t('Ahora:'), sub, c, tr, fires), provinceExtrasText(p, { fires, tr })]);
  }

  /** Deja los focos de calor de una provincia que sigue (el resto de sus avisos, no). */
  function dropFires(chatId, p) {
    const { t } = trOf(chatId);
    const province = p.name;
    const had = chats.get(chatId)?.provinces.get(p.id);
    if (!had) return [reply(chatId, t('No sigues {province}. Para seguirla: /provincia {province}', { province }))];
    if (!had.fires) return [reply(chatId, t('En {province} no te aviso de los focos de calor; del resto de sus avisos, sí.', { province }))];
    delete had.fires;
    dirty = true;
    return [reply(chatId, t('Hecho: en {province} ya no te aviso de los focos de calor; del resto de sus avisos, sí.', { province }))];
  }

  /** Seguir una carretera (entera o en una provincia): `sub` es de roadSub. Cuenta en el tope de cosas por chat. */
  function followRoad(chatId, sub) {
    const tr = trOf(chatId);
    const { t } = tr;
    const c = ctx();
    const existing = chats.get(chatId);
    if (existing?.subs.has(sub.key)) {
      return answer(chatId, tr, [t('Ya sigues {name}.', { name: tr.name(existing.subs.get(sub.key).name) }), statusBlock(t('Ahora:'), sub.key, c, tr)]);
    }
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, t('Ya sigues {n} cosas, el máximo. Deja alguna con /dejar.', { n: limits.subsPerChat }))];
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, t('Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.'))];
    const name = roadName(sub.road, c.events);
    baseline(sub.key, c);
    // El nombre se guarda en español («Carretera A-7»), como los demás, y se enseña en el idioma del chat.
    chat.subs.set(sub.key, { name: roadTitle(name, sub.province), since: c.now, checkedAt: c.now });
    dirty = true;
    // Sin lista de carreteras, una mal escrita se sigue igual: si ahora no tiene ninguna incidencia, se dice.
    const unseen = roadSeen(sub.key, c.events) ? null
      : t('Ahora no veo ninguna incidencia en ella, ni leve: comprueba que el nombre está bien escrito; si lo está, te aviso en cuanto haya algo.');
    return answer(chatId, tr, [roadFollowedText(sub, name, tr), statusBlock(t('Ahora:'), sub.key, c, tr), unseen,
      t('/mis para ver lo que sigues · /dejar para dejar de seguirlo')]);
  }

  function roadCmd(chatId, arg) {
    const wanted = parseRoadRequest(arg);
    return wanted.key ? followRoad(chatId, wanted) : [reply(chatId, roadRequestHelp(wanted, arg, trOf(chatId)))];
  }

  /**
   * Lo que sigue un chat, en orden: lo que se ve en /mis y lo que numeran /dejar y los botones. `name`, en el idioma
   * del chat; `saved`, el nombre guardado (en español), para buscarlo también por él.
   */
  function listOf(chat, tr) {
    if (!chat) return [];
    return [
      ...[...chat.subs].map(([key, s]) => ({ sub: key, name: tr.name(s.name), saved: s.name })),
      ...[...chat.provinces].map(([id, s]) => ({
        sub: provinceSub(id), name: `${provinceTitle(provinceById(id), tr)}${firesNote(s, tr)}`, saved: provinceById(id).name, fires: !!s.fires,
      })),
    ];
  }

  function unfollow(chatId, sub) {
    const tr = trOf(chatId);
    const { t } = tr;
    const chat = chats.get(chatId);
    if (!chat) return [reply(chatId, t('No sigues nada.'))];
    let done = null;
    if (sub.startsWith('prov:')) {
      const id = sub.slice(5);
      if (chat.provinces.delete(id)) done = t('Hecho: ya no te mando los avisos de {province}.', { province: provinceById(id).name });
    } else if (chat.subs.has(sub)) {
      // Una carretera, por su nombre («la M-30», «la A-7 en Málaga»); lo demás, por el suyo en el idioma del chat.
      const saved = chat.subs.get(sub).name;
      const road = isRoadKey(sub) ? /^Carretera (.+?)(?: \(([^()]+)\))?$/.exec(saved) : null;
      done = !road ? t('Hecho: ya no te aviso de {name}.', { name: tr.name(saved) })
        : road[2] ? t('Hecho: ya no te aviso de la {road} en {province}.', { road: road[1], province: road[2] })
          : t('Hecho: ya no te aviso de la {road}.', { road: road[1] });
      chat.subs.delete(sub);
    }
    if (!done) return [reply(chatId, t('Eso ya no lo sigues.'))];
    dirty = true;
    dropIfEmpty(chat);
    return [reply(chatId, chats.has(chatId) ? done : `${done} ${t('No sigues nada más, así que no guardo nada de este chat.')}`)];
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
      // «Granada incendios» o «Granada sin incendios», también sin orden.
      const { place, fires } = provinceOption(arg);
      const p = findProvince(place);
      if (p) return fires === false ? dropFires(chatId, p) : followProvince(chatId, p, { fires: !!fires });
      // Algo que parece una carretera («A-7», «C-31»: con guion): no se sigue sin preguntar (también podría ser una línea
      // que ahora no circula). «C1 Barcelona» no lo parece.
      const road = asksForRoad(arg) ?? (/\b[a-z]{1,4}-[0-9ivx]/i.test(arg) ? parseRoadRequest(arg) : {});
      if (road.key) {
        return [reply(chatId, t('No encuentro ningún vehículo ni línea así. Si es una carretera, para sus cortes y accidentes: /carretera {road}', { road: arg }))];
      }
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
      for (const it of listOf(chat, tr)) blocks.push(statusBlock(`${it.name}:`, it.sub, c, tr, it.fires));
    } else if (canonicalKey(arg)) {
      const key = canonicalKey(arg);
      if (followKind(key) !== 'parada') refreshDirectory(c, key);
      blocks.push(statusBlock(`${tr.name(nameOf(key))}:`, key, c, tr));
    } else {
      refreshDirectory(c);
      // «/estado A-7»: la carretera, no el autobús 7 (asksForRoad); «/estado C4 Madrid», la línea.
      const roadFirst = asksForRoad(arg);
      // «/estado Málaga» (o «Granada incendios»): si todo lo escrito es una provincia, la provincia, no las líneas que
      // pasan por una estación que se llama así.
      const option = provinceOption(arg);
      const p = roadFirst ? null : findProvince(option.place);
      const found = roadFirst || p ? [] : searchDirectory(directory, arg, { limit: 3 });
      const fires = option.fires ?? !!chat?.provinces.get(p?.id)?.fires;
      if (p) blocks.push(statusBlock(`${provinceTitle(p, tr)}:`, provinceSub(p.id), c, tr, fires));
      const road = roadFirst ?? (!found.length && !p ? parseRoadRequest(arg) : null); // cómo está esa carretera
      if (road?.key) blocks.push(statusBlock(`${tr.name(roadTitle(roadName(road.road, c.events), road.province))}:`, road.key, c, tr));
      for (const e of found) blocks.push(statusBlock(`${tr.name(entryLabel(e))}:`, e.key, c, tr));
      if (!blocks.length) return [reply(chatId, t('No encuentro nada así entre lo que circula ahora o ha circulado hace poco.'))];
    }
    return packed(blocks, tr).map((text) => reply(chatId, text));
  }

  /** Lo de cada cosa seguida, entero, en uno o varios mensajes (packBlocks), con la web al final (o `footer`). */
  const packed = (blocks, tr, { footer = tr.t('Más en {web}', { web: web(tr) }) } = {}) => packBlocks(blocks, {
    footer,
    more: (n) => tr.tn('…y otra cosa que no cabe aquí: pídela con /estado y su nombre, o mírala en la web.',
      '…y {n} cosas más que no caben aquí: pídelas con /estado y su nombre, o míralas en la web.', n),
  });

  /**
   * /trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V: sus estaciones, del catálogo. Si con esos nombres sólo hay un
   * trayecto posible, lo sigue; si hay varios (dos «Atocha»), una lista con cada combinación.
   */
  function trayectoCmd(chatId, arg) {
    const tr = trOf(chatId);
    const { t } = tr;
    if (!arg) return [reply(chatId, trayectoHelpText({ tr }))];
    const parsed = parseTrayectoText(arg);
    if (parsed.error) return [reply(chatId, trayectoErrorText(parsed, tr))];
    // Primero los que une algún tren que se ve (y fuera los muy lejanos que ninguno une).
    const found = trayectoOptions(stationList(), parsed, { limit: limits.menuItems, connects: connects(ctx()) });
    if (found.error) return [reply(chatId, trayectoErrorText(found, tr))];
    if (found.total === 1) return follow(chatId, found.pairs[0].key, found.pairs[0].name);
    const buttons = menu(chatId, 'add', found.pairs.map((p) => ({ sub: p.key, name: p.name, label: p.label })), clock.now());
    const text = found.total > found.pairs.length
      ? t('Con esos nombres hay {total} trayectos posibles; aquí van los {n} primeros. Si no está el tuyo, escribe el nombre entero de las '
        + 'estaciones. ¿Cuál es?', { total: found.total, n: found.pairs.length })
      : t('Hay varias estaciones con esos nombres. ¿Cuál es tu trayecto?');
    return [reply(chatId, text, buttons)];
  }

  function provinceCmd(chatId, arg) {
    const { t } = trOf(chatId);
    if (!arg) return [reply(chatId, t('Dime la provincia: /provincia Valencia, /provincia A Coruña, /provincia Bizkaia…'))];
    // «/provincia Granada incendios»: también los focos de calor; «/provincia Granada sin incendios»: sin ellos.
    const { place, fires } = provinceOption(arg);
    const p = findProvince(place);
    if (!p) return [reply(chatId, t('No conozco la provincia «{name}». Escríbela como en el mapa: /provincia Valencia, /provincia Illes Balears…', { name: place }))];
    return fires === false ? dropFires(chatId, p) : followProvince(chatId, p, { fires: !!fires });
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
    const off = /^(?:no|off|nada|ninguno|quitar|none|cancel)$/i.test(arg);
    const hour = off ? null : parseHour(arg);
    // La hora mal escrita, antes que pedir que siga algo: si no, al seguir algo y volver a escribirla, otra vez mal.
    if (!off && !hour && (arg || chat)) return [reply(chatId, t('Dime la hora, en hora peninsular: /parte 07:30. Para quitarlo: /parte no.'))];
    if (!chat) return [reply(chatId, t('Primero sigue algo (/seguir): el parte cuenta cómo va lo que sigues.'))];
    if (off) {
      chat.digest = null;
      dirty = true;
      return [reply(chatId, t('Hecho: ya no te mando el parte diario.'))];
    }
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
    return {
      replies: [reply(chatId, chat ? t('Hecho: he borrado todo lo de este chat. Si vuelves a seguir algo, empezará de cero.')
        : t('De este chat no tenía nada guardado.'))],
      // Su menú de órdenes vuelve al de siempre (el del idioma de su Telegram).
      menu: { chatId, commands: null },
    };
  }

  function data(chatId) {
    const tr = trOf(chatId);
    const chat = chats.get(chatId);
    const view = chat && {
      id: chat.id, since: chat.since, digest: chat.digest, lang: chat.lang,
      subs: [...chat.subs.values()].map((s) => ({ name: tr.name(s.name) })),
      provinces: [...chat.provinces].map(([id, s]) => ({ name: `${provinceById(id)?.name ?? id}${firesNote(s, tr)}` })),
    };
    return [reply(chatId, dataText(view, { tr }))];
  }

  /** @returns {Handled} */
  function start(chatId, arg) {
    // La web en inglés pone el idioma delante de la clave («en-s-renfe-8058», «en-c-A7»): el bot habla ya en ese idioma
    // y pone el menú de órdenes de ese chat en él.
    const { lang, rest } = parseStartPayload(arg);
    const menu = lang && langOf(chatId) !== lang ? { chatId, commands: commandsFor(lang) } : null;
    if (lang) {
      setLang(chatId, lang);
      choose(chatId);
    }
    const replies = (() => {
      if (isFollowKey(rest)) return follow(chatId, rest);
      // Una carretera, desde la ficha de una incidencia de tráfico en la web («c-A7»); con una provincia que no existe, no.
      const road = isRoadKey(rest) ? roadSub(rest) : null;
      if (road) return followRoad(chatId, road);
      const prov = /^prov-([a-z0-9-]{2,40})$/.exec(rest);
      if (prov && provinceById(prov[1])) return followProvince(chatId, provinceById(prov[1]));
      return [welcome(chatId)];
    })();
    return menu ? { replies, menu } : { replies };
  }

  const welcome = (chatId) => {
    const tr = trOf(chatId);
    return reply(chatId, welcomeText({ webUrl: web(tr), limits, tr }));
  };

  /**
   * Los botones para elegir idioma: cada uno, con su nombre en su idioma. Con `welcome` (el que se ofrece con la
   * bienvenida), al pulsarlo llega también la bienvenida en ese idioma.
   */
  const langButtons = (langs = BOT_LANGS, { welcome: withWelcome = false } = {}) => langs.map((l) => [{ text: langLabel(l), data: `l:${l}${withWelcome ? ':w' : ''}` }]);

  /** /idioma: con el idioma, lo cambia; sin él (o si no se entiende), pregunta en todos con un botón por idioma. */
  function language(chatId, arg) {
    const lang = parseLang(arg);
    if (lang) return changeLang(chatId, lang);
    const ask = BOT_LANGS.map((l) => translator(l).t('¿En qué idioma te escribo?')).join(' · ');
    return { replies: [reply(chatId, ask, langButtons())] };
  }

  /** @returns {Handled} */
  function changeLang(chatId, lang, { withWelcome = false } = {}) {
    setLang(chatId, lang);
    choose(chatId);
    const tr = trOf(chatId);
    return {
      replies: [reply(chatId, tr.t('Hecho: a partir de ahora te escribo en {lang}. /ayuda para ver lo que hago; /idioma para cambiarlo.',
        { lang: tr.t(LANG_NAMES[lang]) })), ...(withWelcome ? [welcome(chatId)] : [])],
      answer: tr.t('Hecho'),
      // Su menú de órdenes, en su idioma (sin esto, el que corresponde al idioma de su Telegram).
      menu: { chatId, commands: commandsFor(lang) },
    };
  }

  /** @returns {Handled} */
  function callback(chatId, dataStr) {
    const { t } = trOf(chatId);
    // Un botón de idioma vale siempre: no es de una lista.
    const picked = /^l:([a-z]{2})(:w)?$/.exec(String(dataStr ?? ''));
    if (picked && isBotLang(picked[1])) return changeLang(chatId, picked[1], { withWelcome: Boolean(picked[2]) });
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
          // Cada cosa con su clave única (las guardadas antes de que se rehicieran, también): dos formas de la misma, una.
          const key = roadSub(s?.key) ? s.key : canonicalKey(s?.key);
          if (!key || typeof s.name !== 'string' || subs.has(key)) continue;
          subs.set(key, { name: cutText(s.name, 200), since: num(s.since), checkedAt: num(s.checkedAt), ...(s.guessed === true ? { guessed: true } : {}) });
        }
        const provinces = new Map();
        for (const p of Array.isArray(c.provinces) ? c.provinces.slice(0, limits.provincesPerChat) : []) {
          if (provinceById(p?.id)) provinces.set(p.id, { since: num(p.since), checkedAt: num(p.checkedAt), ...(p.fires === true ? { fires: true } : {}) });
        }
        if (!subs.size && !provinces.size) continue;
        chats.set(c.id, {
          id: c.id, since: num(c.since), subs, provinces, digest: parseHour(c.digest),
          digestDay: /^\d{4}-\d{2}-\d{2}$/.test(c.digestDay ?? '') ? c.digestDay : null,
          // Los guardados antes de haber idiomas, y lo que llegue mal, en el de siempre.
          lang: isBotLang(c.lang) ? c.lang : DEFAULT_LANG,
        });
      }
      let lastRound = -Infinity;
      for (const row of Array.isArray(saved.seen) ? saved.seen.slice(0, SEEN_HARD_MAX) : []) {
        if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && Number.isFinite(row[2])) {
          seen.set(row[0], { first: row[1], last: row[2] });
          if (row[2] > lastRound) lastRound = row[2];
        }
      }
      // Como en cada ronda: lo de la última que se guardó no se olvida por el tope.
      capSeen(seen, { keepFrom: lastRound });
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
          provinces: [...c.provinces].map(([id, s]) => ({ id, since: s.since, checkedAt: s.checkedAt, ...(s.fires ? { fires: true } : {}) })),
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
      const { command, arg, english } = parseCommand(msg.text);
      const payload = command === 'start' ? parseStartPayload(arg) : null;
      // /start con una clave o una provincia: llega desde un enlace de la web («Avísame por Telegram»).
      const link = Boolean(payload && (isFollowKey(payload.rest) || isRoadKey(payload.rest) || /^prov-/.test(payload.rest)));
      note('orden', link ? 'enlace' : command);
      // Una orden escrita en inglés («/follow», «/help») de quien no ha elegido idioma ni tiene Telegram en uno de
      // España: lee inglés. Como si hubiera escrito /language english (también su menú de órdenes).
      let switched = null;
      if (english && langOf(chatId) === DEFAULT_LANG && !chosen.has(chatId) && !spainLang(msg.clientLang)) {
        setLang(chatId, 'en');
        switched = { chatId, commands: commandsFor('en') };
      }
      // La primera vez (nada de este chat, ni en memoria), si su Telegram está en otro idioma, se le ofrece el inglés,
      // escriba lo que escriba (con un enlace en inglés o pidiendo un idioma, no hace falta).
      const offer = !switched && !payload?.lang && command !== 'idioma' && !chats.has(chatId) && !spoken.has(chatId) && !offered.has(chatId)
        && !chosen.has(chatId) && offerEnglish(msg.clientLang);
      // Con la bienvenida (/start sin enlace), la oferta va antes, y su botón trae la bienvenida en inglés.
      const welcoming = command === 'start' && !link && !payload?.lang;
      const run = {
        start: () => start(chatId, arg),
        // «/seguir Alcalá > Atocha 7-9» es un trayecto.
        seguir: () => (looksLikeTrayecto(arg) ? trayectoCmd(chatId, arg) : search(chatId, arg)),
        trayecto: () => trayectoCmd(chatId, arg),
        // Texto sin orden: una búsqueda, salvo que sea charla («hola», «gracias», «vale»).
        buscar: () => {
          if (looksLikeTrayecto(arg)) return trayectoCmd(chatId, arg);
          // «english», «in English», «English please», «en español»: el idioma.
          const lang = parseLang(arg.replace(/^\//, ''), { codes: false });
          if (lang) return changeLang(chatId, lang);
          const talk = smallTalk(arg);
          if (!talk) return search(chatId, arg, { confirm: true });
          const tr = trOf(chatId);
          return [reply(chatId, talk === 'ayuda' ? helpText({ webUrl: web(tr), limits, tr }) : smallTalkText(talk, tr))];
        },
        estado: () => status(chatId, arg),
        provincia: () => provinceCmd(chatId, arg),
        carretera: () => roadCmd(chatId, arg),
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
      if (switched && !handled.menu) handled.menu = switched;
      if (offer && langOf(chatId) === DEFAULT_LANG) {
        if (offered.size >= limits.chats) offered.clear();
        offered.add(chatId);
        // Corta y en los dos idiomas: quien la recibe aún no ha dicho cuál lee.
        const ask = frase('¿Prefieres que te escriba en inglés? Pulsa el botón, o escribe /idioma cuando quieras.');
        const offerReply = reply(chatId, `${EN.t(ask)}\n${ES.t(ask)}`, langButtons(['en'], { welcome: welcoming }));
        if (welcoming) handled.replies.unshift(offerReply);
        else handled.replies.push(offerReply);
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
      const facts = factsOf(allKeys, allProvinces, c);
      const firsts = new Map();
      seen = trackFacts(seen, facts, now, { firsts });
      // Lo de esta ronda no se olvida por el tope (avisos perdidos o repetidos): si sólo eso ya pasa, se dice.
      if (seen.size > SEEN_MAX && now - seenWarnedAt >= SEEN_WARN_EVERY_MS) {
        seenWarnedAt = now;
        log?.warn(`[telegram] lo avisado que se recuerda pasa del tope (${SEEN_MAX}): ${seen.size} pares, de esta ronda; la válvula, ${SEEN_HARD_MAX}`);
      }
      const fresh = newFactsOf(facts, seen, firsts); // lo nuevo de cada suscripción, mirado una vez para todos sus chats
      const factsIn = new Map([[DEFAULT_LANG, facts]]);
      /** Los hechos nuevos de una suscripción, con su texto en el idioma del chat (los mismos ids, en el mismo orden). */
      const sayIn = (lang, sub, list) => {
        if (lang === DEFAULT_LANG) return list;
        if (!factsIn.has(lang)) factsIn.set(lang, factsOf(keys.get(lang), provinces.get(lang), c, translator(lang)));
        const ids = new Set(list.map((f) => f.id));
        return (factsIn.get(lang).get(sub) ?? []).filter((f) => ids.has(f.id));
      };
      const out = [];
      const today = madridDay(now);
      const hour = madridHourMinute(now);
      for (const chat of chats.values()) {
        const tr = translator(chat.lang);
        const sent = new Set(); // los avisos ya contados a este chat en esta ronda: no se repiten (estación y línea, carretera y provincia)
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
          const told = withoutRepeats(fresh(key, s.checkedAt), sent);
          s.checkedAt = now;
          if (told.length) {
            for (const text of factsMessages(tr.name(s.name), sayIn(chat.lang, key, told), { webUrl: web(tr), tr })) out.push(reply(chat.id, text));
            note('aviso', 'aviso');
          }
        }
        for (const [id, s] of chat.provinces) {
          const sub = provinceSub(id);
          // Los focos de calor, sólo a quien los ha pedido en esa provincia.
          // Sin repetir lo que ya ha llegado por una carretera seguida en esta ronda (withoutRepeats).
          const told = withoutRepeats(provinceFacts(fresh(sub, s.checkedAt), { fires: s.fires }), sent);
          s.checkedAt = now;
          if (told.length) {
            // Lo más grave primero: si son muchos, lo que queda en «…y N más» es lo menos grave.
            const list = sayIn(chat.lang, sub, told).sort((a, b) => gravity(b) - gravity(a));
            for (const text of factsMessages(provinceTitle(provinceById(id), tr), list, { webUrl: web(tr), tr })) out.push(reply(chat.id, text));
            note('aviso', 'aviso');
          }
        }
        if (chat.digest && chat.digestDay !== today && hour >= chat.digest) {
          chat.digestDay = today;
          const blocks = listOf(chat, tr).map((it) => statusBlock(`${it.name}:`, it.sub, c, tr, it.fires));
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
      chosen.delete(chatId);
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
