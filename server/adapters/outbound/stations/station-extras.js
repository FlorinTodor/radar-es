// Datos de las estaciones que no están en los ficheros de Renfe, de fuentes que se pueden reutilizar:
// - Wikidata (CC0), por el código de estación (P296, el mismo de Renfe y Adif): accesibilidad,
//   foto, año de apertura, número de vías y artículo de Wikipedia en español.
// - Wikimedia Commons: autor y licencia de cada foto, que se muestran junto a ella. Si Wikidata no
//   tiene foto de la estación, se busca, por este orden, en su categoría de Commons, en la imagen
//   libre principal de su artículo de Wikipedia y entre las fotos de Commons hechas a menos de 200 m
//   (ver findMorePhotos). Todas pasan por parseCommons: sin licencia, no hay foto.
// - Renfe (CC BY 4.0): las fichas en PDF que enlazan sus listados de estaciones de Cercanías y FEVE.
// Cada fuente va por su lado: si una falla, las demás siguen y la estación se queda sin ese dato.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Fotos retiradas a mano (fotos-retiradas.json): personas protagonistas y las que pidan retirar su
// autor o quien sale en ellas. Su huella va en la versión del catálogo, que se recalcula al cambiar.
const RETIRED_JSON = readFileSync(new URL('./fotos-retiradas.json', import.meta.url), 'utf8');
const RETIRED = new Set(JSON.parse(RETIRED_JSON).fotos.map((p) => commonsName(p.fichero)));
export const RETIRED_PHOTOS_VERSION = createHash('sha1').update(RETIRED_JSON).digest('hex').slice(0, 8);

/** Nombre de fichero de Commons comparable: sin «File:», con espacios y la primera letra en mayúscula. */
function commonsName(name) {
  const n = String(name).replace(/^File:/, '').replace(/_/g, ' ').trim();
  return n.charAt(0).toUpperCase() + n.slice(1);
}

/** Quita de un mapa fichero → foto las que están retiradas. */
export function withoutRetired(photos, retired = RETIRED) {
  for (const file of [...photos.keys()]) if (retired.has(commonsName(file))) photos.delete(file);
  return photos;
}

const WIKIDATA_QUERY = `SELECT ?code ?acc ?img ?cat ?open ?tracks ?wp WHERE {
  ?st wdt:P296 ?code; wdt:P17 wd:Q29; wdt:P31/wdt:P279* wd:Q55488.
  OPTIONAL { ?st wdt:P2846 ?acc } OPTIONAL { ?st wdt:P18 ?img } OPTIONAL { ?st wdt:P373 ?cat } OPTIONAL { ?st wdt:P1619 ?open }
  OPTIONAL { ?st wdt:P1103 ?tracks } OPTIONAL { ?wp schema:about ?st; schema:isPartOf <https://es.wikipedia.org/> }
}`;
const WIKIDATA_URL = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(WIKIDATA_QUERY)}`;
const ACCESSIBILITY = { Q24192067: true, Q24192069: false, Q24192068: 'partial' }; // accesible, no accesible, en parte
const COMMONS_BATCH = 50;
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php?format=json&';
const WIKIPEDIA_API = 'https://es.wikipedia.org/w/api.php?format=json&';
// Las búsquedas de fotos cambian poco: se guardan un mes. La de cercanía va estación a estación, con
// un tope de tiempo por carga para no retrasar el catálogo; las que no dé tiempo, en la siguiente.
const SEARCH_MAX_AGE_MS = 30 * 24 * 3600_000;
const NEARBY_RADIUS_M = 200;
const NEARBY_BUDGET_MS = 90_000;
const NEARBY_CONCURRENCY = 2;
// Nombres de los conjuntos en data.renfe.com (el de Cantabria es «santander»).
const RENFE_LISTS = ['madrid', 'valencia', 'sevilla', 'malaga', 'zaragoza', 'murcia-alicante', 'san-sebastian', 'bilbao', 'asturias', 'santander', 'cadiz']
  .map((n) => `estaciones-cercanias-${n}`).concat(['estaciones-rodalies-barcelona', 'listado-estaciones-feve']);
const SHEET_URL = (code) => `https://data.renfe.com/files/estaciones/FichaEstacion${code}.pdf`;

