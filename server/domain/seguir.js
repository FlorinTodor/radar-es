// Qué se puede seguir de un vehículo, de cualquier tipo (tren, autobús, metro, tranvía… y los que vengan):
// un servicio (un recorrido concreto que se repite cada día), una línea o una parada. Cada uno tiene una
// clave estable entre días y entre reinicios, que rellena el ADAPTADOR de cada fuente (es el que sabe qué
// es estable en sus datos) y que usan Mis trenes, la puntualidad, el día en cifras y el bot de Telegram sin
// saber de qué fuente ni de qué tipo de vehículo es. Puro: sin red, ni reloj, ni disco. Ver docs/vehiculos.md.
//
// Formato: «<tipo>-<parte>-<parte>…», sólo con [A-Za-z0-9_-] y como mucho 64 caracteres: así una clave es
// tal cual el parámetro start de Telegram (t.me/<bot>?start=<clave>), sin tablas para volver a ella.
//   s-<red>-<número>                         servicio con número propio (trenes de Renfe, Ouigo)
//   s-<red>-<línea>-<origen>-<HHMM>          servicio de un horario: su línea, su parada de origen y su hora de salida
//   l-<red>[-<ámbito>][-<línea>]             línea (el ámbito: el núcleo de Cercanías, «Madrid»; sin línea: toda la red)
//   p-[<catálogo>-]<código>                  parada o estación de un catálogo del radar
//   t-<origen>-<destino>-<HHMMHHMM>-<días>   trayecto del bot: dos estaciones de un catálogo (su código entero), la
//                                            franja en la que sale del origen y los días (máscara en hexadecimal)
// <red> es el operador tal como lo muestra el radar, en minúsculas y sin signos («EMT Málaga» → «emtmalaga»).
// Cada parte guarda letras y cifras; lo demás va como «_» y su código en hexadecimal («L-1» → «L_2D1»), y una
// parte demasiado larga se cambia por «__» y una huella corta (FNV-1a): sigue sirviendo para comparar, pero
// no para leerla (el nombre se toma del vehículo, de la incidencia o de quien la guardó).
// Las carreteras que sigue el bot de Telegram tienen su propia clave, «c-…» (al final de este fichero).

export const FOLLOW_KINDS = { servicio: 's', linea: 'l', parada: 'p', trayecto: 't' };
const KIND_OF_PREFIX = { s: 'servicio', l: 'linea', p: 'parada', t: 'trayecto' };
export const FOLLOW_KEY_MAX = 64;
const NETWORK_MAX = 20;
const PART_MAX = 24;
const SCOPE_MAX = 24;
// Una parte: letras, cifras y «_XX» (un byte escapado); «__» y una huella; la red abreviada con su huella; o
// «_» sola (un servicio de un horario sin nombre de línea).
const PART_RE = /^(?:(?:[A-Za-z0-9]|_[0-9A-F]{2})+|__[0-9a-z]{7}|[a-z0-9]+__[0-9a-z]{7}|_)$/;

/** Huella FNV-1a de 32 bits de un texto, en base 36 y con 7 caracteres. */
export function shortHash(text) {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(String(text))) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/** Una parte de la clave: letras y cifras tal cual; lo demás, «_» y su código UTF-8 en hexadecimal. */
function escapePart(text) {
  let out = '';
  for (const ch of String(text)) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else for (const byte of new TextEncoder().encode(ch)) out += `_${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** Una parte que no pase de `max`: si no cabe, «__» y su huella (no aparece nunca al escapar: «_» va como «_5F»). */
function part(text, max = PART_MAX) {
  const escaped = escapePart(String(text).trim());
  return escaped && escaped.length <= max ? escaped : `__${shortHash(String(text).trim())}`;
}

/** La red de una clave: el operador en minúsculas, sin tildes ni signos; si es muy largo, abreviado con su huella. */
export function networkPart(operator) {
  const slug = String(operator ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!slug) return null;
  return slug.length <= NETWORK_MAX ? slug : `${slug.slice(0, NETWORK_MAX - 9)}__${shortHash(slug)}`;
}

/** Un número de servicio sin ceros a la izquierda («08058» → «8058»); si no es un número, la parte tal cual. */
const numberPart = (number) => (/^\d+$/.test(String(number)) ? String(Number(number)) : part(number));

/** «HHMM» de unos segundos del día de servicio (pasada la medianoche del horario, 24, 25…). */
function hhmm(seconds) {
  const min = Math.floor(seconds / 60);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}${String(min % 60).padStart(2, '0')}`;
}

