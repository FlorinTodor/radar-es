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
// <red> es el operador tal como lo muestra el radar, en minúsculas y sin signos («EMT Málaga» → «emtmalaga»).
// Cada parte guarda letras y cifras; lo demás va como «_» y su código en hexadecimal («L-1» → «L_2D1»), y una
// parte demasiado larga se cambia por «__» y una huella corta (FNV-1a): sigue sirviendo para comparar, pero
// no para leerla (el nombre se toma del vehículo, de la incidencia o de quien la guardó).

export const FOLLOW_KINDS = { servicio: 's', linea: 'l', parada: 'p' };
const KIND_OF_PREFIX = { s: 'servicio', l: 'linea', p: 'parada' };
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

/** ¿Es una clave válida? (su tipo, de una a cuatro partes bien escritas y como mucho 64 caracteres) */
export function isFollowKey(key) {
  if (typeof key !== 'string' || key.length > FOLLOW_KEY_MAX || !/^[slp]-/.test(key)) return false;
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
 * @returns {{ kind: 'servicio'|'linea'|'parada', network: string|null, parts: Array<string|null>,
 *             number?: string, departure?: string }|null}
 *   network: la red (no en las paradas); number: el de un servicio con número; departure: «HH:MM» del de un horario
 */
export function parseFollowKey(key) {
  if (!isFollowKey(key)) return null;
  const [prefix, ...raw] = key.split('-');
  const kind = KIND_OF_PREFIX[prefix];
  if (kind === 'parada') return { kind, network: null, parts: raw.map(unescapePart) };
  const [network, ...rest] = raw;
  const parts = rest.map((p) => (p === '_' ? null : unescapePart(p)));
  const out = { kind, network, parts };
  if (kind === 'servicio' && rest.length === 1) out.number = parts[0];
  if (kind === 'servicio' && rest.length === 3 && /^\d{4}$/.test(rest[2])) out.departure = `${rest[2].slice(0, 2)}:${rest[2].slice(2)}`;
  return out;
}

/** El tipo de una clave («servicio», «linea», «parada») o null. */
export const followKind = (key) => (isFollowKey(key) ? KIND_OF_PREFIX[key[0]] : null);

/**
 * Cómo se llama lo que se sigue, para enseñarlo («Avant 08058», «Línea 27 · EMT Málaga, la de las 07:32
 * desde Plaza Mayor», «Línea C4a · Renfe Cercanías»). Con lo que se sepa de él (el vehículo, la incidencia o
 * lo que se guardó al seguirlo); sin nada, lo que se lea de la clave.
 * @param {string} key
 * @param {{ operator?: string, service?: string, line?: string|null, number?: string|null, label?: string|null,
 *           origin?: string|null, departure?: string|null, area?: string|null, name?: string|null, modeLabel?: string|null }} [known]
 * @returns {string|null}
 */
export function describeFollow(key, known = {}) {
  const parsed = parseFollowKey(key);
  if (!parsed) return null;
  const operator = known.operator ?? parsed.network;
  if (parsed.kind === 'parada') return known.name ?? parsed.parts.filter(Boolean).join(':');
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
  const rank = { s: 0, l: 1, p: 2 };
  return all.sort((a, b) => rank[a[0]] - rank[b[0]]);
}

/** Lista `follow` de un vehículo o de un viaje: las claves válidas, sin repetir (vacías fuera). */
export function followOf(...keys) {
  const list = mergeFollow(keys);
  return list.length ? list : undefined;
}
