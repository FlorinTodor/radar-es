// Directorio de lo que se puede seguir: las claves `follow` (domain/seguir.js) de los vehículos y de las
// cancelaciones que el radar ha visto hace poco, con su nombre y las palabras por las que se buscan. Con él, el
// bot encuentra «08058», «C4 Madrid» o «27 EMT Málaga» sin saber de qué fuente ni de qué tipo de vehículo es
// cada cosa: un barco o un avión con sus claves saldrían igual. Puro: sin red, ni reloj, ni disco.
import { describeFollow, followKind, networkPart, parseFollowKey } from '../seguir.js';
import { modeIds, modeInfo, modeNoun } from '../modos.js';
import { plainName } from '../provincias.js';

// Lo que se recuerda de cada clave: si no se ve en día y medio, sale (el tren de mañana a la misma hora sigue).
export const DIRECTORY_KEEP_MS = 36 * 3600_000;
export const DIRECTORY_MAX = 50_000;
const MAX_PLACES = 6;

/**
 * @typedef {object} Entry
 * @property {string} key
 * @property {'servicio'|'linea'} kind
 * @property {string} name        Cómo se llama («Avant 08058», «Cercanías C4b · Renfe (Madrid)»).
 * @property {string|null} mode
 * @property {string|null} operator
 * @property {string|null} line
 * @property {string|null} number  El de un servicio con número propio, sin ceros a la izquierda.
 * @property {string|null} departure  «HH:MM» de un servicio de un horario.
 * @property {string[]} places    Orígenes y destinos vistos (para buscar y para distinguir dos líneas en una lista).
 *   El núcleo de una línea de Cercanías va en su clave y en su nombre («Cercanías C4a · Renfe (Madrid)»): «C4
 *   Madrid» la encuentra por él.
 * @property {boolean} [wide]     Una línea vista con más de MAX_PLACES orígenes y destinos distintos: no es un
 *   recorrido, sino todos los de un producto en toda España («Avant · Renfe», «Media Distancia · Renfe») o la misma
 *   línea en varias ciudades («Autobús L4 · ALSA»). No se encuentra por un sitio («/seguir Lleida» ofrecía «Avant ·
 *   Renfe (Sevilla – Málaga)», que son todos los Avant): sólo si se escribe su nombre, y se dice que son todos.
 * @property {number} seen        Última vez que se vio (epoch ms).
 */

const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** «Tren», «Autobús»… del registro de tipos: un tipo nuevo trae su nombre sin tocar esto. */
export const modeWord = (mode) => capital(modeInfo(mode)?.noun ?? 'vehículo');

/** La línea que dice una clave de línea (su última parte) o, si va como huella, la que se sabe. */
function lineOf(key, known) {
  const parts = parseFollowKey(key)?.parts ?? [];
  return parts.length ? parts.at(-1) ?? known : null;
}

/**
 * Las entradas de lo que se puede seguir de un vehículo o de un viaje (el de una cancelación).
 * @param {{ follow?: string[], mode?: string, operator?: string, service?: string|null, line?: string|null,
 *           label?: string|null, number?: string|null, origin?: string|null, destination?: string|null }} x
 * @param {number} now
 * @returns {Entry[]}
 */
export function entriesOf(x, now) {
  if (!Array.isArray(x?.follow)) return [];
  const out = [];
  const places = [x.origin, x.destination].filter((p) => typeof p === 'string' && p);
  for (const key of x.follow) {
    const kind = followKind(key);
    const parsed = parseFollowKey(key);
    if (!parsed || (kind !== 'servicio' && kind !== 'linea')) continue;
    const modeLabel = modeWord(x.mode);
    if (kind === 'servicio') {
      const numbered = parsed.number !== undefined;
      out.push({
        key,
        kind,
        name: describeFollow(key, numbered
          ? { operator: x.operator, service: x.service ?? undefined, number: x.number ?? x.label ?? undefined }
          : { operator: x.operator, line: x.line ?? undefined, origin: x.origin ?? undefined, modeLabel }),
        mode: x.mode ?? null,
        operator: x.operator ?? null,
        line: x.line ?? null,
        number: numbered ? parsed.number : null,
        departure: parsed.departure ?? null,
        places,
        seen: now,
      });
    } else {
      const line = lineOf(key, x.line ?? null);
      out.push({
        key,
        kind,
        name: describeFollow(key, { operator: x.operator, service: x.service ?? undefined, line: line ?? undefined, modeLabel }),
        mode: x.mode ?? null,
        operator: x.operator ?? null,
        line,
        number: null,
        departure: null,
        places,
        seen: now,
      });
    }
  }
  return out;
}

/**
 * Pone al día el directorio con lo que se ve ahora (vehículos y viajes de las cancelaciones y trenes sin datos)
 * y olvida lo que no se ve desde hace DIRECTORY_KEEP_MS. Cambia `dir` (es del caso de uso que lo guarda). El
 * nombre sólo se calcula para las claves nuevas: de las que ya están, sólo cuándo se vieron y por dónde pasan
 * (con miles de autobuses por minuto, rehacerlo todo cada vez costaba demasiado).
 * @param {Map<string, Entry>} dir
 * @param {{ vehicles?: object[], events?: object[], now: number, max?: number, keepMs?: number }} ctx
 */