const padCode = (c) => String(c ?? '').trim().padStart(5, '0');
const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * @param {{ cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           log: import('../../../application/ports.js').LoggerPort, maxAgeMs: number,
 *           stations?: Array<{ code: string, name: string, lat: number, lon: number }>,
 *           nearbyBudgetMs?: number }} deps
 *   stations: las del catálogo, para buscar foto a las que Wikidata no da ninguna.
 * @returns {Promise<Map<string, object>>} código → datos extra (sólo los que haya)
 */
export async function loadStationExtras({ cache, log, maxAgeMs, stations = [], nearbyBudgetMs = NEARBY_BUDGET_MS }) {
  const extras = new Map();
  const add = (code, data) => extras.set(code, { ...extras.get(code), ...data });
  let wikidata = new Map();
  const names = new Map(stations.map((st) => [st.code, st.name]));
  const taken = new Map(); // fichero → nombres de las estaciones a las que Wikidata se lo da
  try {
    wikidata = parseWikidata(JSON.parse(text(await cache.bytes(WIKIDATA_URL, 'wikidata-estaciones-v2.json', maxAgeMs))));
    // Todas las fotos que Wikidata da a cada estación; vale la primera cuya licencia se puede cumplir.
    const photos = withoutRetired(await commonsPhotos(cache, [...new Set([...wikidata.values()].flatMap((s) => s.images ?? []))], maxAgeMs, log));
    for (const [code, { images = [], category, ...rest }] of wikidata) {
      const file = images.find((f) => photos.has(f));
      add(code, { ...rest, ...(file ? { photo: photos.get(file) } : {}) });
      if (file && names.has(code)) taken.set(file, [...(taken.get(file) ?? []), names.get(code)]);
    }
  } catch (err) {
    log.warn(`[estaciones] Wikidata: ${err.message}`);
  }
  try {
    const missing = stations.filter((s) => !extras.get(s.code)?.photo)
      .map((s) => ({ ...s, category: wikidata.get(s.code)?.category, wikipedia: wikidata.get(s.code)?.wikipedia }));
    const candidates = await findMorePhotos({ cache, log, missing, budgetMs: nearbyBudgetMs });
    const photos = withoutRetired(await commonsPhotos(cache, [...new Set([...candidates.values()].flat().map((c) => c.file))], SEARCH_MAX_AGE_MS, log));
    for (const [code, file] of choosePhotos(candidates, photos, names, taken)) add(code, { photo: photos.get(file) });
  } catch (err) {
    log.warn(`[estaciones] más fotos: ${err.message}`);
  }
  try {
    for (const code of await renfeSheets(cache, maxAgeMs, log)) add(code, { sheet: SHEET_URL(code) });
  } catch (err) {
    log.warn(`[estaciones] fichas de Renfe: ${err.message}`);
  }
  return extras;
}

/** Respuesta de Wikidata → código → { accessible, images, category, opened, tracks, wikipedia }. Vale el primer valor de cada uno, salvo las fotos: todas. */
export function parseWikidata(json) {
  const out = new Map();
  for (const b of json.results?.bindings ?? []) {
    if (!/^\d{4,5}$/.test(b.code?.value ?? '')) continue;
    const code = padCode(b.code.value);
    const s = out.get(code) ?? {};
    const acc = ACCESSIBILITY[b.acc?.value.split('/').pop()];
    if (s.accessible === undefined && acc !== undefined) s.accessible = acc;
    const image = b.img ? decodeURIComponent(b.img.value.split('/Special:FilePath/').pop() ?? '').replace(/_/g, ' ') : null;
    if (image && !s.images?.includes(image)) s.images = [...(s.images ?? []), image];
    if (!s.category && b.cat?.value) s.category = b.cat.value;
    const year = Number(b.open?.value.slice(0, 4));
    if (!s.opened && year > 1800) s.opened = year;
    const tracks = Number(b.tracks?.value);
    if (!s.tracks && Number.isInteger(tracks) && tracks > 0 && tracks < 100) s.tracks = tracks;
    if (!s.wikipedia && b.wp?.value.startsWith('https://es.wikipedia.org/')) s.wikipedia = b.wp.value;
    out.set(code, s);
  }
  return out;
}