const join = (kind, parts) => {
  const key = [kind, ...parts].join('-');
  return isFollowKey(key) ? key : null;
};

/**
 * Servicio con número propio, el mismo todos los días: un tren de Renfe («Avant 08058» → «s-renfe-8058»).
 * @param {{ operator: string, number: string|number }} s
 * @returns {string|null}
 */
export function numberedServiceKey({ operator, number }) {
  const net = networkPart(operator);
  if (!net || number === null || number === undefined || number === '') return null;
  return join('s', [net, numberPart(number)]);
}

/**
 * Servicio de un horario, reconocible cada día por su línea, su parada de origen (su código en el
 * horario, como huella) y su hora de salida de ella («el 27 de las 07:32 desde Plaza Mayor»). Si otro día
 * sale a otra hora, es otro servicio: es lo que dice el horario.
 * @param {{ operator: string, line?: string|null, origin: string, departure: number }} s
 *   origin: código de la parada de origen en el horario (stop_id); departure: segundos del día de servicio
 * @returns {string|null}
 */
export function scheduledServiceKey({ operator, line, origin, departure }) {
  const net = networkPart(operator);
  if (!net || !origin || !Number.isFinite(departure) || departure < 0 || departure >= 100 * 3600) return null;
  return join('s', [net, line ? part(line) : '_', shortHash(origin), hhmm(departure)]);
}

/**
 * Línea de un operador; `scope`, si la misma línea existe en varios sitios del mismo operador (los núcleos
 * de Cercanías: hay C1 en Madrid, València, Sevilla…). Sin línea, toda la red del operador (Metro Bilbao,
 * que no dice la línea de cada tren).
 * @param {{ operator: string, line?: string|null, scope?: string|null }} l
 * @returns {string|null}
 */
export function lineKey({ operator, line = null, scope = null }) {
  const net = networkPart(operator);
  if (!net) return null;
  if (!line) return join('l', [net]); // el ámbito sólo con línea: «l-renfe-Madrid» se leería como la línea Madrid
  const key = join('l', [net, ...(scope ? [part(scope, SCOPE_MAX)] : []), part(line)]);
  // Si con el ámbito legible pasa de 64, el ámbito va como huella (la red y la línea siguen legibles).
  return key ?? (scope ? join('l', [net, part(scope, 0), part(line)]) : null);
}

/**
 * Parada o estación por su código en el catálogo del radar («71801» de Renfe, «tmb:123» de una red):
 * reversible (stopCode).
 * @param {string} code
 * @returns {string|null}
 */
export function stopKey(code) {
  const parts = String(code ?? '').split(':').filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  return join('p', parts.map((p) => escapePart(p)));
}

/** El código de catálogo de una clave de parada (la inversa de stopKey); null si no lo es. */
export function stopCode(key) {
  const parsed = parseFollowKey(key);
  return parsed?.kind === 'parada' ? parsed.parts.join(':') : null;
}

// Un trayecto no lo da ningún vehículo: lo escribe quien lo sigue (el bot). Sus dos estaciones, por su código de
// catálogo entero (se puede deshacer: hay que volver a encontrarlas), la franja en la que sale del origen
// («HHMMHHMM», de una hora a otra más tarde del mismo día) y los días, una máscara de 7 bits en hexadecimal
// (bit 0 el lunes… bit 6 el domingo: «1f» es de lunes a viernes). Con los códigos más largos del catálogo cabe en 64.
const STATION_PART = '((?:[A-Za-z0-9]|_[0-9A-F]{2})+)';
const TRAYECTO_RE = new RegExp(`^t-${STATION_PART}-${STATION_PART}-(\\d{2})(\\d{2})(\\d{2})(\\d{2})-([0-7][0-9a-f])$`);
/** Días de la semana de un trayecto, como en los horarios: L M X J V S D (bit 0 el lunes). */
export const DAY_LETTERS = 'LMXJVSD';
export const ALL_DAYS = 0x7f;
const fmtMin = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/**
 * Trayecto de una estación a otra, en una franja y unos días («Alcalá de Henares → Madrid-Atocha Cercanías, de
 * 07:00 a 09:00, de lunes a viernes» → «t-70103-18000-07000900-1f»).
 * @param {{ origin: string, destination: string, from: number, to: number, days: number }} t
 *   origin y destination: códigos de catálogo («70103», «tmb:P.6660111»); from y to: minutos del día en que sale
 *   del origen (from < to); days: máscara de días (bit 0 el lunes)
 * @returns {string|null}  null si no es válido o no cabe en 64
 */
