// Avisos oficiales de emergencias de las comunidades autónomas: planes de protección civil
// activados (prealerta, alerta, emergencia) y cortes de luz que publican los 112. Cada fuente sólo
// descarga y lee su formato y sitúa los lugares que cita; qué es un corte de luz, de qué riesgo trata
// un aviso, cuánto dura sin noticias de su fin y cuáles siguen en vigor lo decide el dominio
// (currentNotices y maxAgeOf, en domain/emergencias.js), igual para todas. Cataluña es la excepción:
// su conjunto sólo trae los planes activos. Los textos se muestran tal cual los publica cada
// administración; lo que añade Radar España es el formato y la ubicación aproximada.
//
// Licencias (revisadas el 2-11-2026 en su texto original; enlaces y atribuciones en /legal). Todas
// permiten reutilizar citando la fuente y sin desnaturalizar el sentido; robots.txt permite estas rutas.
// - Gobierno de Canarias: feed catalogado en datos.gob.es con CC BY 4.0; «Fuente: Gobierno de Canarias».
// - Cataluña: Llicència oberta d'ús d'informació; citar el departamento y la fecha de actualización.
// - Junta de Andalucía: conjunto «Noticias de la Junta de Andalucía», CC BY 4.0; «Información obtenida
//   del Portal de la Junta de Andalucía», sin logotipos (no se usan las fotos).
// - Castilla-La Mancha: aviso legal (Ley 37/2007): citar la fuente y la fecha de publicación.
// - La Rioja: «Se autoriza la reproducción siempre que se haga referencia a la fuente»; sin incrustar su web.
// - Castilla y León: «Origen de los datos: Junta de Castilla y León» y la fecha de actualización.
// - Govern de les Illes Balears: conjunto «Actualidad Informativa - Comunicaciones» del catálogo de datos
//   abiertos (CC BY): «Font de les dades: Govern de les Illes Balears», sin alterar, con la fecha. Su
//   robots.txt prohíbe la ruta del RSS, en contra de su propio catálogo: se usa la URL exacta que publica
//   el catálogo de datos.gob.es (la sala de prensa en catalán, lang=ca), cada 15 minutos y avisándoles
//   (decisión del titular de Radar España, 2-11-2026).
// - Comunidad de Madrid (aviso legal del portal): reutilización sin alterar ni desnaturalizar, citando
//   la fuente y la fecha de extracción y sin dar a entender que la Comunidad patrocina el uso. Su
//   robots.txt pide 10 s entre peticiones (aquí, una cada 15 minutos).
// - Región de Murcia: conjunto de datos abiertos (aviso legal del portal): «Origen de los datos» y la
//   fecha de la última actualización, sin desnaturalizar ni sugerir patrocinio.
// - Cantabria: CC BY 3.0 ES (pie de www.cantabria.es), sin logotipos.
// - Xunta de Galicia (aviso legal del portal): reutilización citando la fuente y sin desnaturalizar;
//   sin logotipos (no se usan las fotos). Distinto del de la AXEGA (el 112), que no se usa.
// - País Vasco: noticias de Irekia, conjunto de Open Data Euskadi con CC BY 4.0: citar la fuente y la
//   fecha de la última actualización, sin alterar ni desnaturalizar.
//
// Cada descarga lleva su tope (maxBytes): los feeds pesan de unos cientos de bytes a 800 KB y se leen
// en el hilo principal.
import {
  NOTICE_MAX_AGE, currentNotices, expiresAt, fold, illesIn, isEndNotice, isPlanNotice, isPressPlanNotice, islandsIn, mentionsPlan, mentionsPowerBack,
  mentionsPowerCut, placeCandidates, powerClauses, provincesIn, severityOf, subjectsOf,
} from '../../../domain/emergencias.js';
import { COMUNIDADES, ILLES_BALEARS, ISLAS_CANARIAS, PROVINCIAS } from '../../../domain/lugares.js';
import { arr, htmlText, madridLocalToMs, text, xmlParser } from './parse.js';

// Atribución que pide cada licencia, junto a sus datos (ficha, lista de incidencias y alertas).
export const CREDITS = {
  'emergencias-canarias': 'Fuente: Gobierno de Canarias',
  'emergencias-cataluna': "Generalitat de Catalunya. Departament d'Interior i Seguretat Pública. Direcció General de Protecció Civil",
  'emergencias-andalucia': 'Información obtenida del Portal de la Junta de Andalucía',
  'emergencias-castilla-la-mancha': 'Fuente: Junta de Comunidades de Castilla-La Mancha (112 Castilla-La Mancha)',
  'emergencias-la-rioja': 'Fuente: Gobierno de La Rioja (SOS Rioja 112)',
  'emergencias-castilla-y-leon': 'Origen de los datos: Junta de Castilla y León',
  'emergencias-illes-balears': 'Font de les dades: Govern de les Illes Balears',
  'emergencias-madrid': 'Fuente: Comunidad de Madrid',
  'emergencias-murcia': 'Origen de los datos: Comunidad Autónoma de la Región de Murcia (CARM)',
  'emergencias-cantabria': 'Fuente: Gobierno de Cantabria',
  'emergencias-galicia': 'Fuente: Xunta de Galicia',
  'emergencias-pais-vasco': 'Irekia (Gobierno Vasco) · Open Data Euskadi (CC BY 4.0)',
};

// Códigos de comunidad del INE, los que usa CartoCiudad (sólo las fuentes que geocodifican).
const REGION = { andalucia: '01', cantabria: '06', 'castilla-y-leon': '07', galicia: '12', madrid: '13', murcia: '14', 'pais-vasco': '16', 'la-rioja': '17' };
// Topes de descarga, muy por encima de lo que pesa hoy cada feed (como mucho, unos 150 KB).
const FEED_MAX_BYTES = 2 * 1024 * 1024;
const SMALL_MAX_BYTES = 1024 * 1024;