export function updateDirectory(dir, { vehicles = [], events = [], now, max = DIRECTORY_MAX, keepMs = DIRECTORY_KEEP_MS }) {
  const visit = (x) => {
    if (!Array.isArray(x?.follow)) return;
    let fresh = null;
    for (const key of x.follow) {
      const old = dir.get(key);
      if (!old) {
        fresh ??= entriesOf(x, now);
        const entry = fresh.find((e) => e.key === key);
        if (entry) dir.set(key, entry);
        continue;
      }
      old.seen = now;
      for (const p of [x.origin, x.destination]) {
        if (!p || old.places.includes(p)) continue;
        if (old.places.length < MAX_PLACES) old.places.push(p);
        else if (old.kind === 'linea') old.wide = true;
      }
    }
  };
  for (const v of vehicles) visit(v);
  for (const ev of events) if (ev?.trip) visit(ev.trip);
  for (const [key, e] of dir) if (now - e.seen > keepMs) dir.delete(key);
  if (dir.size > max) {
    const oldest = [...dir.values()].sort((a, b) => a.seen - b.seen).slice(0, dir.size - max);
    for (const e of oldest) dir.delete(e.key);
  }
  return dir;
}

/**
 * Lo que el directorio sabe de las redes: el nombre de cada operador por la red de sus claves («emtmalaga» →
 * «EMT Málaga») y los ámbitos de sus líneas («Madrid», «Valencia»). Para nombrar algo que ahora no se ve sin
 * repetir el texto de su clave (guessedName).
 * @param {Map<string, Entry>} dir
 * @returns {{ operators: Map<string, string>, scopes: Set<string> }}
 */
export function knownNames(dir) {
  const operators = new Map();
  const scopes = new Set();
  for (const e of dir.values()) {
    const net = e.operator && networkPart(e.operator);
    if (net && !operators.has(net)) operators.set(net, e.operator);
    if (e.kind === 'linea') {
      const parts = parseFollowKey(e.key)?.parts ?? [];
      if (parts.length > 1 && parts[0]) scopes.add(parts[0]);
    }
  }
  return { operators, scopes };
}

// Lo único que se toma tal cual de una clave que no se conoce: un código corto de letras y cifras («C4a», «71»).
const CODE_RE = /^[A-Za-z0-9]{1,6}$/;

/**
 * El nombre de un servicio o una línea que ni se ve ni está en el directorio (un enlace guardado, o de noche tras
 * un reinicio). Una clave se puede inventar (t.me/<bot>?start=<clave>) y lo que lleva escrito es texto libre:
 * sólo se usa lo que se puede comprobar. El operador, si su red es conocida; el número de un servicio, si es un
 * número; su hora; la línea, si es un código corto; y su ámbito, si es uno conocido. Si la red no se conoce,
 * un nombre genérico. Se renueva cuando se vuelve a ver (follow-bot).
 * @param {string} key
 * @param {{ operators?: Map<string, string>, scopes?: Set<string> }} [known]  de knownNames
 * @returns {string|null}  null si no es un servicio ni una línea
 */
export function guessedName(key, { operators = new Map(), scopes = new Set() } = {}) {
  const p = parseFollowKey(key);
  if (!p || (p.kind !== 'servicio' && p.kind !== 'linea')) return null;
  const op = (p.network && operators.get(p.network)) || null;
  if (p.kind === 'linea') {
    if (!op) return 'esa línea (ahora no se ve)';
    if (!p.parts.length) return `${op}: toda la red`;
    const line = p.parts.at(-1);
    const scope = p.parts.length > 1 && scopes.has(p.parts[0]) ? p.parts[0] : null;
    return CODE_RE.test(line ?? '') ? `Línea ${line} · ${op}${scope ? ` (${scope})` : ''}` : `una línea de ${op}`;
  }
  if (!op) return 'ese servicio (ahora no se ve)';
  if (p.number !== undefined) return /^\d{1,6}$/.test(p.number ?? '') ? `${op} ${p.number}` : `un servicio de ${op}`;
  const line = p.parts[0];
  return `${CODE_RE.test(line ?? '') ? `Línea ${line}` : 'Servicio'} · ${op}${p.departure ? `, el de las ${p.departure}` : ''}`;
}

/**
 * Cómo se enseña una entrada en una lista: su nombre y, en una línea, dos de sus extremos para distinguirla; en una
 * que son muchos recorridos (`wide`), que son todos («Avant · Renfe (todos sus trenes)»). En español: el bot lo
 * traduce al enseñarlo (idioma.js nameText).
 */
export function entryLabel(e) {
  if (e.kind === 'linea' && e.wide) return `${e.name} (todos sus ${modeNoun(e.mode, true)})`;
  if (e.kind !== 'linea' || !e.places.length) return e.name;
  return `${e.name} (${e.places.slice(0, 2).join(' – ')})`;
}

const TIME_RE = /^(\d{1,2})[:.h]?(\d{2})$/;

