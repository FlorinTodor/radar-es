// Directorio de lo que se puede seguir: las claves `follow` (domain/seguir.js) de los vehículos y de las
// cancelaciones que el radar ha visto hace poco, con su nombre y las palabras por las que se buscan. Con él, el
// bot encuentra «08058», «C4 Madrid» o «27 EMT Málaga» sin saber de qué fuente ni de qué tipo de vehículo es
// cada cosa: un barco o un avión con sus claves saldrían igual. Puro: sin red, ni reloj, ni disco.
import { describeFollow, followKind, parseFollowKey } from '../seguir.js';
import { modeInfo } from '../modos.js';
import { plainName } from '../provincias.js';

// Lo que se recuerda de cada clave: si no se ve en día y medio, sale (el tren de mañana a la misma hora sigue).
export const DIRECTORY_KEEP_MS = 36 * 3600_000;
export const DIRECTORY_MAX = 50_000;
const MAX_PLACES = 6;
const MAX_TOWNS = 12;

/**
 * @typedef {object} Entry
 * @property {string} key
 * @property {'servicio'|'linea'} kind
 * @property {string} name        Cómo se llama («Avant 08058», «Tren C4b · Cercanías · Renfe»).
 * @property {string|null} mode
 * @property {string|null} operator
 * @property {string|null} line
 * @property {string|null} number  El de un servicio con número propio, sin ceros a la izquierda.
 * @property {string|null} departure  «HH:MM» de un servicio de un horario.
 * @property {string[]} places    Orígenes y destinos vistos (para distinguir dos líneas C1 y para buscar).
 * @property {string[]} towns     Localidades y estaciones por las que se ha visto pasar («Madrid»): para buscar
 *   «C4 Madrid» aunque ningún C4 empiece ni acabe en Madrid.
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
 *           label?: string|null, number?: string|null, origin?: string|null, destination?: string|null,
 *           area?: string|null, current?: string|null, next?: string|null }} x
 * @param {number} now
 * @returns {Entry[]}
 */
export function entriesOf(x, now) {
  if (!Array.isArray(x?.follow)) return [];
  const out = [];
  const places = [x.origin, x.destination].filter((p) => typeof p === 'string' && p);
  const towns = [x.area, x.current, x.next].filter((p) => typeof p === 'string' && p);
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
        towns,
        seen: now,
      });
    } else {
      const line = lineOf(key, x.line ?? null);
      // El producto de AV/LD/MD es a la vez su línea: «Tren AVE · Renfe», no «Tren AVE · AVE · Renfe».
      const service = x.service && plainName(x.service) !== plainName(line ?? '') ? x.service : undefined;
      out.push({
        key,
        kind,
        name: describeFollow(key, { operator: x.operator, service, line: line ?? undefined, modeLabel }),
        mode: x.mode ?? null,
        operator: x.operator ?? null,
        line,
        number: null,
        departure: null,
        places,
        towns,
        seen: now,
      });
    }
  }
  return out;
}

/**
 * Pone al día el directorio con lo que se ve ahora (vehículos y viajes de las cancelaciones y trenes sin datos)
 * y olvida lo que no se ve desde hace DIRECTORY_KEEP_MS. Cambia `dir` (es del caso de uso que lo guarda).
 * @param {Map<string, Entry>} dir
 * @param {{ vehicles?: object[], events?: object[], now: number, max?: number, keepMs?: number }} ctx
 */
export function updateDirectory(dir, { vehicles = [], events = [], now, max = DIRECTORY_MAX, keepMs = DIRECTORY_KEEP_MS }) {
  const add = (entry) => {
    const old = dir.get(entry.key);
    if (!old) {
      dir.set(entry.key, entry);
      return;
    }
    old.seen = now;
    old.name = entry.name;
    for (const p of entry.places) if (!old.places.includes(p) && old.places.length < MAX_PLACES) old.places.push(p);
    for (const t of entry.towns) if (!old.towns.includes(t) && old.towns.length < MAX_TOWNS) old.towns.push(t);
  };
  for (const v of vehicles) for (const e of entriesOf(v, now)) add(e);
  for (const ev of events) if (ev?.trip) for (const e of entriesOf({ ...ev.trip, follow: ev.trip.follow }, now)) add(e);
  for (const [key, e] of dir) if (now - e.seen > keepMs) dir.delete(key);
  if (dir.size > max) {
    const oldest = [...dir.values()].sort((a, b) => a.seen - b.seen).slice(0, dir.size - max);
    for (const e of oldest) dir.delete(e.key);
  }
  return dir;
}

/** Cómo se enseña una entrada en una lista: su nombre y, en una línea, dos de sus extremos para distinguirla. */
export function entryLabel(e) {
  if (e.kind !== 'linea' || !e.places.length) return e.name;
  return `${e.name} (${e.places.slice(0, 2).join(' – ')})`;
}

const TIME_RE = /^(\d{1,2})[:.h]?(\d{2})$/;

/**
 * Lo que mejor encaja con un texto: un número de servicio («08058», «8058»), una línea con su operador o su
 * ciudad («C4 Madrid», «27 EMT Málaga», «R2 Sants»), una hora («E4 13:10»)… Todas las palabras tienen que
 * encajar con algo de la entrada: su número, su línea, su hora o las palabras de su nombre, su operador, sus
 * extremos y por dónde pasa. Un servicio sólo sale si encaja su número o su hora: buscando una línea salen las
 * líneas, no cada tren que va por ella.
 * @param {Map<string, Entry>|Entry[]} dir
 * @param {string} text
 * @returns {Entry[]}
 */
export function searchDirectory(dir, text, { limit = 8 } = {}) {
  // Las horas («13:10», «7.30h») quedan en una palabra («1310») antes de quitar los signos.
  const tokens = plainName(String(text ?? '').slice(0, 200).replace(/\b(\d{1,2})[:.h](\d{2})h?\b/g, '$1$2')).split(' ').filter(Boolean).slice(0, 6);
  if (!tokens.length) return [];
  const scored = [];
  for (const e of dir.values()) {
    const words = new Set(plainName([e.name, e.operator, ...e.places, ...(e.towns ?? [])].join(' ')).split(' ').filter(Boolean));
    const line = plainName(e.line ?? '');
    let score = 0;
    let ok = true;
    let identified = e.kind !== 'servicio';
    for (const t of tokens) {
      const time = TIME_RE.exec(t);
      if (/^\d+$/.test(t) && e.number !== null && String(Number(t)) === e.number) {
        score += 100;
        identified = true;
      } else if (time && e.departure === `${time[1].padStart(2, '0')}:${time[2]}`) {
        score += 30;
        identified = true;
      } else if (line && t === line) score += 50;
      else if (line && t.length >= 2 && line.startsWith(t) && /\d/.test(t)) score += 20; // «C4» → C4a, C4b
      else if (words.has(t) || (t.length >= 3 && [...words].some((w) => w.startsWith(t)))) score += 5;
      else {
        ok = false;
        break;
      }
    }
    if (ok && identified) scored.push({ e, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (a.e.kind === b.e.kind ? 0 : a.e.kind === 'linea' ? -1 : 1)
      || a.e.name.localeCompare(b.e.name, 'es', { numeric: true }))
    .slice(0, limit)
    .map((s) => s.e);
}