export function trayectoKey({ origin, destination, from, to, days }) {
  if (!origin || !destination || !Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(days)) return null;
  if (from < 0 || to > 24 * 60 - 1 || from >= to || days < 1 || days > ALL_DAYS) return null;
  const hhmm = (min) => fmtMin(min).replace(':', '');
  const key = `t-${escapePart(String(origin))}-${escapePart(String(destination))}-${hhmm(from)}${hhmm(to)}-${days.toString(16).padStart(2, '0')}`;
  return isFollowKey(key) ? key : null;
}

/** Lo que dice la clave de un trayecto, o null si no es una válida. */
function readTrayecto(key) {
  const m = TRAYECTO_RE.exec(key);
  if (!m) return null;
  const [, o, d, h1, m1, h2, m2, mask] = m;
  const from = Number(h1) * 60 + Number(m1);
  const to = Number(h2) * 60 + Number(m2);
  const days = parseInt(mask, 16);
  if (Number(h1) > 23 || Number(h2) > 23 || Number(m1) > 59 || Number(m2) > 59 || from >= to || !days || o === d) return null;
  const origin = unescapePart(o);
  const destination = unescapePart(d);
  return origin && destination ? { origin, destination, from, to, days } : null;
}

/** «de lunes a viernes», «sábados y domingos», «lunes, miércoles y viernes», «todos los días» (máscara de días). */
export function daysText(mask) {
  const ONE = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
  const MANY = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábados', 'domingos'];
  const on = [0, 1, 2, 3, 4, 5, 6].filter((i) => mask & (1 << i));
  if (on.length === 7) return 'todos los días';
  if (!on.length) return 'ningún día';
  // Seguidos (también pasando del domingo al lunes): «de viernes a lunes».
  const start = on.find((i) => !(mask & (1 << ((i + 6) % 7))));
  if (on.length >= 3 && on.every((_, k) => mask & (1 << ((start + k) % 7)))) return `de ${ONE[start]} a ${ONE[(start + on.length - 1) % 7]}`;
  if (on.length === 1) return `los ${MANY[on[0]]}`;
  const names = on.map((i) => MANY[i]);
  return `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
}

/** ¿Es una clave válida? (su tipo, de una a cuatro partes bien escritas y como mucho 64 caracteres) */
export function isFollowKey(key) {
  if (typeof key !== 'string' || key.length > FOLLOW_KEY_MAX) return false;
  if (key.startsWith('t-')) return readTrayecto(key) !== null;
  if (!/^[slp]-/.test(key)) return false;
  const parts = key.slice(2).split('-');
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => PART_RE.test(p));
}

const unescapePart = (p) => {
  if (p.startsWith('__')) return null; // huella: no se puede leer
  const bytes = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '_') {
      bytes.push(parseInt(p.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(p.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

/**
 * Las partes de una clave: su tipo y sus partes ya legibles (null las que van como huella).
 * @returns {{ kind: 'servicio'|'linea'|'parada'|'trayecto', network: string|null, parts: Array<string|null>,
 *             number?: string, departure?: string, origin?: string, destination?: string, from?: string, to?: string,
 *             days?: number }|null}
 *   network: la red (no en las paradas ni los trayectos); number: el de un servicio con número; departure: «HH:MM»
 *   del de un horario. Un trayecto: los códigos de sus dos estaciones (origin, destination; también en parts), su
 *   franja («HH:MM», from y to) y sus días (máscara, bit 0 el lunes).
 */
export function parseFollowKey(key) {
  if (!isFollowKey(key)) return null;
  const [prefix, ...raw] = key.split('-');
  const kind = KIND_OF_PREFIX[prefix];
  if (kind === 'trayecto') {
    const t = readTrayecto(key);
    return { kind, network: null, parts: [t.origin, t.destination], origin: t.origin, destination: t.destination, from: fmtMin(t.from), to: fmtMin(t.to), days: t.days };
  }
  if (kind === 'parada') return { kind, network: null, parts: raw.map(unescapePart) };
  const [network, ...rest] = raw;
  const parts = rest.map((p) => (p === '_' ? null : unescapePart(p)));
  const out = { kind, network, parts };
  if (kind === 'servicio' && rest.length === 1) out.number = parts[0];
  if (kind === 'servicio' && rest.length === 3 && /^\d{4}$/.test(rest[2])) out.departure = `${rest[2].slice(0, 2)}:${rest[2].slice(2)}`;
  return out;
}

/** El tipo de una clave («servicio», «linea», «parada», «trayecto») o null. */
export const followKind = (key) => (isFollowKey(key) ? KIND_OF_PREFIX[key[0]] : null);

/**
 * Cómo se llama lo que se sigue, para enseñarlo («Avant 08058», «Línea 27 · EMT Málaga, la de las 07:32
 * desde Plaza Mayor», «Línea C4a · Renfe Cercanías»). Con lo que se sepa de él (el vehículo, la incidencia o
 * lo que se guardó al seguirlo); sin nada, lo que se lea de la clave.
 * @param {string} key
 * Un trayecto: «<origen> → <destino> (HH:MM-HH:MM, <días>)», con los nombres de sus estaciones (originName,
 * destinationName) o, sin ellos, sus códigos.
 * @param {{ operator?: string, service?: string, line?: string|null, number?: string|null, label?: string|null,
 *           origin?: string|null, departure?: string|null, area?: string|null, name?: string|null, modeLabel?: string|null,
 *           originName?: string|null, destinationName?: string|null }} [known]
 * @returns {string|null}
 */
export function describeFollow(key, known = {}) {
  const parsed = parseFollowKey(key);
  if (!parsed) return null;
  const operator = known.operator ?? parsed.network;
  if (parsed.kind === 'parada') return known.name ?? parsed.parts.filter(Boolean).join(':');
  if (parsed.kind === 'trayecto') {
    return `${known.originName ?? parsed.origin} → ${known.destinationName ?? parsed.destination} (${parsed.from}-${parsed.to}, ${daysText(parsed.days)})`;
  }
  if (parsed.kind === 'linea') {
    if (!parsed.parts.length) return `${known.service && known.service !== operator ? `${known.service} · ` : ''}${operator}: toda la red`;
    // «<servicio o tipo> <línea> · <operador> (<ámbito>)»: el ámbito es el de la clave (el núcleo), nunca dónde
    // está ahora el vehículo; y si la línea es el propio producto (AVE), sin repetirlo.
    const line = known.line ?? parsed.parts.at(-1) ?? '(sin nombre legible)';
    const scope = parsed.parts.length > 1 ? parsed.parts[0] : null;
    const kind = known.service && known.service !== operator ? known.service : known.modeLabel ?? 'Línea';
    const name = kind === line ? line : `${kind} ${line}`;
    return `${name} · ${operator}${scope ? ` (${scope})` : ''}`;
  }
  if (parsed.number !== undefined) {
    // Con su línea si la tiene y no es el propio producto: «Cercanías C3 20071», «Rodalies R2S 25535», «AVE 05742».
    const service = known.service ?? operator;
    const withLine = known.line && known.line !== service && !service.split(' ').includes(known.line) ? `${service} ${known.line}` : service;
    return `${withLine} ${known.number ?? known.label ?? parsed.number}`;
  }
  const line = known.line ?? parsed.parts[0];
  const departure = known.departure ?? parsed.departure;
  return [`${line ? `${known.modeLabel ?? 'Línea'} ${line}` : 'Servicio'} · ${operator}`, departure && `el de las ${departure}`,
    known.origin && `desde ${known.origin}`].filter(Boolean).join(', ');
}

/**
 * ¿Responde a esta clave algo con estas claves? (un vehículo, una cancelación: su lista `follow`)
 * @param {string[]|undefined|null} follow  @param {string} key
 */
export const answersTo = (follow, key) => Array.isArray(follow) && follow.includes(key);

/** Las claves de varios, sin repetir y en orden: primero los servicios, luego las líneas y las paradas. */
export function mergeFollow(...lists) {
  const all = [...new Set(lists.flat().filter(isFollowKey))];
  const rank = { s: 0, l: 1, p: 2, t: 3 };
  return all.sort((a, b) => rank[a[0]] - rank[b[0]]);
}

/** Lista `follow` de un vehículo o de un viaje: las claves válidas, sin repetir (vacías fuera). */
export function followOf(...keys) {
  const list = mergeFollow(keys);
  return list.length ? list : undefined;
}

// ---------- Carreteras (el bot de Telegram) ----------
// Una carretera no es un vehículo: su clave no es de las de arriba (isFollowKey no la acepta, así que ni «Mis
// trenes» ni /api/live/siguiendo la ven), pero sigue las mismas reglas para ir tal cual en el enlace del bot
// (t.me/<bot>?start=<clave>): «c-<carretera>[-<provincia>]», sólo [A-Za-z0-9_-] y muy por debajo de 64.
//   c-A7          la A-7 entera
//   c-A7-malaga   la A-7 en la provincia de Málaga (su id sin guiones: «santa-cruz-de-tenerife» → «santacruzdetenerife»)
// <carretera> es su código en mayúsculas sin guiones, espacios ni puntos («A-7», «a7» y «A 7» → «A7»; «N-121-A» y
// «N-121A» → «N121A»): así cada fuente y quien la escribe dan la misma clave. Sólo vale lo que parece una
// carretera (de una a cuatro letras, una cifra y lo que siga; o una nacional en números romanos, «N-II»): un enlace
// se puede inventar, y lo que lleva escrito se repite al nombrarla.

const ROAD_CODE_RE = /^(?:[A-Z]{1,4}\d[A-Z0-9]{0,9}|N(?:I{1,3}|IV|VI?)A?)$/;
const ROAD_KEY_RE = /^c-([A-Z0-9]{1,14})(?:-([a-z]{2,24}))?$/;

/**
 * El código de una carretera tal como va en su clave («A-7», «a7», «A 7» → «A7»), o null si no lo parece.
 * @param {string} text
 * @returns {string|null}
 */
export function roadCode(text) {
  const code = String(text ?? '').slice(0, 40).normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROAD_CODE_RE.test(code) ? code : null;
}

/**
 * Cómo se escribe una carretera de la que sólo se sabe su código: sus letras, un guion y lo demás («A7» → «A-7»,
 * «AP7» → «AP-7», «NII» → «N-II»). Si alguna fuente la publica ahora, mejor como la escribe ella («TE-V-1121»).
 * @param {string} code
 */
export function roadLabel(code) {
  const m = /^(N)((?:I{1,3}|IV|VI?)A?)$/.exec(code) ?? /^([A-Z]+)(\d.*)$/.exec(code);
  return m ? `${m[1]}-${m[2]}` : code;
}

/** ¿Es una clave de carretera bien escrita? (que su provincia exista lo mira quien la usa) */
export function isRoadKey(key) {
  const m = typeof key === 'string' && key.length <= FOLLOW_KEY_MAX ? ROAD_KEY_RE.exec(key) : null;
  return Boolean(m && ROAD_CODE_RE.test(m[1]));
}

/**
 * La clave de una carretera, entera o en una provincia (su id, el de domain/provincias.js); null si no lo parece.
 * @param {string} road  como se escriba («A-7», «a7»)
 * @param {string|null} [provinceId]
 * @returns {string|null}
 */
export function roadKey(road, provinceId = null) {
  const code = roadCode(road);
  if (!code) return null;
  const key = provinceId ? `c-${code}-${String(provinceId).replaceAll('-', '')}` : `c-${code}`;
  return isRoadKey(key) ? key : null;
}

/**
 * Las partes de una clave de carretera: su código y su provincia (el id sin guiones), o null si no lo es.
 * @returns {{ road: string, province: string|null }|null}
 */
export function parseRoadKey(key) {
  if (!isRoadKey(key)) return null;
  const [, road, province = null] = ROAD_KEY_RE.exec(key);
  return { road, province };
}