/**
 * @typedef {import('../../../domain/emergencias.js').Notice & {
 *   title: string, description: string, url: string|null, power: boolean, severity: import('../../../domain/model.js').Severity,
 *   candidates?: string[], province?: string|null }} OfficialNotice
 *   candidates: lugares que cita un aviso del 112 y que aún hay que situar con el geocodificador.
 * @typedef {{ name: string, lat: number, lon: number, approx: 'isla'|'municipio'|'provincia'|'comunidad' }} Where
 */

const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
/** El último tramo de un enlace («…/rss/123/» → «123»); null si no tiene: el id no puede quedar vacío y repetirse. */
const lastSegment = (link) => String(link ?? '').replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || null;
const placeByName = (list, name) => list.find((p) => fold(p.name) === fold(name));

/** «27/10/2026 a las 16:16» o «27/10/2026 16:16» (hora de Madrid) → epoch ms. */
function spanishDateTime(s) {
  const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const pad = (v) => String(v ?? 0).padStart(2, '0');
  return madridLocalToMs(`${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`);
}

/**
 * Evento del mapa para un aviso en vigor, en el lugar indicado. `expires`: hasta cuándo sigue en vigor
 * sin noticias de su fin (ver expiresAt), para que no se quede en el mapa si su fuente deja de responder.
 */
function toEvent(sourceId, notice, place, where, expires = null) {
  return {
    id: `${sourceId}:${notice.id}${place ? `:${slug(place)}` : ''}`,
    group: `${sourceId}:${notice.id}`, // el mismo aviso en varios lugares: una sola alerta
    category: 'emergencia',
    type: notice.power ? 'apagon' : 'plan',
    power: notice.power,
    severity: notice.severity,
    title: notice.title,
    description: notice.description,
    area: where.name,
    approx: where.approx,
    lat: where.lat,
    lon: where.lon,
    issued: notice.at,
    url: notice.url,
    credit: CREDITS[sourceId],
    ...(notice.dayOnly ? { issuedDayOnly: true } : {}), // la fuente sólo da el día, sin hora
    ...(expires ? { expires } : {}),
  };
}

/** Lo más reciente que ha publicado la fuente (cualquier aviso): la fecha de actualización que piden citar. */
const newest = (dates) => dates.reduce((max, t) => Math.max(max, t || 0), 0) || null;
const rssDates = (doc) => arr(doc.rss?.channel?.item).map((it) => Date.parse(text(it.pubDate)) || 0);

// Lo más que se pregunta al geocodificador en una lectura (lugares distintos). Con su caché, en una
// lectura normal casi todos ya se conocen: esto sólo pone tope a una con muchos pueblos nuevos.
const MAX_PLACES_PER_READ = 30;

/**
 * Sitúa con el geocodificador los lugares que cita cada aviso del 112, de los más nuevos a los más
 * viejos. Se quedan los que existen en esa comunidad; si no encuentra ninguno, el aviso cuenta para
 * toda la provincia que nombre o, si no, para toda la comunidad. Cada lugar se pregunta una vez por
 * lectura, como mucho MAX_PLACES_PER_READ, y si el servicio no responde no se le pregunta más hasta la
 * siguiente lectura (cada pregunta puede esperar 10 s).
 * @param {OfficialNotice[]} notices
 * @param {import('../geo/cartociudad-geocoder.js').Geocoder} geocoder
 * @returns {Promise<Map<string, Where>>} nombre del lugar → ubicación
 */
async function locateNotices(notices, geocoder, region) {
  const where = new Map();
  const asked = new Map(); // lugar|provincia → lo que respondió en esta lectura
  let down = false;
  const locate = async (name, province) => {
    const key = `${fold(name)}|${fold(province)}`;
    if (asked.has(key)) return asked.get(key);
    if (down || asked.size >= MAX_PLACES_PER_READ) return null;
    let hit = null;
    try {
      hit = await geocoder.locate(name, { region, ...(province ? { province } : {}) });
    } catch {
      down = true; // ya lo ha apuntado el geocodificador
    }
    asked.set(key, hit);
    return hit;
  };
  for (const n of [...notices].sort((a, b) => b.at - a.at)) {
    const found = [];
    for (const name of n.candidates ?? []) {
      const hit = await locate(name, n.province);
      if (!hit) continue;
      where.set(hit.name, { name: hit.name, lat: hit.lat, lon: hit.lon, approx: 'municipio' });
      if (!found.includes(hit.name)) found.push(hit.name);
    }
    if (!found.length && n.province && placeByName(PROVINCIAS, n.province)) {
      const p = placeByName(PROVINCIAS, n.province);
      where.set(p.name, { ...p, approx: 'provincia' });
      found.push(p.name);
    }
    n.places = found;
  }
  return where;
}

/**
 * Eventos del mapa de los avisos que siguen en vigor, igual para todas las fuentes: cuáles lo están (y
 * cuánto dura cada uno) lo decide el dominio con currentNotices. `where` sitúa cada lugar (isla,
 * provincia o municipio ya geocodificado); un aviso sin lugar, o con uno que `where` no sitúa, va al
 * centro de la comunidad `region`.
 * @param {string} sourceId
 * @param {OfficialNotice[]} notices
 * @param {{ now: number, region: keyof typeof COMUNIDADES, where?: Map<string, Where>, wholeNotice?: boolean }} opts
 */
function eventsFrom(sourceId, notices, { now, region, where = new Map(), wholeNotice = false }) {
  const fallback = { ...COMUNIDADES[region], approx: 'comunidad' };
  // Un «ha vuelto la luz» que no se ha podido situar no cierra nada: sin lugares, cerraría los cortes
  // de toda la comunidad.
  const usable = notices.filter((n) => !(n.end && n.candidates && !n.places.length));
  return currentNotices(usable, { now, wholeNotice })
    .map(({ notice, place }) => toEvent(sourceId, notice, place, (place && where.get(place)) || fallback, expiresAt(notice)));
}
/** Lugares de una tabla fija (islas, provincias), por su nombre, para situar los avisos. */
const placesAs = (list, approx) => new Map(list.map((p) => [p.name, { name: p.name, lat: p.lat, lon: p.lon, approx }]));