/** Foto en tamaño ficha, su página en Commons, autor y licencia, de 50 en 50. */
async function commonsPhotos(cache, files, maxAgeMs, log) {
  const photos = new Map();
  for (let i = 0; i < files.length; i += COMMONS_BATCH) {
    const titles = files.slice(i, i + COMMONS_BATCH).map((f) => `File:${f}`).join('|');
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640'
      + `&iiextmetadatafilter=Artist|Attribution|LicenseShortName|LicenseUrl|Restrictions&titles=${encodeURIComponent(titles)}`;
    // El nombre depende de las fotos pedidas: si la lista cambia, no se reutiliza otra respuesta.
    // «v3»: con Attribution y Restrictions (las respuestas guardadas antes no los tienen).
    const name = `commons-v3-${createHash('sha1').update(titles).digest('hex').slice(0, 12)}.json`;
    try {
      for (const [file, photo] of parseCommons(await apiJson(cache, url, name, maxAgeMs))) photos.set(file, photo);
    } catch (err) {
      log.warn(`[estaciones] Commons: ${err.message}`);
    }
  }
  return photos;
}

/** JSON de una API de Wikimedia, cacheado; un error (que llega con un 200) no se guarda. */
async function apiJson(cache, url, name, maxAgeMs) {
  const validate = (bytes) => {
    const json = JSON.parse(text(bytes));
    if (json.error) throw new Error(json.error.info ?? json.error.code ?? 'error de la API');
  };
  return JSON.parse(text(await cache.bytes(url, name, maxAgeMs, { validate })));
}

const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * Fotos candidatas de Commons para las estaciones sin foto en Wikidata, por este orden:
 * 1. las de su categoría de Commons (P373) con algo de tren en el nombre, primero las que llevan
 *    también el de la estación (en «Plaça de Catalunya station» está la foto de una tienda);
 * 2. la imagen libre principal de su artículo de Wikipedia (pilicense=free), si lleva su nombre;
 * 3. las fotos de Commons hechas a menos de 200 m que llevan su nombre y algo de tren en el título
 *    («Apeadero Valdecilla.jpg» sí; «Viaje en tren Alicante-Murcia 34.jpg» junto a Callosa, no).
 * Después se usa la primera cuya licencia se puede cumplir (choosePhotos).
 * @returns {Promise<Map<string, Array<{ file: string, dist: number }>>>} código → candidatas; dist: metros
 *   a la estación en las de cercanía, 0 en las que Commons o Wikipedia asocian a la estación.
 */
