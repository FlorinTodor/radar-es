// Datos de las estaciones que no están en los ficheros de Renfe, de fuentes que se pueden reutilizar:
// - Wikidata (CC0), por el código de estación (P296, el mismo de Renfe y Adif): accesibilidad,
//   foto, año de apertura, número de vías y artículo de Wikipedia en español.
// - Wikimedia Commons: autor y licencia de cada foto, que se muestran junto a ella.
// - Renfe (CC BY 4.0): las fichas en PDF que enlazan sus listados de estaciones de Cercanías y FEVE.
// Cada fuente va por su lado: si una falla, las demás siguen y la estación se queda sin ese dato.
import { createHash } from 'node:crypto';

const WIKIDATA_QUERY = `SELECT ?code ?acc ?img ?open ?tracks ?wp WHERE {
  ?st wdt:P296 ?code; wdt:P17 wd:Q29; wdt:P31/wdt:P279* wd:Q55488.
  OPTIONAL { ?st wdt:P2846 ?acc } OPTIONAL { ?st wdt:P18 ?img } OPTIONAL { ?st wdt:P1619 ?open }
  OPTIONAL { ?st wdt:P1103 ?tracks } OPTIONAL { ?wp schema:about ?st; schema:isPartOf <https://es.wikipedia.org/> }
}`;
const WIKIDATA_URL = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(WIKIDATA_QUERY)}`;
const ACCESSIBILITY = { Q24192067: true, Q24192069: false, Q24192068: 'partial' }; // accesible, no accesible, en parte
const COMMONS_BATCH = 50;
const RENFE_LISTS = ['madrid', 'valencia', 'sevilla', 'malaga', 'zaragoza', 'murcia-alicante', 'san-sebastian', 'bilbao', 'asturias', 'cantabria', 'cadiz']
  .map((n) => `estaciones-cercanias-${n}`).concat(['estaciones-rodalies-barcelona', 'listado-estaciones-feve']);
const SHEET_URL = (code) => `https://data.renfe.com/files/estaciones/FichaEstacion${code}.pdf`;

const padCode = (c) => String(c ?? '').trim().padStart(5, '0');
const text = (bytes) => new TextDecoder().decode(bytes);

/**
 * @param {{ cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           log: import('../../../application/ports.js').LoggerPort, maxAgeMs: number }} deps
 * @returns {Promise<Map<string, object>>} código → datos extra (sólo los que haya)
 */
export async function loadStationExtras({ cache, log, maxAgeMs }) {
  const extras = new Map();
  const add = (code, data) => extras.set(code, { ...extras.get(code), ...data });
  try {
    const stations = parseWikidata(JSON.parse(text(await cache.bytes(WIKIDATA_URL, 'wikidata-estaciones.json', maxAgeMs))));
    const photos = await commonsPhotos(cache, [...new Set([...stations.values()].map((s) => s.image).filter(Boolean))], maxAgeMs, log);
    for (const [code, { image, ...rest }] of stations) add(code, { ...rest, ...(photos.has(image) ? { photo: photos.get(image) } : {}) });
  } catch (err) {
    log.warn(`[estaciones] Wikidata: ${err.message}`);
  }
  try {
    for (const code of await renfeSheets(cache, maxAgeMs, log)) add(code, { sheet: SHEET_URL(code) });
  } catch (err) {
    log.warn(`[estaciones] fichas de Renfe: ${err.message}`);
  }
  return extras;
}

/** Respuesta de Wikidata → código → { accessible, image, opened, tracks, wikipedia }. Vale el primer valor de cada uno. */
export function parseWikidata(json) {
  const out = new Map();
  for (const b of json.results?.bindings ?? []) {
    if (!/^\d{4,5}$/.test(b.code?.value ?? '')) continue;
    const code = padCode(b.code.value);
    const s = out.get(code) ?? {};
    const acc = ACCESSIBILITY[b.acc?.value.split('/').pop()];
    if (s.accessible === undefined && acc !== undefined) s.accessible = acc;
    if (!s.image && b.img) s.image = decodeURIComponent(b.img.value.split('/Special:FilePath/').pop() ?? '').replace(/_/g, ' ');
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
      + `&iiextmetadatafilter=Artist|LicenseShortName|LicenseUrl&titles=${encodeURIComponent(titles)}`;
    // El nombre depende de las fotos pedidas: si la lista cambia, no se reutiliza otra respuesta.
    const name = `commons-${createHash('sha1').update(titles).digest('hex').slice(0, 12)}.json`;
    try {
      for (const [file, photo] of parseCommons(JSON.parse(text(await cache.bytes(url, name, maxAgeMs))))) photos.set(file, photo);
    } catch (err) {
      log.warn(`[estaciones] Commons: ${err.message}`);
    }
  }
  return photos;
}

/** Respuesta de Commons → nombre del fichero → { url, page, author, license, licenseUrl }. Sin licencia, no hay foto. */
export function parseCommons(json) {
  const out = new Map();
  const renamed = new Map((json.query?.normalized ?? []).map((n) => [n.to, n.from]));
  for (const page of Object.values(json.query?.pages ?? {})) {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata ?? {};
    const license = plain(meta.LicenseShortName?.value);
    if (!info?.thumburl || !license) continue;
    const title = renamed.get(page.title) ?? page.title;
    out.set(title.replace(/^File:/, ''), {
      url: info.thumburl.split('?')[0], // sin los parámetros de seguimiento (utm_…) que añade Commons
      page: info.descriptionurl,
      author: plain(meta.Artist?.value).slice(0, 120) || 'Autor desconocido',
      license,
      licenseUrl: meta.LicenseUrl?.value?.startsWith('http') ? meta.LicenseUrl.value : null,
    });
  }
  return out;
}

/** HTML de Commons (enlaces al autor…) → texto. */
function plain(html) {
  return String(html ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
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