// ---------- Gobierno de Canarias: alertas del PLATECA ----------
const CANARIAS = 'https://www3.gobiernodecanarias.org/noticias/category/alertas/feed/';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseCanariasAlertas(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];
  for (const it of arr(doc.rss?.channel?.item)) {
    const title = htmlText(text(it.title));
    if (!title || (!isPlanNotice(title) && !mentionsPowerCut(title))) continue; // otras noticias de la categoría
    const body = htmlText(text(it.encoded) ?? text(it.description));
    // «Municipios o ámbitos afectados: Isla de La Palma» es el dato: el texto libre a veces se equivoca de isla.
    const scope = body.match(/[aá]mbitos afectados:\s*(.+?)(?=\s+Observaciones:|\n|$)/i)?.[1];
    let islands = scope ? islandsIn(scope) : [];
    if (!islands.length) islands = islandsIn(title);
    const notes = body.match(/Observaciones:\s*(.+?)(?=\s+Declaraci[oó]n\b|\n|$)/i)?.[1];
    const link = text(it.link);
    out.push({
      id: text(it.guid)?.match(/[?&]p=(\d+)/)?.[1] ?? slug(link ?? title),
      at: Date.parse(text(it.pubDate)) || 0,
      end: isEndNotice(title),
      subjects: subjectsOf(title, body),
      places: islands, // ['*'] si dice todo el archipiélago: sustituye a los avisos anteriores de cada isla
      title,
      description: notes ?? htmlText(text(it.description)).replace(/\s*\[…\]$/, '…'),
      url: link,
      power: mentionsPowerCut(`${title} ${body}`),
      severity: severityOf(title) ?? 'media',
    });
  }
  return { notices: out, updated: newest(rssDates(doc)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createCanariasAlertasSource({ http, now = Date.now }) {
  return {
    id: 'emergencias-canarias',
    name: 'Gobierno de Canarias: alertas del plan de emergencias (PLATECA)',
    kind: 'events',
    interval: 300_000,
    url: CANARIAS,
    page: 'https://www3.gobiernodecanarias.org/noticias/category/alertas/',
    license: `${CREDITS['emergencias-canarias']} · CC BY 4.0`,
    async fetch() {
      const { notices, updated } = parseCanariasAlertas(await http.text(CANARIAS, { timeout: 30_000, maxBytes: FEED_MAX_BYTES }));
      const events = eventsFrom('emergencias-canarias', notices, { now: now(), region: 'canarias', where: placesAs(ISLAS_CANARIAS, 'isla') });
      return { sourceTime: updated, events };
    },
  };
}

// ---------- Generalitat de Catalunya: planes de protección civil activados ----------
const CATALUNA = 'https://analisi.transparenciacatalunya.cat/resource/wj9c-j6vf.json';
const CATALUNA_META = 'https://analisi.transparenciacatalunya.cat/api/views/wj9c-j6vf.json';

/** Filas del conjunto (sólo trae los planes activos; vacío si no hay ninguno) → eventos. */
export function parseCatalunaPlans(rows) {
  const where = { ...COMUNIDADES.cataluna, approx: 'comunidad' }; // el conjunto no trae comarcas
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r && fold(r.plaactivat) === 'si') // «SI»: si el campo cambia, mejor nada que todo por activo
    .map((r) => {
      const name = String(r.planom ?? r.plaacronim ?? 'Pla de protecció civil');
      const acronym = r.plaacronim ? String(r.plaacronim) : '';
      const phase = r.plafase ? String(r.plafase) : '';
      // «02/11/2026 12:07»: día/mes (Date.parse lo leería como 11 de febrero).
      const at = spanishDateTime(r.fasedatahora) ?? (Date.parse(r.fasedatahora) || null);
      const description = r.descripcio ? String(r.descripcio) : '';
      const pdf = typeof r.comunicatpdf === 'object' ? r.comunicatpdf?.url : r.comunicatpdf;
      return toEvent('emergencias-cataluna', {
        id: slug(`${acronym || name}-${phase}`),
        at,
        power: mentionsPowerCut(`${name} ${description}`),
        severity: severityOf(phase) ?? 'media',
        title: `${name}${acronym && !name.includes(acronym) ? ` (${acronym})` : ''}${phase ? ` · ${phase}` : ''}`,
        description,
        url: pdf ? String(pdf) : null,
      }, null, where);
    });
}

// El conjunto de Cataluña sólo trae los planes activos y no dice hasta cuándo: cada lectura los da por
// vigentes dos horas más, para que no se queden en el mapa si la fuente deja de responder.
const CATALUNA_TTL = 2 * 3_600_000;

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createCatalunaPlansSource({ http, now = Date.now }) {
  return {
    id: 'emergencias-cataluna',
    name: 'Generalitat de Catalunya: plans de protecció civil activats',
    kind: 'events',
    interval: 300_000,
    url: CATALUNA,
    page: 'https://analisi.transparenciacatalunya.cat/d/wj9c-j6vf',
    license: `${CREDITS['emergencias-cataluna']} · Llicència oberta d'ús d'informació – Catalunya`,
    async fetch() {
      const expires = now() + CATALUNA_TTL;
      const events = parseCatalunaPlans(await http.json(CATALUNA, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES }))
        .map((e) => ({ ...e, expires }));
      // La licencia pide la fecha de la última actualización: la da la ficha del conjunto.
      const meta = await http.json(CATALUNA_META, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES }).catch(() => null);
      const updated = Number(meta?.rowsUpdatedAt);
      return { sourceTime: Number.isFinite(updated) && updated > 0 ? updated * 1000 : null, events };
    },
  };
}