async function findMorePhotos({ cache, log, missing, budgetMs }) {
  const found = new Map();
  const push = (code, list) => { if (list.length) found.set(code, [...(found.get(code) ?? []), ...list]); };
  const searchable = missing.filter((s) => nameKey(s.name));

  for (const s of searchable.filter((x) => x.category)) {
    const url = `${COMMONS_API}action=query&list=categorymembers&cmtype=file&cmlimit=50&cmtitle=${encodeURIComponent(`Category:${s.category}`)}`;
    try {
      push(s.code, categoryCandidates(await apiJson(cache, url, `commons-cat-${sha(s.category)}.json`, SEARCH_MAX_AGE_MS), s.name)
        .map((file) => ({ file, dist: 0 })));
    } catch (err) {
      log.warn(`[estaciones] categoría ${s.category}: ${err.message}`);
    }
  }

  const byTitle = new Map();
  for (const s of searchable.filter((x) => x.wikipedia)) byTitle.set(decodeURIComponent(s.wikipedia.split('/wiki/').pop()).replace(/_/g, ' '), s);
  const titles = [...byTitle.keys()];
  for (let i = 0; i < titles.length; i += COMMONS_BATCH) {
    const batch = titles.slice(i, i + COMMONS_BATCH).join('|');
    const url = `${WIKIPEDIA_API}action=query&prop=pageimages&piprop=name&pilicense=free&redirects=1&titles=${encodeURIComponent(batch)}`;
    try {
      for (const [title, file] of pageImages(await apiJson(cache, url, `wikipedia-imagen-${sha(batch)}.json`, SEARCH_MAX_AGE_MS))) {
        const s = byTitle.get(title);
        if (s && matchesStation(file, s.name)) push(s.code, [{ file, dist: 0 }]);
      }
    } catch (err) {
      log.warn(`[estaciones] imágenes de Wikipedia: ${err.message}`);
    }
  }

  const queue = searchable.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const deadline = Date.now() + budgetMs;
  let skipped = 0;
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      if (Date.now() > deadline) { skipped++; continue; }
      const url = `${COMMONS_API}action=query&list=geosearch&gsnamespace=6&gslimit=50&gsradius=${NEARBY_RADIUS_M}&gscoord=${s.lat}|${s.lon}`;
      try {
        push(s.code, nearbyCandidates(await apiJson(cache, url, `commons-cerca-${s.code}.json`, SEARCH_MAX_AGE_MS), s.name));
      } catch { /* Commons «demasiado ocupado»: se reintenta en la siguiente carga */ }
    }
  };
  await Promise.all(Array.from({ length: NEARBY_CONCURRENCY }, worker));
  if (skipped) log.warn(`[estaciones] fotos cercanas: ${skipped} estaciones para la siguiente carga`);
  return found;
}

/**
 * Para cada estación, la primera candidata con licencia que se puede cumplir y que Wikidata no da a
 * otra estación con otro nombre («Apeadero Valdecilla.jpg» es de Valdecilla, no de Valdecilla la
 * Marga, a 130 m). Si la misma foto de cercanía sale para estaciones con nombre distinto, se queda
 * sólo en la más cercana a donde se hizo: no se sabe si es de la otra. Con el mismo nombre (una
 * estación con dos códigos) vale para las dos.
 * @param {Map<string, string[]>} [taken] fichero → nombres de las estaciones a las que Wikidata se lo da
 * @returns {Map<string, string>} código → fichero
 */
export function choosePhotos(candidates, photos, names, taken = new Map()) {
  const otherOwner = (file, name) => (taken.get(file) ?? []).some((n) => fold(n) !== fold(name));
  const chosen = new Map();
  for (const [code, list] of candidates) {
    const hit = list.find((c) => photos.has(c.file) && !otherOwner(c.file, names.get(code)));
    if (hit) chosen.set(code, hit);
  }
  const byFile = new Map();
  for (const [code, c] of chosen) byFile.set(c.file, [...(byFile.get(c.file) ?? []), { code, ...c }]);
  for (const users of byFile.values()) {
    if (new Set(users.map((u) => fold(names.get(u.code)))).size < 2) continue;
    const best = Math.min(...users.map((u) => u.dist));
    for (const u of users) if (u.dist > best) chosen.delete(u.code);
  }
  return new Map([...chosen].map(([code, c]) => [code, c.file]));
}

const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'els', 'les', 'y', 'i', 'en', 'san', 'santa', 'sant',
  'estacion', 'estacio', 'apeadero', 'station', 'geltokia', 'cercanias', 'rodalies', 'alta', 'velocidad']);
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/_/g, ' ');
const IMAGE = /\.(jpe?g|png|webp)$/i;
// Ni mapas ni escudos, ni puentes, ni calles: «Paseo de la Estación en 1997» junto a Callosa no es la estación.
const NOT_A_PHOTO = /\b(mapa?|plano|esquema|logo|escudo|bandera|horario|diagram|puente|pont|bridge|paseo|calle|avenida|avda|carrer|rua|kalea|plaza|placa)\b/;
const RAILWAY = /estaci|apeader|station|geltoki|\btren|train|renfe|feve|adif|cercanias|rodalies|ferrocarril|railway|anden|\bvias?\b/;