// El texto en el que se busca cada entrada («␠palabra␠palabra␠»), preparado una vez mientras no cambien su
// nombre ni sus lugares: buscar es mirar si contiene «␠token» (empieza una palabra) o «␠token␠» (la palabra entera).
// En una línea de muchos recorridos (`wide`), sus sitios van aparte (`places`): no bastan para encontrarla.
const placeWord = (places, whole, prefix, t) => places.includes(whole) || (t.length >= 3 && places.includes(prefix));
const HAYSTACK = new WeakMap();
function haystackOf(e) {
  const sig = `${e.name}|${e.places.length}|${e.wide ? 1 : 0}`;
  const cached = HAYSTACK.get(e);
  if (cached?.sig === sig) return cached;
  const places = ` ${plainName(e.places.join(' '))} `;
  const prepared = {
    sig,
    text: e.wide ? ` ${plainName([e.name, e.operator].join(' '))} ` : ` ${plainName([e.name, e.operator, ...e.places].join(' '))} `,
    places: e.wide ? places : '',
    line: plainName(e.line ?? ''),
  };
  HAYSTACK.set(e, prepared);
  return prepared;
}

/**
 * Lo que mejor encaja con un texto: un número de servicio («08058», «8058»), una línea con su operador o su
 * ciudad («C4 Madrid», «27 EMT Málaga», «R2 Sants»), una hora («E4 13:10»)… Todas las palabras tienen que
 * encajar con algo de la entrada: su número, su línea, su hora o las palabras de su nombre (con el núcleo de una
 * línea de Cercanías), su operador y sus extremos. Un servicio sólo sale si encaja su número o su hora: buscando
 * una línea salen las líneas, no cada tren que va por ella.
 * @param {Map<string, Entry>|Entry[]} dir
 * @param {string} text
 * @returns {Entry[]}
 */
export function searchDirectory(dir, text, { limit = 8 } = {}) {
  // Las horas («13:10», «7.30h») quedan en una palabra («1310») antes de quitar los signos.
  const tokens = plainName(String(text ?? '').slice(0, 200).replace(/\b(\d{1,2})[:.h](\d{2})h?\b/g, '$1$2')).split(' ').filter(Boolean).slice(0, 6);
  if (!tokens.length) return [];
  const scored = [];
  // Cada palabra, una vez: si es un número (sin ceros a la izquierda) o una hora.
  const parts = tokens.map((t) => {
    const time = TIME_RE.exec(t);
    return { t, number: /^\d+$/.test(t) ? String(Number(t)) : null, time: time ? `${time[1].padStart(2, '0')}:${time[2]}` : null, prefix: ` ${t}`, whole: ` ${t} ` };
  });
  // Un servicio sólo sale por su número o su hora: sin palabras así, ni se miran.
  const canBeService = parts.some((p) => p.number || p.time);
  for (const e of dir.values()) {
    if (e.kind === 'servicio' && !canBeService) continue;
    let prepared = null; // el texto de la entrada, sólo si hace falta (un número se compara sin él)
    const line = () => (prepared ??= haystackOf(e)).line;
    const words = () => (prepared ??= haystackOf(e)).text;
    let score = 0;
    let ok = true;
    let identified = e.kind !== 'servicio';
    for (const { t, number, time, prefix, whole } of parts) {
      if (number && e.number !== null && number === e.number) {
        score += 100;
        identified = true;
      } else if (time && e.departure === time) {
        score += 30;
        identified = true;
      } else if (e.kind === 'servicio' && e.number !== null && number) {
        ok = false; // otro número: no es este servicio
        break;
      } else if (line() && t === line()) score += 50;
      else if (line() && t.length >= 2 && line().startsWith(t) && /\d/.test(t)) score += 20; // «C4» → C4a, C4b
      else if (words().includes(whole) || (t.length >= 3 && words().includes(prefix))) score += 5;
      else if (e.wide && placeWord((prepared ??= haystackOf(e)).places, whole, prefix, t)) continue; // ni suma ni quita
      else {
        ok = false;
        break;
      }
    }
    // Una de muchos recorridos, sólo si algo encaja con su nombre, su línea o su operador («Avant», «Avant Toledo»; no
    // «Toledo» sola).
    if (ok && identified && !(e.wide && score === 0)) scored.push({ e, score });
  }
  // A igualdad, las líneas antes que los servicios, y por el orden del registro de tipos (trenes, metros y
  // tranvías antes que autobuses): con «C1», las C1 de Cercanías no quedan detrás de veinte autobuses C1.
  return scored
    .sort((a, b) => b.score - a.score || (a.e.kind === b.e.kind ? 0 : a.e.kind === 'linea' ? -1 : 1)
      || modeRank(a.e.mode) - modeRank(b.e.mode)
      || a.e.name.localeCompare(b.e.name, 'es', { numeric: true }))
    .slice(0, limit)
    .map((s) => s.e);
}

const MODE_RANK = new Map(modeIds().map((id, i) => [id, i]));
const modeRank = (mode) => MODE_RANK.get(mode) ?? MODE_RANK.size;