// ---------- Junta de Andalucía: noticias del 112 (EMA) ----------
const ANDALUCIA = 'https://datos.juntadeandalucia.es/api/v0/news/paginated_search?provider=GeNews&topic=Emergencias%20112'
  + '&search_text=-&size=30&page=0&order_by=publication_date&mode=DESC';

/**
 * Cada noticia puede dar un aviso de plan (activa, desactiva, cambia de fase), uno de corte de luz
 * en los lugares que cita y otro de que la luz ha vuelto en otros. Un corte sólo cuenta si la noticia
 * dice dónde: «roturas de tuberías o cortes de luz» sueltos en el balance de un temporal no son un
 * corte en toda Andalucía (sí «195 personas sin suministro eléctrico en Jimena de la Frontera»). Las
 * fotos no se usan: la licencia del portal no permite reproducir sus logotipos.
 * @returns {{ notices: OfficialNotice[], updated: number|null }}
 */
export function parseAndaluciaNews(json) {
  const out = [];
  for (const r of arr(json?.results)) {
    const title = htmlText(r.title);
    if (!title) continue;
    const subtitle = htmlText(r.subtitle);
    const body = htmlText(r.body);
    const full = `${title}. ${subtitle}.\n${body}`;
    const at = Date.parse(r.publication_date) || 0;
    const url = typeof r.path === 'object' ? r.path?.uri : r.path;
    const base = { at, url: url ? String(url) : null };
    const id = String(r.id ?? slug(title));
    const province = provincesIn(title, 'andalucia')[0] ?? null;
    if (isPlanNotice(title)) {
      out.push({
        ...base, id: `${id}:plan`, end: isEndNotice(title), subjects: subjectsOf(title), places: provincesIn(title, 'andalucia'),
        title, description: subtitle, power: mentionsPowerCut(title), severity: severityOf(title) ?? 'media',
      });
    }
    const { cut, back } = powerClauses(full);
    const cutPlaces = placeCandidates(cut.join(' '));
    if (cutPlaces.length) {
      out.push({
        ...base, id: `${id}:luz`, end: false, subjects: ['luz'], places: [], candidates: cutPlaces, province,
        title, description: cut.join(' '), power: true, severity: 'media',
      });
    }
    if (back.length) {
      out.push({
        ...base, id: `${id}:vuelve`, end: true, subjects: ['luz'], places: [], candidates: placeCandidates(back.join(' ')), province,
        title, description: back.join(' '), power: true, severity: 'baja',
      });
    }
  }
  return { notices: out, updated: newest(arr(json?.results).map((r) => Date.parse(r.update_date ?? r.publication_date) || 0)) };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder,
 *           now?: () => number }} deps
 */
export function createAndaluciaEmergenciasSource({ http, geocoder, now = Date.now }) {
  return {
    id: 'emergencias-andalucia',
    name: 'Junta de Andalucía: emergencias 112 (planes activados y cortes de luz)',
    kind: 'events',
    interval: 600_000,
    url: ANDALUCIA,
    page: 'https://www.juntadeandalucia.es/datosabiertos/portal/dataset/noticias-de-la-junta-de-andalucia',
    license: `${CREDITS['emergencias-andalucia']} · CC BY 4.0`,
    async fetch() {
      const { notices, updated } = parseAndaluciaNews(await http.json(ANDALUCIA, { timeout: 30_000, maxBytes: FEED_MAX_BYTES }));
      // Se sitúan todos (el geocodificador guarda cada pueblo): también un «ha vuelto la luz» viejo
      // tiene que saber dónde para cerrar sólo allí.
      const where = await locateNotices(notices.filter((n) => n.candidates), geocoder, REGION.andalucia);
      for (const n of notices) {
        if (n.candidates) continue;
        for (const p of n.places) {
          const prov = placeByName(PROVINCIAS, p);
          if (prov) where.set(p, { ...prov, approx: 'provincia' });
        }
      }
      return { sourceTime: updated, events: eventsFrom('emergencias-andalucia', notices, { now: now(), region: 'andalucia', where }) };
    },
  };
}

// ---------- 112 Castilla-La Mancha: planes activados ----------
const CLM = 'https://112.castillalamancha.es/rss.xml';