// Ciudades que encabezan el nombre de muchas estaciones («Barcelona Plaça de Catalunya»): no sirven
// para reconocer la estación si el nombre tiene otra palabra.
const CITIES = new Set(['madrid', 'barcelona', 'valencia', 'sevilla', 'bilbao', 'malaga', 'zaragoza', 'murcia', 'alicante',
  'cordoba', 'granada', 'valladolid', 'oviedo', 'gijon', 'santander', 'cadiz', 'vigo', 'coruna', 'pamplona', 'vitoria',
  'gasteiz', 'donostia', 'tarragona', 'girona', 'lleida', 'castello', 'castellon', 'huelva', 'almeria', 'leon', 'burgos',
  'salamanca', 'palencia', 'badajoz', 'toledo', 'logrono', 'ourense', 'lugo', 'pontevedra', 'irun']);

/**
 * La palabra más larga y propia del nombre de la estación: «Madrid-Nuevos Ministerios» →
 * «ministerios», «Barcelona Plaça de Catalunya» → «catalunya». A igual longitud, la última.
 */
export function nameKey(name) {
  const words = fold(name).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const own = words.filter((w) => !CITIES.has(w));
  return (own.length ? own : words).reduce((best, w) => (w.length >= best.length ? w : best), '') || null;
}

/** ¿Es una foto y no un mapa, un escudo o un puente? Sin contar las palabras del nombre (Puente Genil, El Pont de Vilomara). */
function isPhoto(file, stationName) {
  const own = new Set(fold(stationName).split(/[^a-z0-9]+/));
  return IMAGE.test(file) && !NOT_A_PHOTO.test(fold(file).split(/[^a-z0-9]+/).filter((w) => !own.has(w)).join(' '));
}

/** ¿Es una foto cuyo nombre lleva el de la estación (y, si se pide, algo de tren)? */
export function matchesStation(file, stationName, { railway = false } = {}) {
  const key = nameKey(stationName);
  const t = fold(file);
  return Boolean(key) && isPhoto(file, stationName) && t.includes(key) && (!railway || RAILWAY.test(t));
}

/** Respuesta de categorymembers → fotos con algo de tren en el nombre, primero las que llevan el de la estación. */
export function categoryCandidates(json, stationName) {
  const files = (json.query?.categorymembers ?? []).map((m) => m.title.replace(/^File:/, ''))
    .filter((f) => isPhoto(f, stationName) && RAILWAY.test(fold(f)));
  return [...files.filter((f) => matchesStation(f, stationName)), ...files.filter((f) => !matchesStation(f, stationName))];
}

/** Respuesta de pageimages → título del artículo pedido → fichero de su imagen libre principal. */
export function pageImages(json) {
  const back = new Map();
  for (const n of [...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])]) back.set(n.to, back.get(n.from) ?? n.from);
  const out = new Map();
  for (const p of Object.values(json.query?.pages ?? {})) if (p.pageimage) out.set(back.get(p.title) ?? p.title, p.pageimage.replace(/_/g, ' '));
  return out;
}

/** Respuesta de geosearch → fotos con el nombre de la estación y algo de tren en el título, de la más cercana a la más lejana. */
export function nearbyCandidates(json, stationName) {
  return (json.query?.geosearch ?? [])
    .filter((g) => matchesStation(g.title.replace(/^File:/, ''), stationName, { railway: true }))
    .sort((a, b) => a.dist - b.dist)
    .map((g) => ({ file: g.title.replace(/^File:/, ''), dist: g.dist }));
}

// Licencias que no piden citar al autor. Con cualquier otra, sin autor no se puede cumplir la
// licencia y la foto no se usa.
const NO_ATTRIBUTION = /^(cc0|public domain|pdm|dominio público)/i;
// La GFDL pide acompañar la obra del texto entero de la licencia, que no cabe en una ficha: sólo se
// usan las fotos que, además de la GFDL, tienen otra licencia (Commons da entonces la otra).
const UNUSABLE = /^gfdl/i;

