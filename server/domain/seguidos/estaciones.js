// Buscar una estación del catálogo del radar por su nombre, para el bot (el trayecto de «/trayecto Alcalá de
// Henares > Atocha»): las de Renfe y las de las redes de metro y tranvía (/api/stations). Si el nombre es el de
// una estación tal cual, sólo esa (o las que se llaman igual); si no, todas las que tienen esas palabras, para
// elegir de una lista. Puro: sin red, ni reloj, ni disco.
import { plainName } from '../provincias.js';

/** Palabras que se miran, como mucho: más no es el nombre de una estación. */
const TOKENS_MAX = 8;

/**
 * @typedef {{ code: string, name: string, place?: string|null, network?: string, networkId?: string, lat?: number, lon?: number }} CatalogStation
 */

// Cada lista, preparada una vez (sus nombres sin tildes ni signos): el catálogo son unas 2.400 estaciones y la
// lista sólo cambia al volver a leerlo.
const PREPARED = new WeakMap();
function prepared(list) {
  let out = PREPARED.get(list);
  if (!out) {
    out = list.filter((st) => st && typeof st.code === 'string' && typeof st.name === 'string').map((st) => {
      const name = plainName(st.name);
      return { st, name, words: ` ${name} ${plainName(st.place ?? '')} ${plainName(st.network ?? '')} ` };
    });
    PREPARED.set(list, out);
  }
  return out;
}

/** ¿Es de la red de Renfe (el catálogo de Adif y Renfe) y no de una de metro o tranvía? */
const isRenfe = (st) => !st.networkId;

/**
 * Las estaciones que encajan con un texto. Si alguna se llama tal cual («Alcalá de Henares», sin tildes ni
 * mayúsculas), sólo ésas; si no, las que tienen todas sus palabras al principio de una palabra de su nombre, de su
 * ciudad o de su red («Atocha» → «Madrid-Atocha Cercanías» y «Madrid-Puerta de Atocha-Almudena Grandes»; «Sants
 * metro» → las de Metro de Barcelona). Primero las que tienen todo en su nombre y empiezan por el texto; a igual
 * encaje, las de Renfe y por orden alfabético.
 * @param {CatalogStation[]} list  @param {string} text
 * @returns {CatalogStation[]}
 */
export function searchStations(list, text, { limit = Infinity } = {}) {
  const { exact, partial } = stationCandidates(list, text, { limit });
  return exact.length ? exact : partial;
}

/**
 * Las estaciones que encajan con un texto, por separado: las que se llaman tal cual y las que tienen sus palabras
 * (searchStations da las primeras si hay, si no las segundas). Para un trayecto hacen falta las dos: «Aeroport» es
 * el nombre de una de Metrovalencia, pero con «Sants» se quiere decir una de Barcelona.
 * @param {CatalogStation[]} list  @param {string} text
 * @returns {{ exact: CatalogStation[], partial: CatalogStation[] }}  cada una, como mucho `limit`, en el orden de searchStations
 */
export function stationCandidates(list, text, { limit = Infinity } = {}) {
  const q = plainName(String(text ?? '').slice(0, 200));
  const tokens = q.split(' ').filter(Boolean).slice(0, TOKENS_MAX);
  if (!tokens.length || !Array.isArray(list)) return { exact: [], partial: [] };
  const exact = [];
  const scored = [];
  for (const p of prepared(list)) {
    if (p.name === q) {
      exact.push({ p, score: 0 });
      continue;
    }
    if (!tokens.every((t) => p.words.includes(` ${t}`))) continue;
    const inName = tokens.every((t) => ` ${p.name}`.includes(` ${t}`));
    scored.push({ p, score: (inName ? 2 : 0) + (p.name.startsWith(q) ? 1 : 0) });
  }
  const sorted = (found) => found
    .sort((a, b) => b.score - a.score || Number(isRenfe(b.p.st)) - Number(isRenfe(a.p.st)) || a.p.st.name.localeCompare(b.p.st.name, 'es'))
    .slice(0, limit)
    .map(({ p }) => p.st);
  return { exact: sorted(exact), partial: sorted(scored) };
}

/**
 * Cómo se enseña una estación en una lista: su nombre, su ciudad si no está ya en él y su red si no es de Renfe
 * («Sants Estació · Metro de Barcelona (TMB)»).
 * @param {CatalogStation} st
 */
export function stationLabel(st) {
  const place = st.place && !plainName(st.name).includes(plainName(st.place)) ? ` (${st.place})` : '';
  return `${st.name}${place}${st.network ? ` · ${st.network}` : ''}`;
}

/** ¿Son de la misma red? (un tren de Renfe no para en una estación de metro, ni el metro de una ciudad en el de otra) */
export const sameNetwork = (a, b) => (a?.networkId ?? null) === (b?.networkId ?? null);