/** El feed sólo trae activaciones y desactivaciones de planes («PLATECAM, activado en la provincia de Toledo»). */
export function parseClmPlans(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];
  for (const it of arr(doc.rss?.channel?.item)) {
    const title = htmlText(text(it.title));
    if (!title || (!mentionsPlan(title) && !mentionsPowerCut(title))) continue;
    // La descripción repite el título con el usuario que lo publicó y los botones de compartir: sólo se usa su fecha.
    const datetime = String(text(it.description) ?? '').match(/datetime="([^"]+)"/)?.[1];
    const link = text(it.link);
    out.push({
      id: slug(lastSegment(link) ?? title),
      at: Date.parse(datetime) || Date.parse(text(it.pubDate)) || 0,
      end: isEndNotice(title),
      subjects: subjectsOf(title),
      places: provincesIn(title, 'castilla-la-mancha'),
      title,
      description: '',
      url: link,
      power: mentionsPowerCut(title),
      severity: severityOf(title) ?? 'media',
    });
  }
  return { notices: out, updated: newest(out.map((n) => n.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createClmPlansSource({ http, now = Date.now }) {
  return {
    id: 'emergencias-castilla-la-mancha',
    name: '112 Castilla-La Mancha: planes de emergencia activados',
    kind: 'events',
    interval: 600_000,
    url: CLM,
    page: 'https://112.castillalamancha.es/',
    license: CREDITS['emergencias-castilla-la-mancha'],
    async fetch() {
      const { notices, updated } = parseClmPlans(await http.text(CLM, { timeout: 30_000, maxBytes: FEED_MAX_BYTES }));
      const events = eventsFrom('emergencias-castilla-la-mancha', notices, { now: now(), region: 'castilla-la-mancha', where: placesAs(PROVINCIAS, 'provincia') });
      return { sourceTime: updated, events };
    },
  };
}

// ---------- SOS Rioja 112 y 112 Castilla y León: cortes de luz ----------

/** Aviso de corte de luz (o de que ha vuelto) de una incidencia del 112; null si no habla de la luz. */
function powerNotice({ id, at, title, body, url, town, province }) {
  const full = `${title}. ${body}`;
  const { cut, back } = powerClauses(full);
  const restored = (isEndNotice(title) && mentionsPowerBack(full)) || (back.length > 0 && !cut.length);
  if (!cut.length && !restored) return null;
  // Una incidencia del 112 es un solo suceso: los pueblos afectados pueden estar en otra frase
  // («una avería que afecta a Mansilla, Villavelayo…»). Si dice que la luz ha vuelto, sólo donde lo dice.
  const said = restored ? back.join(' ') : body;
  return {
    id, at, end: restored, subjects: ['luz'], places: [], candidates: [...new Set([town, ...placeCandidates(said)].filter(Boolean))],
    province, title, description: body, url, power: true, severity: restored ? 'baja' : 'media',
  };
}

const RIOJA = 'https://www.larioja.org/larioja-client/cm/emergencias-112/rss?locale=es_ES&rssContent=1082236';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseRiojaSos(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];
  const dates = [];
  for (const it of arr(doc.rss?.channel?.item)) {
    const title = htmlText(text(it.title));
    const html = String(text(it.description) ?? '');
    // «27/10/2026 a las 16:16 en Ventrosa»: la fecha y el lugar del suceso (el pubDate siempre dice las 12:00).
    const when = htmlText(html.match(/class="fecha_sos"[^>]*>([\s\S]*?)<\/div>/)?.[1]);
    const body = htmlText(html.match(/class="contentText"[^>]*>([\s\S]*)$/)?.[1] ?? html);
    const link = text(it.link);
    const notice = powerNotice({
      id: slug(lastSegment(link) ?? title),
      at: spanishDateTime(when) || Date.parse(text(it.pubDate)) || 0,
      title, body, url: link,
      town: when.match(/\ben\s+(.+)$/)?.[1]?.trim() ?? null,
      province: null,
    });
    if (notice) out.push(notice);
    dates.push(spanishDateTime(when) || 0);
  }
  return { notices: out, updated: newest(dates) };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder,
 *           now?: () => number }} deps
 */
export function createRiojaSosSource({ http, geocoder, now = Date.now }) {
  return {
    id: 'emergencias-la-rioja',
    name: 'SOS Rioja 112: cortes de luz',
    kind: 'events',
    interval: 600_000,
    url: RIOJA,
    page: 'https://www.larioja.org/emergencias-112/es',
    license: CREDITS['emergencias-la-rioja'],
    async fetch() {
      const { notices, updated } = parseRiojaSos(await http.text(RIOJA, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES }));
      const where = await locateNotices(notices, geocoder, REGION['la-rioja']);
      return { sourceTime: updated, events: eventsFrom('emergencias-la-rioja', notices, { now: now(), region: 'la-rioja', where, wholeNotice: true }) };
    },
  };
}

const CYL = 'https://112.jcyl.es/web/jcyl/112/es/PlantillaGeneracionContenidoIncidenteSindicadoComponente/1284178030391/_/1284739950810/Estructura';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseCyl112(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];
  for (const it of arr(doc.rss?.channel?.item)) {
    const title = htmlText(text(it.title));
    const body = htmlText(text(it.description));
    // «Santa Cruz del Valle Urbión (Burgos) - El Centro Coordinador…»
    const head = body.match(/^(.+?)\s*\(([^()]+)\)\s*[-–]\s*/);
    const link = String(text(it.link) ?? '').replace(/[?&]utm_[^#]*$/, '');
    const notice = powerNotice({
      id: link.match(/\/(\d{6,})\//)?.[1] ?? slug(title),
      at: Date.parse(text(it.pubDate)) || 0,
      title, body, url: link || null,
      town: head?.[1] ?? null,
      province: head?.[2] ?? null,
    });
    if (notice) out.push(notice);
  }
  return { notices: out, updated: newest(rssDates(doc)) };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder,
 *           now?: () => number }} deps
 */
export function createCyl112Source({ http, geocoder, now = Date.now }) {
  // El feed sólo trae la última incidencia: se guardan las de los últimos días para que no
  // desaparezca del mapa un corte de luz en cuanto el 112 publica otra cosa.
  const kept = new Map();
  return {
    id: 'emergencias-castilla-y-leon',
    name: '112 Castilla y León: cortes de luz',
    kind: 'events',
    interval: 180_000,
    url: CYL,
    page: 'https://112.jcyl.es/',
    license: CREDITS['emergencias-castilla-y-leon'],
    async fetch() {
      const t = now();
      const { notices: latest, updated } = parseCyl112(await http.text(CYL, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES }));
      for (const n of latest) kept.set(n.id, n);
      // Sólo para no guardarlas para siempre: se olvidan las que ya no podrían estar en vigor con
      // ninguna vigencia. Cuáles lo están lo decide currentNotices.
      for (const [id, n] of kept) if (t - n.at > NOTICE_MAX_AGE) kept.delete(id);
      const notices = [...kept.values()];
      const where = await locateNotices(notices, geocoder, REGION['castilla-y-leon']);
      return { sourceTime: updated, events: eventsFrom('emergencias-castilla-y-leon', notices, { now: t, region: 'castilla-y-leon', where, wholeNotice: true }) };
    },
  };
}

// ---------- Govern de les Illes Balears: sala de prensa (emergencias y cortes de luz) ----------
// El RSS de «Noticias» del mismo catálogo está parado desde abril de 2024: se usa el de la sala de prensa,
// con la URL exacta del catálogo de datos.gob.es (en catalán).
const BALEARES = 'https://www.caib.es/pidip2front/pidipRSS?opcio=getRSS&grup=salaDePremsa&lang=ca';
// Trae unas 1.300 notas (tres meses, unos 800 KB) de la más nueva a la más vieja: con las 200 primeras
// (unas dos semanas) sobra para lo que puede seguir en vigor, y no se leen las demás cada 15 minutos.
const BALEARES_ITEMS = 200;