/**
 * Respuesta de Commons → nombre del fichero → { url, page, author, license, licenseUrl }.
 * Sin licencia, o con una que no se puede cumplir en la ficha, no hay foto.
 */
export function parseCommons(json) {
  const out = new Map();
  const renamed = new Map((json.query?.normalized ?? []).map((n) => [n.to, n.from]));
  for (const page of Object.values(json.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const license = plain(meta.LicenseShortName?.value);
    if (!info?.thumburl || !license || UNUSABLE.test(license)) continue;
    // Personas reconocibles ({{Personality rights}}): su imagen tiene sus propios derechos.
    if (/personality/i.test(meta.Restrictions?.value ?? '')) continue;
    const author = commonsAuthor(meta);
    if (!author && !NO_ATTRIBUTION.test(license)) continue;
    const title = renamed.get(page.title) ?? page.title;
    out.set(title.replace(/^File:/, ''), {
      url: info.thumburl.split('?')[0], // sin los parámetros de seguimiento (utm_…) que añade Commons
      page: info.descriptionurl,
      author: author || 'Autor desconocido',
      license,
      licenseUrl: meta.LicenseUrl?.value?.startsWith('http') ? meta.LicenseUrl.value : null,
    });
  }
  return out;
}

/**
 * A quién citar. Si el autor ha dicho cómo quiere que se le cite (campo Attribution: «Pere López»
 * en vez de su usuario «pere prlpz»), eso, que es lo que piden las CC BY y BY-SA. Si no, el campo
 * Artist; cuando trae más cosas que el nombre (una tabla, un correo, un aviso), el nombre de su
 * enlace a la página de usuario.
 */
export function commonsAuthor(meta) {
  // «I, Mdiagom» es el «yo, …» de la plantilla {{self}}; un enlace solo no dice el nombre.
  const requested = plain(meta.Attribution?.value).replace(/^I, /, '');
  if (requested && requested.length <= 80 && !/^https?:\/\/\S+$/.test(requested)) return requested;
  const html = String(meta.Artist?.value ?? '');
  const clean = (t) => t.replace(/^No machine-readable author provided\. (.+?) assumed.*$/, '$1');
  const text = clean(plain(html));
  if (text.length <= 80) return text;
  // Más largo: su primera línea («Luis Miguel Bugallo Sánchez» y luego enlaces) o el usuario de Commons.
  const first = clean(html.split(/\n|<\/p>|<br\s*\/?>|<\/dd>|<\/td>/i).map(plain).find(Boolean) ?? '');
  if (first.length <= 80 && !/^\[?https?:/.test(first)) return first;
  const user = html.match(/\/wiki\/User:([^"#?]+)"/);
  return user ? decodeURIComponent(user[1]).replace(/_/g, ' ') : `${text.slice(0, 77)}…`;
}

/** HTML de Commons (enlaces al autor…) → texto. */
function plain(html) {
  return String(html ?? '').replace(/<[^>]*>/g, '').replace(/[\u200b-\u200f\ufeff]/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

/** Códigos de las estaciones con ficha en PDF, de los listados de Renfe que la enlazan. */
async function renfeSheets(cache, maxAgeMs, log) {
  const codes = new Set();
  for (const dataset of RENFE_LISTS) {
    try {
      const meta = JSON.parse(text(await cache.bytes(`https://data.renfe.com/api/3/action/package_show?id=${dataset}`, `renfe-${dataset}.json`, maxAgeMs)));
      const csv = meta.result?.resources?.find((r) => /csv/i.test(`${r.format} ${r.url}`))?.url;
      if (!csv) continue;
      for (const code of sheetCodes(text(await cache.bytes(csv, `renfe-${dataset}.csv`, maxAgeMs)))) codes.add(code);
    } catch (err) {
      log.warn(`[estaciones] ${dataset}: ${err.message}`);
    }
  }
  return codes;
}

export const sheetCodes = (csv) => new Set([...csv.matchAll(/FichaEstacion(\d{5})\.pdf/g)].map((m) => m[1]));
