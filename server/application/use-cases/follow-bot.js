// Caso de uso: el bot «Sigue tu tren». Atiende lo que escribe cada chat (seguir, dejar, estado, provincia…) y,
// en cada ronda (`tick`), avisa de lo nuevo de lo que sigue. No sabe nada de Telegram: recibe mensajes ya
// leídos ({ chatId, text } o { chatId, callback }) y devuelve respuestas ({ chatId, text, buttons }); el
// adaptador de entrada (adapters/inbound/telegram) las trae y las lleva. Vale para cualquier vehículo: lo que se
// sigue son claves `follow` (domain/seguir.js), sin mirar de qué fuente ni de qué tipo es.
import { isFollowKey, isRoadKey, followKind, stopCode } from '../../domain/seguir.js';
import { PROVINCE_TRAFFIC_TEXT, parseRoadRequest, roadFollowedText, roadName, roadRequestHelp, roadSub, roadTitle } from '../../domain/seguidos/trafico.js';
import { entryLabel, guessedName, knownNames, searchDirectory, updateDirectory } from '../../domain/seguidos/directorio.js';
import {
  DELAY_MIN, SEEN_MAX, collectFacts, factsMessage, fitMessage, fmtWhen, madridDay, madridHourMinute, newFacts, packBlocks, provinceSub,
  statusOf, trackFacts,
} from '../../domain/seguidos/avisos.js';
import { dataText, helpText, parseCommand, parseHour, smallTalk, smallTalkText, welcomeText } from '../../domain/seguidos/ordenes.js';
import { cutText } from '../../domain/seguidos/texto.js';
import { countEvent, emptyTotals, parseTotals, usageOf } from '../../domain/seguidos/uso.js';
import { provinceExtrasText, provinceFacts, provinceOption } from '../../domain/seguidos/zona.js';
import { withoutRepeats } from '../../domain/seguidos/estacion.js';
import { findProvince, provinceById } from '../../domain/provincias.js';
import {
  collectTrayectoFacts, looksLikeTrayecto, parseTrayectoText, passIndex, trayectoErrorText, trayectoHelpText, trayectoName, trayectoOptions,
  trayectoStatus,
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

const num = (x) => (Number.isFinite(x) ? x : 0);
const clipLabel = (s) => cutText(s, BUTTON_MAX);

/**
 * @typedef {{ chatId: number, text: string, buttons?: Array<Array<{ text: string, data: string }>> }} Reply
 * @typedef {{ chatId: number, text?: string, callback?: string, callbackId?: string }} Incoming
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
   *   provinces: Map<string, { since: number, checkedAt: number, fires?: boolean }>, digest: string|null, digestDay: string|null }>}
   *   fires: en esa provincia también quiere los focos de calor por satélite (/provincia Granada incendios). */
  let chats = new Map();
  let seen = new Map();
  let offset = 0;
  const directory = new Map();
  const menus = new Map(); // chat → { kind: 'add'|'drop', items, at }: los botones de la última lista
  const rate = new Map(); // chat → { from, count }: sus mensajes del último minuto
  // Altas, bajas, avisos y mensajes por orden desde que se empezó a contar (domain/seguidos/uso.js): se guardan con
  // lo demás, así que un arranque o un relevo no los pone a cero.
  let totals = emptyTotals(clock.now());
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
  const note = (event, detail = '') => {
    countEvent(totals, event, detail);
    dirty = true;
  };

  // Trayectos (domain/seguidos/trayectos.js): las paradas del viaje de cada vehículo, como mucho una vez por minuto
  // (las piden la ronda, /estado y los partes de ese minuto); por dónde pasan, una vez por consulta (la ronda, con los
  // partes de todos los chats, es una); el catálogo de estaciones, cada tanto.
  let tripStops = { at: -Infinity, byId: new Map() };
  const stopsOf = (id) => {
    const now = clock.now();
    if (now - tripStops.at >= 60_000) tripStops = { at: now, byId: new Map() };
    if (!tripStops.byId.has(id)) tripStops.byId.set(id, trayectos.stops?.(id)?.stops ?? null);
    return tripStops.byId.get(id);
  };
  const passing = new WeakMap(); // ctx → passIndex
  const passingOf = (c) => {
    let index = passing.get(c);
    if (!index) passing.set(c, (index = passIndex(c.vehicles, stopsOf)));
    return index;
  };
  let catalog = { at: -Infinity, list: [] };
  const stationList = () => {
    if (clock.now() - catalog.at >= DIRECTORY_EVERY_MS) catalog = { at: clock.now(), list: trayectos.stations?.() ?? [] };
    return catalog.list;
  };
  /** Los hechos de lo que se sigue: los de avisos.js y los de los trayectos. */
  const factsOf = (keys, provinces, c) => {
    const facts = collectFacts({ keys, provinces, ...c });
    for (const [key, list] of collectTrayectoFacts({ keys, ...c, stopsOf })) facts.set(key, list);
    return facts;
  };

  const stationOf = (code) => (code && read.station ? read.station(code) : null);
  const ctx = () => ({ vehicles: read.vehicles(), events: read.events(), alerts: read.alerts?.() ?? [], now: clock.now(), stationOf, creditOf });
  const reply = (chatId, text, buttons) => ({ chatId, text: fitMessage(text), ...(buttons?.length ? { buttons } : {}) });
  const count = (chat) => (chat ? chat.subs.size + chat.provinces.size : 0);
  const provinceTitle = (p) => `Avisos en ${p.name}`;
  const firesNote = (s) => (s?.fires ? ' (con focos de calor)' : '');

  /** El nombre de lo que se ve (directorio o catálogo de estaciones); null si ahora no se conoce. */
  function knownName(key) {
    if (followKind(key) === 'trayecto') return trayectoName(key, stationOf);
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
    const { lines, credits } = followKind(sub) === 'trayecto'
      ? trayectoStatus(sub, { ...c, stopsOf, index: passingOf(c) })
      : statusOf(sub, c);
    return [lines.join('\n'), credits.length ? credits.join(' · ') : null].filter(Boolean).join('\n\n');
  }

  /** Lo que ya se ve de algo al empezar a seguirlo no se avisa: se cuenta en la respuesta. */
  function baseline(sub, c) {
    const facts = sub.startsWith('prov:') ? factsOf([], [sub.slice(5)], c) : factsOf([sub], [], c);
    seen = trackFacts(seen, facts, c.now);
  }

  function chatFor(chatId, now) {
    let chat = chats.get(chatId);
    if (chat) return chat;
    if (chats.size >= limits.chats) return null;
    chat = { id: chatId, since: now, subs: new Map(), provinces: new Map(), digest: null, digestDay: null };
    chats.set(chatId, chat);
    note('alta');
    return chat;
  }

  /** Quita un chat que ya no sigue nada: no se guarda nada de quien no sigue nada. */
  function dropIfEmpty(chat) {
    if (chat && !count(chat) && chats.delete(chat.id)) note('baja', 'dejar');
  }

  function follow(chatId, key, name = null) {
    if (!isFollowKey(key)) return [reply(chatId, 'Eso no es algo que se pueda seguir. Búscalo con /seguir o desde la web.')];
    const c = ctx();
    const station = followKind(key) === 'parada';
    // Una estación está en el catálogo o no existe: de una que no está nunca llegaría nada.
    if (station && !stationOf(stopCode(key))) {
      return [reply(chatId, `Esa estación no la encuentro en el catálogo del radar. Búscala en el mapa y pulsa «Avísame por Telegram» en su ficha: ${webUrl}`)];
    }
    if (followKind(key) === 'trayecto' && !trayectoName(key, stationOf)) {
      return [reply(chatId, 'Ese trayecto no lo puedo seguir: alguna de sus estaciones no está en el catálogo del radar. Escríbelo con /trayecto.')];
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

  /** Sigue una provincia; con `fires`, también sus focos de calor (y si ya la seguía, se los añade). */
  function followProvince(chatId, p, { fires = false } = {}) {
    const sub = provinceSub(p.id);
    const c = ctx();
    const existing = chats.get(chatId);
    const had = existing?.provinces.get(p.id);
    if (had && fires && !had.fires) {
      had.fires = true;
      dirty = true;
      return [reply(chatId, `Hecho: en ${p.name} ahora también te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: `
        + `sólo los más claros, y nunca son un incendio confirmado. Para quitarlos: /provincia ${p.name} sin incendios\n\nAhora:\n${statusText(sub, { ...c, fires: true })}`)];
    }
    if (had) return [reply(chatId, `Ya sigues los avisos de ${p.name}${firesNote(had)}.\n\nAhora:\n${statusText(sub, { ...c, fires: had.fires })}`)];
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, `Ya sigues ${limits.subsPerChat} cosas, el máximo. Deja alguna con /dejar.`)];
    if ((existing?.provinces.size ?? 0) >= limits.provincesPerChat) {
      return [reply(chatId, `Ya sigues ${limits.provincesPerChat} provincias, el máximo. Deja alguna con /dejar.`)];
    }
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, 'Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.')];
    baseline(sub, c);
    chat.provinces.set(p.id, { since: c.now, checkedAt: c.now, ...(fires ? { fires: true } : {}) });
    dirty = true;
    return [reply(chatId, `Hecho: te aviso en ${p.name} de los avisos naranja y rojo de AEMET, de los terremotos que puedan `
      + `sentirse y de los avisos oficiales (planes de emergencia y cortes de luz). ${PROVINCE_TRAFFIC_TEXT} La zona de cada provincia es aproximada: `
      + `cerca de su límite puede llegarte alguno de la vecina.\n\nAhora:\n${statusText(sub, { ...c, fires })}\n\n${provinceExtrasText(p, { fires })}`)];
  }

  /** Deja los focos de calor de una provincia que sigue (el resto de sus avisos, no). */
  function dropFires(chatId, p) {
    const had = chats.get(chatId)?.provinces.get(p.id);
    if (!had) return [reply(chatId, `No sigues ${p.name}. Para seguirla: /provincia ${p.name}`)];
    if (!had.fires) return [reply(chatId, `En ${p.name} no te aviso de los focos de calor; del resto de sus avisos, sí.`)];
    delete had.fires;
    dirty = true;
    return [reply(chatId, `Hecho: en ${p.name} ya no te aviso de los focos de calor; del resto de sus avisos, sí.`)];
  }

  /** Seguir una carretera (entera o en una provincia): `sub` es de roadSub. Cuenta en el tope de cosas por chat. */
  function followRoad(chatId, sub) {
    const c = ctx();
    const existing = chats.get(chatId);
    if (existing?.subs.has(sub.key)) return [reply(chatId, `Ya sigues ${existing.subs.get(sub.key).name}.\n\nAhora:\n${statusText(sub.key, c)}`)];
    if (count(existing) >= limits.subsPerChat) return [reply(chatId, `Ya sigues ${limits.subsPerChat} cosas, el máximo. Deja alguna con /dejar.`)];
    const chat = chatFor(chatId, c.now);
    if (!chat) return [reply(chatId, 'Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.')];
    const name = roadName(sub.road, c.events);
    baseline(sub.key, c);
    chat.subs.set(sub.key, { name: roadTitle(name, sub.province), since: c.now, checkedAt: c.now });
    dirty = true;
    return [reply(chatId, `${roadFollowedText(sub, name)}\n\nAhora:\n${statusText(sub.key, c)}\n\n/mis para ver lo que sigues · /dejar para dejar de seguirlo`)];
  }

  function roadCmd(chatId, arg) {
    const wanted = parseRoadRequest(arg);
    return wanted.key ? followRoad(chatId, wanted) : [reply(chatId, roadRequestHelp(wanted, arg))];
  }

  /** Lo que sigue un chat, en orden: lo que se ve en /mis y lo que numeran /dejar y los botones. */
  function listOf(chat) {
    if (!chat) return [];
    return [
      ...[...chat.subs].map(([key, s]) => ({ sub: key, name: s.name })),
      ...[...chat.provinces].map(([id, s]) => ({ sub: provinceSub(id), name: `${provinceTitle(provinceById(id))}${firesNote(s)}`, fires: !!s.fires })),
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
      const { place, fires } = provinceOption(arg);
      const p = findProvince(place);
      if (p) return fires === false ? dropFires(chatId, p) : followProvince(chatId, p, { fires: !!fires });
      // Algo que parece una carretera («A-7»): no se sigue sin preguntar (también podría ser una línea que ahora no circula).
      const road = parseRoadRequest(arg);
      if (road.key) return [reply(chatId, `No encuentro ningún vehículo ni línea así. Si es una carretera, para sus cortes y accidentes: /carretera ${arg}`)];
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
      for (const it of listOf(chat)) blocks.push(`${it.name}:\n${statusText(it.sub, { ...c, fires: it.fires })}`);
    } else if (isFollowKey(arg)) {
      if (followKind(arg) !== 'parada') refreshDirectory(c, arg);
      blocks.push(`${nameOf(arg)}:\n${statusText(arg, c)}`);
    } else {
      refreshDirectory(c);
      const found = searchDirectory(directory, arg, { limit: 3 });
      // «/estado Granada incendios», con los focos de calor; sólo la provincia, si los sigue.
      const option = provinceOption(arg);
      const p = !found.length ? findProvince(option.place) : null;
      const fires = option.fires ?? !!chat?.provinces.get(p?.id)?.fires;
      if (p) blocks.push(`${provinceTitle(p)}:\n${statusText(provinceSub(p.id), { ...c, fires })}`);
      const road = !found.length && !p ? parseRoadRequest(arg) : null; // «/estado A-7»: cómo está esa carretera
      if (road?.key) blocks.push(`${roadTitle(roadName(road.road, c.events), road.province)}:\n${statusText(road.key, c)}`);
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

  /**
   * /trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V: sus estaciones, del catálogo. Si con esos nombres sólo hay un
   * trayecto posible, lo sigue; si hay varios (dos «Atocha»), una lista con cada combinación.
   */
  function trayectoCmd(chatId, arg) {
    if (!arg) return [reply(chatId, trayectoHelpText())];
    const parsed = parseTrayectoText(arg);
    if (parsed.error) return [reply(chatId, trayectoErrorText(parsed))];
    const found = trayectoOptions(stationList(), parsed, { limit: limits.menuItems });
    if (found.error) return [reply(chatId, trayectoErrorText(found))];
    if (found.total === 1) return follow(chatId, found.pairs[0].key, found.pairs[0].name);
    const buttons = menu(chatId, 'add', found.pairs.map((p) => ({ sub: p.key, name: p.name, label: p.label })), clock.now());
    const text = found.total > found.pairs.length
      ? `Con esos nombres hay ${found.total} trayectos posibles; aquí van los ${found.pairs.length} primeros. Si no está el tuyo, escribe el nombre entero de las estaciones. ¿Cuál es?`
      : 'Hay varias estaciones con esos nombres. ¿Cuál es tu trayecto?';
    return [reply(chatId, text, buttons)];
  }

  function provinceCmd(chatId, arg) {
    if (!arg) return [reply(chatId, 'Dime la provincia: /provincia Valencia, /provincia A Coruña, /provincia Bizkaia…')];
    // «/provincia Granada incendios»: también los focos de calor; «/provincia Granada sin incendios»: sin ellos.
    const { place, fires } = provinceOption(arg);
    const p = findProvince(place);
    if (!p) return [reply(chatId, `No conozco la provincia «${place}». Escríbela como en el mapa: /provincia Valencia, /provincia Illes Balears…`)];
    return fires === false ? dropFires(chatId, p) : followProvince(chatId, p, { fires: !!fires });
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
    if (had) note('baja', 'baja');
    return [reply(chatId, had ? 'Hecho: he borrado todo lo de este chat. Si vuelves a seguir algo, empezará de cero.'
      : 'De este chat no tenía nada guardado.')];
  }

  function data(chatId) {
    const chat = chats.get(chatId);
    const view = chat && {
      id: chat.id, since: chat.since, digest: chat.digest,
      subs: [...chat.subs.values()], provinces: [...chat.provinces].map(([id, s]) => ({ name: `${provinceById(id)?.name ?? id}${firesNote(s)}` })),
    };
    return [reply(chatId, dataText(view, { fmtWhen }))];
  }

  function start(chatId, arg) {
    if (isFollowKey(arg)) return follow(chatId, arg);
    // Una carretera, desde la ficha de una incidencia de tráfico en la web («c-A7»); con una provincia que no existe, no.
    const road = isRoadKey(arg) ? roadSub(arg) : null;
    if (road) return followRoad(chatId, road);
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
      totals = parseTotals(saved?.version === 1 ? saved.totals : null, clock.now());
      if (!saved || saved.version !== 1) return 0;
      offset = Number.isSafeInteger(saved.offset) ? saved.offset : 0;
      for (const c of Array.isArray(saved.chats) ? saved.chats.slice(0, limits.chats) : []) {
        if (!Number.isSafeInteger(c?.id)) continue;
        const subs = new Map();
        for (const s of Array.isArray(c.subs) ? c.subs.slice(0, limits.subsPerChat) : []) {
          if (!(isFollowKey(s?.key) || roadSub(s?.key)) || typeof s.name !== 'string') continue;
          subs.set(s.key, { name: cutText(s.name, 200), since: num(s.since), checkedAt: num(s.checkedAt), ...(s.guessed === true ? { guessed: true } : {}) });
        }
        const provinces = new Map();
        for (const p of Array.isArray(c.provinces) ? c.provinces.slice(0, limits.provincesPerChat) : []) {
          if (provinceById(p?.id)) provinces.set(p.id, { since: num(p.since), checkedAt: num(p.checkedAt), ...(p.fires === true ? { fires: true } : {}) });
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
      if (saved.totals === undefined && chats.size) {
        // Un fichero de antes de los totales: quienes ya siguen algo cuentan como altas, desde la primera (las bajas de
        // entonces no constan). Se guarda en la siguiente ronda.
        totals.added = chats.size;
        totals.since = [...chats.values()].reduce((min, c) => (c.since > 0 && c.since < min ? c.since : min), totals.since);
        dirty = true;
      }
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
        note('orden', 'limite');
        return { replies: r.count === limits.messagesPerMinute + 1 ? [reply(chatId, 'Demasiados mensajes seguidos. Espera un minuto, por favor.')] : [] };
      }
      if (msg.callback !== undefined) {
        note('orden', 'boton');
        return callback(chatId, msg.callback);
      }
      const { command, arg } = parseCommand(msg.text);
      // /start con una clave o una provincia: llega desde un enlace de la web («Avísame por Telegram»).
      note('orden', command === 'start' && (isFollowKey(arg) || isRoadKey(arg) || /^prov-/.test(arg)) ? 'enlace' : command);
      const run = {
        start: () => start(chatId, arg),
        // «/seguir Alcalá > Atocha 7-9» es un trayecto.
        seguir: () => (looksLikeTrayecto(arg) ? trayectoCmd(chatId, arg) : search(chatId, arg)),
        trayecto: () => trayectoCmd(chatId, arg),
        // Texto sin orden: una búsqueda, salvo que sea charla («hola», «gracias», «vale»).
        buscar: () => {
          if (looksLikeTrayecto(arg)) return trayectoCmd(chatId, arg);
          const talk = smallTalk(arg);
          if (!talk) return search(chatId, arg, { confirm: true });
          return [reply(chatId, talk === 'ayuda' ? helpText({ webUrl, limits }) : smallTalkText(talk))];
        },
        estado: () => status(chatId, arg),
        provincia: () => provinceCmd(chatId, arg),
        carretera: () => roadCmd(chatId, arg),
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
      const facts = factsOf(keys, provinces, c);
      seen = trackFacts(seen, facts, now);
      const out = [];
      const today = madridDay(now);
      const hour = madridHourMinute(now);
      for (const chat of chats.values()) {
        const sent = new Set(); // los avisos ya contados a este chat en esta ronda: no se repiten (estación y línea)
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
          const fresh = withoutRepeats(newFacts(key, facts.get(key), seen, s.checkedAt), sent);
          s.checkedAt = now;
          if (fresh.length) {
            out.push(reply(chat.id, factsMessage(s.name, fresh, { webUrl })));
            note('aviso', 'aviso');
          }
        }
        for (const [id, s] of chat.provinces) {
          const sub = provinceSub(id);
          // Los focos de calor, sólo a quien los ha pedido en esa provincia.
          const fresh = provinceFacts(newFacts(sub, facts.get(sub), seen, s.checkedAt), { fires: s.fires });
          s.checkedAt = now;
          if (fresh.length) {
            out.push(reply(chat.id, factsMessage(provinceTitle(provinceById(id)), fresh, { webUrl })));
            note('aviso', 'aviso');
          }
        }
        if (chat.digest && chat.digestDay !== today && hour >= chat.digest) {
          chat.digestDay = today;
          const blocks = listOf(chat).map((it) => `${it.name}:\n${statusText(it.sub, { ...c, fires: it.fires })}`);
          for (const text of packed([`Parte de las ${chat.digest}:`, ...blocks])) out.push(reply(chat.id, text));
          note('aviso', 'parte');
        }
      }
      if (out.length) dirty = true;
      return out;
    },

    /** Telegram dice que ese chat ya no existe o ha bloqueado el bot: se borra todo lo suyo. */
    forget(chatId) {
      menus.delete(chatId);
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