/** El RSS viene en ISO-8859-1 (lo dice su cabecera XML): se decodifica con la codificación que declara. */
export function decodeXml(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared = head.match(/encoding=["']([\w-]+)["']/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(declared).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** El RSS con sólo sus `max` primeras notas (se corta el texto antes de leerlo, que es lo que cuesta). */
export function firstItems(xml, max) {
  let at = -1;
  for (let i = 0; i < max; i++) {
    at = xml.indexOf('</item>', at + 1);
    if (at < 0) return xml;
  }
  return `${xml.slice(0, at + '</item>'.length)}</channel></rss>`;
}

/**
 * Sólo trae títulos (sin texto), en catalán: se quedan las declaraciones de alerta o emergencia de
 * protección civil, su fin y los cortes de luz. Las reuniones del CECOPI, las obras «de emergència»,
 * los protocolos, una sequía o una alerta sanitaria o alimentaria no son avisos del mapa, y un aviso
 * que no dice su riesgo ni un nivel no puede cerrar los de los demás (subjectsOf).
 * @returns {{ notices: OfficialNotice[], updated: number|null }}
 */
export function parseBalearsPremsa(xml) {
  const doc = xmlParser.parse(xml);
  const out = [];
  for (const it of arr(doc.rss?.channel?.item)) {
    const title = htmlText(text(it.title));
    if (!title) continue;
    const t = fold(title);
    // «Decretat el final de l'emergència a Eivissa» no nombra plan ni riesgo; «finalitza les excavacions
    // del V Pla de Fosses» no es una emergencia.
    const end = isEndNotice(title) && /\b(?:emergencia|alerta|prealerta|platerbal|meteobal|inunbal|infobal)\b/.test(t);
    const power = mentionsPowerCut(title);
    if (!isPlanNotice(title) && !end && !power) continue;
    const subjects = subjectsOf(title);
    if (!power && subjects[0] === 'sin-riesgo') continue;
    const illes = illesIn(title);
    // Sus enlaces apuntan a intranet.caib.es, que redirige; la misma ficha está en www.caib.es.
    const link = String(text(it.link) ?? '').replace(/^https?:\/\/intranet\.caib\.es\//, 'https://www.caib.es/');
    out.push({
      id: String(text(it.guid) ?? slug(title)),
      at: Date.parse(text(it.pubDate)) || 0,
      end: isEndNotice(title),
      subjects,
      places: illes, // ['*'] si dice todas las islas: sustituye a los avisos anteriores de cada isla
      title,
      description: '',
      url: link || null,
      power,
      severity: severityOf(title) ?? 'media',
    });
  }
  return { notices: out, updated: newest(rssDates(doc)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createBalearsPremsaSource({ http, now = Date.now }) {
  return {
    id: 'emergencias-illes-balears',
    name: 'Govern de les Illes Balears: emergencias y cortes de luz (sala de prensa)',
    kind: 'events',
    interval: 900_000, // unos 800 KB por lectura y sin caché: cada 15 minutos
    url: BALEARES,
    page: 'https://datos.gob.es/catalogo/a04003003-actualidad-informativa-comunicaciones-del-gobierno-de-las-islas-baleares1',
    license: `${CREDITS['emergencias-illes-balears']} · CC BY`,
    async fetch() {
      const xml = decodeXml(await http.bytes(BALEARES, { timeout: 60_000, maxBytes: 4 * 1024 * 1024 }));
      const { notices, updated } = parseBalearsPremsa(firstItems(xml, BALEARES_ITEMS));
      const events = eventsFrom('emergencias-illes-balears', notices, { now: now(), region: 'illes-balears', where: placesAs(ILLES_BALEARS, 'isla') });
      return { sourceTime: updated, events };
    },
  };
}

// ---------- Notas de prensa de los gobiernos: Madrid, Murcia, Cantabria, Galicia y País Vasco ----------
// Ninguno tiene un 112 que publique sus avisos con licencia: se leen las notas de prensa del gobierno,
// que mezclan todos los temas. Por eso sólo cuentan los títulos, y sólo los que declaran, cambian o
// terminan un plan nombrándolo (isPressPlanNotice), los que dicen que hay un corte de luz y los que dicen
// que ha vuelto. Se citan el título y la entradilla sin alterar; no se usan fotos ni logotipos.

/** El primer párrafo de un texto (la entradilla de una nota), sin etiquetas. */
const firstParagraph = (html) => htmlText(html).split('\n')[0] ?? '';

/**
 * Avisos de las notas de prensa de una comunidad (`region`, clave de COMUNIDADES). Un plan va a las
 * provincias que nombra; un corte de luz, a los pueblos que cita (candidatos para el geocodificador).
 * @param {{ id: string, at: number, title: string, summary?: string, url: string|null, dayOnly?: boolean }[]} items
 * @returns {OfficialNotice[]}
 */
export function pressNotices(items, region) {
  const out = [];
  for (const { id, at, title, summary = '', url, dayOnly = false } of items) {
    if (!title) continue;
    const plan = isPressPlanNotice(title);
    const cut = !plan && mentionsPowerCut(title);
    const back = !plan && !cut && mentionsPowerBack(title);
    if (!plan && !cut && !back) continue;
    const subjects = plan ? subjectsOf(title) : ['luz'];
    if (subjects[0] === 'sin-riesgo') continue;
    const provinces = provincesIn(title, region);
    out.push({
      id, at, end: back || (plan && isEndNotice(title)), subjects,
      places: plan ? provinces : [],
      ...(plan ? {} : { candidates: placeCandidates(title), province: provinces[0] ?? null }),
      title, description: summary, url, power: plan ? mentionsPowerCut(title) : true,
      severity: back ? 'baja' : (severityOf(title) ?? 'media'),
      ...(dayOnly ? { dayOnly } : {}),
    });
  }
  return out;
}

/** Fuente de notas de prensa: descarga, lee, sitúa los pueblos de los cortes y da los avisos en vigor. */
function pressSource({ id, name, interval, url, page, license, region, read, geocoder, now, sourceTime = (updated) => updated }) {
  return {
    id, name, kind: 'events', interval, url, page, license,
    async fetch() {
      const t = now();
      const { notices, updated } = await read(t);
      const where = await locateNotices(notices.filter((n) => n.candidates), geocoder, REGION[region]);
      for (const n of notices) {
        if (n.candidates) continue;
        for (const p of n.places) {
          const prov = placeByName(PROVINCIAS, p);
          if (prov) where.set(p, { ...prov, approx: 'provincia' });
        }
      }
      return { sourceTime: sourceTime(updated), events: eventsFrom(id, notices, { now: t, region, where }) };
    },
  };
}

// Comunidad de Madrid: «Últimas noticias» de comunidad.madrid (su página de sindicación), unas 20 notas.
const MADRID = 'https://www.comunidad.madrid/rss/latest-news.xml';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseMadridNews(xml) {
  const doc = xmlParser.parse(xml);
  const items = arr(doc.rss?.channel?.item).map((it) => {
    const title = htmlText(text(it.title));
    const link = text(it.link);
    // pubDate es cuándo se redactó: una nota publicada el lunes puede llevar la del viernes. El día de
    // su enlace («/noticias/2026/11/02/…») es el de publicación.
    const day = String(link ?? '').match(/\/noticias\/(\d{4})\/(\d{2})\/(\d{2})\//);
    const at = Math.max(Date.parse(text(it.pubDate)) || 0, (day && madridLocalToMs(`${day[1]}-${day[2]}-${day[3]}T00:00:00`)) || 0);
    // La descripción trae la nota entera (con sus fotos): sólo su primer párrafo.
    const body = String(text(it.description) ?? '').match(/field--name-body[^>]*>([\s\S]*)$/)?.[1] ?? '';
    return { id: slug(lastSegment(link) ?? title), at, title, summary: firstParagraph(body), url: link || null };
  });
  return { notices: pressNotices(items, 'madrid'), updated: newest(items.map((i) => i.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder, now?: () => number }} deps */
export function createMadridNewsSource({ http, geocoder, now = Date.now }) {
  return pressSource({
    id: 'emergencias-madrid',
    name: 'Comunidad de Madrid: planes de emergencia y cortes de luz (últimas noticias)',
    interval: 900_000,
    url: MADRID,
    page: 'https://www.comunidad.madrid/gobierno/digitalizacion/sindicacion-contenidos-portal-comunidad-madrid',
    license: CREDITS['emergencias-madrid'],
    region: 'madrid',
    read: async () => parseMadridNews(await http.text(MADRID, { timeout: 30_000, maxBytes: FEED_MAX_BYTES })),
    // Su aviso legal pide la fecha de extracción: sin sourceTime, la ficha da la hora a la que se leyó.
    sourceTime: () => null,
    geocoder, now,
  });
}

// Región de Murcia: «Noticias de la CARM en los últimos 7 días» del portal de datos abiertos (datos.gob.es
// a14002961), en XML (el JSON es de arrays sin nombres de campo).
const MURCIA = 'https://datosabiertos.carm.es/rest-services/services/restFile/comunicaNoticiasOD.xml';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseMurciaNews(xml) {
  const doc = xmlParser.parse(xml);
  const items = arr(doc.resultados?.resultado).map((r) => {
    const title = htmlText(text(r.TITULO));
    const day = String(text(r.FECHA_VIGENCIA_DESDE) ?? text(r.FECHANOTICIA) ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    const hour = String(text(r.HORA_VIGENCIA_DESDE) ?? '').match(/^(\d{1,2}):(\d{2})/);
    const at = day ? madridLocalToMs(`${day[3]}-${day[2]}-${day[1]}T${(hour?.[1] ?? '00').padStart(2, '0')}:${hour?.[2] ?? '00'}:00`) : 0;
    // El enlace viene escapado dos veces («&amp;amp;»).
    const link = htmlText(text(r.URL_NOTICIA_CARM)) || null;
    return {
      id: link?.match(/IDCONTENIDO=(\d+)/)?.[1] ?? slug(title), at: at || 0, title,
      summary: firstParagraph(String(text(r.ENTRADILLA) ?? '').replace(/\r?\n\s*\r?\n/g, '</p>')), url: link,
    };
  });
  return { notices: pressNotices(items, 'murcia'), updated: newest(items.map((i) => i.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder, now?: () => number }} deps */
export function createMurciaNewsSource({ http, geocoder, now = Date.now }) {
  return pressSource({
    id: 'emergencias-murcia',
    name: 'Región de Murcia: planes de emergencia y cortes de luz (noticias de la CARM)',
    interval: 900_000,
    url: MURCIA,
    page: 'https://datos.gob.es/catalogo/a14002961-noticias-de-la-carm-en-los-ultimos-7-dias',
    license: CREDITS['emergencias-murcia'],
    region: 'murcia',
    read: async () => parseMurciaNews(await http.text(MURCIA, { timeout: 30_000, maxBytes: FEED_MAX_BYTES })),
    geocoder, now,
  });
}

// Cantabria: notas de prensa del Gobierno (índice oficial www.cantabria.es/enlaces_rss), las 50 últimas.
// Sólo traen el título y el día (sin hora ni texto).
const CANTABRIA = 'https://www.cantabria.es/o/GOBIERNO/feed/group16413/eid4008216/size50';

/**
 * Sin hora, una nota del día cuenta desde que se lee hasta el mediodía y, después, desde el mediodía:
 * así un corte de luz se ve hasta el mediodía siguiente. La ficha sólo da el día (`dayOnly`).
 * @returns {{ notices: OfficialNotice[], updated: number|null }}
 */
export function parseCantabriaNews(xml, now) {
  const doc = xmlParser.parse(xml);
  const items = arr(doc.rss?.channel?.item).map((it) => {
    const title = htmlText(text(it.title));
    const link = text(it.link);
    const day = String(text(it.modDate) ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    const noon = day ? madridLocalToMs(`${day[1]}-${day[2]}-${day[3]}T12:00:00`) : null;
    return { id: lastSegment(link) ?? slug(title), at: noon ? Math.min(now, noon) : 0, title, url: link || null, dayOnly: true };
  });
  return { notices: pressNotices(items, 'cantabria'), updated: newest(items.map((i) => i.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder, now?: () => number }} deps */
export function createCantabriaNewsSource({ http, geocoder, now = Date.now }) {
  return pressSource({
    id: 'emergencias-cantabria',
    name: 'Gobierno de Cantabria: planes de emergencia y cortes de luz (notas de prensa)',
    interval: 900_000,
    url: CANTABRIA,
    page: 'https://www.cantabria.es/enlaces_rss',
    license: `${CREDITS['emergencias-cantabria']} · CC BY 3.0 ES`,
    region: 'cantabria',
    read: async (t) => parseCantabriaNews(await http.text(CANTABRIA, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES }), t),
    geocoder, now,
  });
}

// Galicia: notas de prensa de la Xunta en castellano, las del área «Emerxencias» y las últimas de todas
// (la etiqueta no siempre se pone: la activación del PLATERGA por el eclipse no la llevaba). Cada RSS
// trae 15; el general, unas cuatro horas de un día laborable.
const GALICIA_EMERGENCIAS = 'https://www.xunta.gal/es/novas_rss.htm?category=Taxonomias/Web/Novas/Areas_tematicas/Emerxencias/';
const GALICIA = 'https://www.xunta.gal/es/novas_rss.htm';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parseGaliciaNews(xml) {
  const doc = xmlParser.parse(xml);
  const items = arr(doc.rss?.channel?.item).map((it) => {
    const title = htmlText(text(it.title));
    const link = text(it.link);
    return {
      id: String(link ?? '').match(/\/nova\/(\d+)\//)?.[1] ?? slug(title), at: Date.parse(text(it.pubDate)) || 0, title,
      summary: firstParagraph(text(it.description)), url: link || null,
    };
  });
  return { notices: pressNotices(items, 'galicia'), updated: newest(items.map((i) => i.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder, now?: () => number }} deps */
export function createGaliciaNewsSource({ http, geocoder, now = Date.now }) {
  // El RSS general sólo trae unas horas: se guardan los avisos de los últimos días para que un corte no
  // desaparezca del mapa en cuanto la Xunta publica otras notas (como en Castilla y León).
  const kept = new Map();
  return pressSource({
    id: 'emergencias-galicia',
    name: 'Xunta de Galicia: planes de emergencia y cortes de luz (notas de prensa)',
    interval: 600_000,
    url: GALICIA_EMERGENCIAS,
    page: 'https://www.xunta.gal/es/notas-de-prensa',
    license: CREDITS['emergencias-galicia'],
    region: 'galicia',
    read: async (t) => {
      const feeds = await Promise.allSettled([GALICIA_EMERGENCIAS, GALICIA].map((u) => http.text(u, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES })));
      if (feeds.every((f) => f.status === 'rejected')) throw feeds[0].reason;
      let updated = null;
      for (const f of feeds) {
        if (f.status !== 'fulfilled') continue;
        const read = parseGaliciaNews(f.value);
        for (const n of read.notices) kept.set(n.id, n);
        updated = Math.max(updated ?? 0, read.updated ?? 0) || null;
      }
      for (const [key, n] of kept) if (t - n.at > NOTICE_MAX_AGE) kept.delete(key);
      // Copias: locateNotices rellena `places` de cada aviso en cada lectura.
      return { notices: [...kept.values()].map((n) => ({ ...n })), updated };
    },
    geocoder, now,
  });
}

// País Vasco: noticias del Departamento de Seguridad en Irekia (conjunto «Noticias de Irekia» de Open
// Data Euskadi), unas 15 de las últimas semanas. El 112 (SOS Deiak) no publica las suyas en abierto.
const PAIS_VASCO = 'https://www.irekia.euskadi.eus/es/departments/124/news.rss';

/** @returns {{ notices: OfficialNotice[], updated: number|null }} */
export function parsePaisVascoNews(xml) {
  const doc = xmlParser.parse(xml);
  const items = arr(doc.rss?.channel?.item).map((it) => {
    const title = htmlText(text(it.title));
    const link = text(it.link);
    return {
      id: String(link ?? '').match(/\/news\/(\d+)/)?.[1] ?? slug(title), at: Date.parse(text(it.pubDate)) || 0, title,
      summary: firstParagraph(text(it.description)), url: link || null,
    };
  });
  return { notices: pressNotices(items, 'pais-vasco'), updated: newest(items.map((i) => i.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../geo/cartociudad-geocoder.js').Geocoder, now?: () => number }} deps */
export function createPaisVascoNewsSource({ http, geocoder, now = Date.now }) {
  return pressSource({
    id: 'emergencias-pais-vasco',
    name: 'Gobierno Vasco: planes de emergencia y cortes de luz (noticias de Seguridad en Irekia)',
    interval: 900_000,
    url: PAIS_VASCO,
    page: 'https://opendata.euskadi.eus/catalogo/-/noticias-irekia/',
    license: CREDITS['emergencias-pais-vasco'],
    region: 'pais-vasco',
    read: async () => parsePaisVascoNews(await http.text(PAIS_VASCO, { timeout: 30_000, maxBytes: SMALL_MAX_BYTES })),
    geocoder, now,
  });
}
