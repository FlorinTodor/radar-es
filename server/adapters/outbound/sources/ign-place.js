// La localización que el IGN pone a sus terremotos, legible:
//   «NE GÓJAR.GR»            → «al noreste de Gójar (Granada)»
//   «GOLFO DE CÁDIZ»         → «Golfo de Cádiz»
//   «SW CABO DE SAN VICENTE» → «al suroeste del cabo de San Vicente»
// El sufijo es la provincia, la isla o el país (los del catálogo del IGN de un año, 4-nov-2026); uno que no
// esté aquí no se pone. El IGN corta el texto a 30 caracteres (29 si el corte cae en un espacio, que
// quita): entonces el sufijo puede venir cortado y pasar por otro («SALVATIERRA DE LOS BARROS.B», de
// Badajoz, no de Barcelona) y el nombre, a medias; en ese caso se deja sólo el nombre, sin lo que pueda
// estar cortado.

const CUT_AT = 29;
// Más allá de esto no es una localización del IGN (que la corta a 30 caracteres): no se lee entera.
const MAX_PLACE = 64;
// Artículos que se quedan colgando al final de un nombre cortado («VILLANUEVA DE LA SERENA DE LA»).
const TRAILING = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'I', 'D']);

const DIRECTION = {
  N: 'norte', NE: 'noreste', E: 'este', SE: 'sureste', S: 'sur', SW: 'suroeste', W: 'oeste', NW: 'noroeste',
};

const SUFFIX = {
  // Provincias y ciudades autónomas
  A: 'Alicante', AB: 'Albacete', AL: 'Almería', AV: 'Ávila', B: 'Barcelona', BA: 'Badajoz', BI: 'Bizkaia',
  BU: 'Burgos', C: 'A Coruña', CA: 'Cádiz', CC: 'Cáceres', CE: 'Ceuta', CO: 'Córdoba', CR: 'Ciudad Real',
  CS: 'Castellón', CU: 'Cuenca', GI: 'Girona', GR: 'Granada', GU: 'Guadalajara', H: 'Huelva', HU: 'Huesca',
  J: 'Jaén', L: 'Lleida', LE: 'León', LO: 'La Rioja', LU: 'Lugo', M: 'Madrid', MA: 'Málaga', ML: 'Melilla',
  MU: 'Murcia', NA: 'Navarra', O: 'Asturias', OU: 'Ourense', P: 'Palencia', PO: 'Pontevedra', S: 'Cantabria',
  SA: 'Salamanca', SE: 'Sevilla', SG: 'Segovia', SO: 'Soria', SS: 'Gipuzkoa', T: 'Tarragona', TE: 'Teruel',
  TO: 'Toledo', V: 'Valencia', VA: 'Valladolid', VI: 'Álava', Z: 'Zaragoza', ZA: 'Zamora',
  // Islas Canarias
  IFV: 'Fuerteventura', IGC: 'Gran Canaria', IHI: 'El Hierro', ILP: 'La Palma', ILZ: 'Lanzarote', ITF: 'Tenerife',
  // Países
  AND: 'Andorra', ARG: 'Argelia', FRA: 'Francia', MAC: 'Marruecos', POR: 'Portugal',
};

// Zonas que el IGN a veces da en inglés (la región de Flinn-Engdahl, cortada).
const AREA = { 'CANARY ISLANDS, SPAIN REG': 'Canarias', 'CANARY ISLANDS, SPAIN REGION': 'Canarias' };

const LOWER = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'i', 'les', 'do', 'da', 'dos', 'das', 'd', 'l']);
// Artículos que son parte del nombre aunque vayan detrás de «de».
const KEEP = [[/ de el Hierro\b/g, ' de El Hierro'], [/ de la Palma\b/g, ' de La Palma'], [/ de la Gomera\b/g, ' de La Gomera']];

/**
 * @param {unknown} raw  la «localización» del IGN
 * @returns {{ text: string, near: boolean } | null}  near: es una dirección desde un pueblo o un cabo, no una zona
 */
export function ignPlace(raw) {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_PLACE).trimEnd();
  if (!s) return null;
  const cut = s.length >= CUT_AT;
  const m = /^(?:(N|NE|E|SE|S|SW|W|NW) )?(.+)$/.exec(s);
  const dir = m[1];
  let name = m[2];
  let suffix = null;
  const dot = name.lastIndexOf('.');
  if (dot > 0 && /^[A-Z]*$/.test(name.slice(dot + 1))) {
    suffix = name.slice(dot + 1);
    name = name.slice(0, dot);
  }
  if (cut) {
    suffix = null;
    // Palabra a palabra: con /(?: (?:DE|…))+$/, un nombre con « DE» repetido era cuadrático.
    const words = name.split('/')[0].split(' ');
    while (words.length > 1 && TRAILING.has(words.at(-1))) words.pop();
    name = words.join(' ');
  }
  if (AREA[s]) return { text: AREA[s], near: false };
  const town = nice(name);
  const where = SUFFIX[suffix ?? ''];
  const inWhere = where && !town.endsWith(where) ? ` (${where})` : ''; // no «Granada (Granada)» ni «El Pinar de El Hierro (El Hierro)»
  if (!dir) return { text: `${town}${inWhere}`, near: false };
  const ref = /^Cabo /.test(town) ? `del cabo${town.slice(4)}` : `de ${town}`;
  return { text: `al ${DIRECTION[dir]} ${ref}${inWhere}`, near: true };
}

/** «CHURRIANA DE LA VEGA» → «Churriana de la Vega», «CALDES D ESTRAC» → «Caldes d'Estrac». */
function nice(upper) {
  const cap = (w) => w.replace(/^\p{L}/u, (c) => c.toLocaleUpperCase('es'));
  // «HUÉRCAL-OVERA» → «Huércal-Overa», «MONTEMOR-O-NOVO» → «Montemor-o-Novo», «ELCHE/ELX» → «Elche/Elx».
  const word = (w) => w.split('/').map((part) => part.split('-')
    .map((h, j) => (j > 0 && (LOWER.has(h) || h === 'a' || h === 'o') ? h : cap(h))).join('-')).join('/');
  let out = upper.toLocaleLowerCase('es')
    .split(' ')
    .map((w, i) => (i > 0 && LOWER.has(w) ? w : word(w)))
    .join(' ')
    // El IGN escribe sin apóstrofo: «D ESTRAC», «L HOSPITALET».
    .replace(/(^| )([dDlL]) (\p{L})/gu, (_, sp, a, c) => `${sp}${a}'${c.toLocaleUpperCase('es')}`);
  for (const [re, to] of KEEP) out = out.replace(re, to);
  return out;
}
