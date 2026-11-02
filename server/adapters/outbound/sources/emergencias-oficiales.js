// Avisos oficiales de emergencias de las comunidades autónomas: planes de protección civil
// activados (prealerta, alerta, emergencia) y cortes de luz que publican los 112. Cada fuente sólo
// descarga y lee su formato; qué es un corte de luz, de qué riesgo trata un aviso y cuáles siguen
// en vigor lo decide el dominio (domain/emergencias.js). Los textos se muestran tal cual los publica
// cada administración; lo que añade Radar España es el formato y la ubicación aproximada.
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
import {
  currentNotices, fold, isEndNotice, isPlanNotice, islandsIn, mentionsPlan, mentionsPowerBack, mentionsPowerCut,
  placeCandidates, powerClauses, provincesIn, severityOf, subjectsOf,
} from '../../../domain/emergencias.js';
import { COMUNIDADES, ISLAS_CANARIAS, PROVINCIAS } from '../../../domain/lugares.js';
import { arr, htmlText, madridLocalToMs, text, xmlParser } from './parse.js';

const HOUR = 3_600_000;
const PLAN_MAX_AGE = 96 * HOUR; // un plan sin noticias de su fin se deja de mostrar a los 4 días
const CUT_MAX_AGE = 24 * HOUR;  // un corte de luz del 112 sin noticia de que ha vuelto, al día

// Atribución que pide cada licencia, junto a sus datos (ficha, lista de incidencias y alertas).
export const CREDITS = {
  'emergencias-canarias': 'Fuente: Gobierno de Canarias',
  'emergencias-cataluna': "Generalitat de Catalunya. Departament d'Interior i Seguretat Pública. Direcció General de Protecció Civil",
  'emergencias-andalucia': 'Información obtenida del Portal de la Junta de Andalucía',
  'emergencias-castilla-la-mancha': 'Fuente: Junta de Comunidades de Castilla-La Mancha (112 Castilla-La Mancha)',
  'emergencias-la-rioja': 'Fuente: Gobierno de La Rioja (SOS Rioja 112)',
  'emergencias-castilla-y-leon': 'Origen de los datos: Junta de Castilla y León',
};

// Códigos de comunidad del INE, los que usa CartoCiudad.
const REGION = { andalucia: '01', 'castilla-y-leon': '07', 'castilla-la-mancha': '08', 'la-rioja': '17' };

/**
 * @typedef {import('../../../domain/emergencias.js').Notice & {
 *   title: string, description: string, url: string|null, power: boolean, severity: import('../../../domain/model.js').Severity,
 *   candidates?: string[], province?: string|null }} OfficialNotice
 *   candidates: lugares que cita un aviso del 112 y que aún hay que situar con el geocodificador.
 * @typedef {{ name: string, lat: number, lon: number, approx: 'isla'|'municipio'|'provincia'|'comunidad' }} Where
 */

const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const placeByName = (list, name) => list.find((p) => fold(p.name) === fold(name));

/** «27/10/2026 a las 16:16» o «27/10/2026 16:16» (hora de Madrid) → epoch ms. */
function spanishDateTime(s) {
  const m = String(s ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const pad = (v) => String(v ?? 0).padStart(2, '0');
  return madridLocalToMs(`${m[3]}-${pad(m[2])}-${pad(m[1])}T${pad(m[4])}:${pad(m[5])}:${pad(m[6])}`);
}

/** Evento del mapa para un aviso en vigor, en el lugar indicado. */
function toEvent(sourceId, notice, place, where) {
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
  };
}

/** Lo más reciente que ha publicado la fuente (cualquier aviso): la fecha de actualización que piden citar. */
const newest = (dates) => dates.reduce((max, t) => Math.max(max, t || 0), 0) || null;
const rssDates = (doc) => arr(doc.rss?.channel?.item).map((it) => Date.parse(text(it.pubDate)) || 0);

/**
 * Sitúa con el geocodificador los lugares que cita cada aviso del 112. Se quedan los que existen en
 * esa comunidad; si no encuentra ninguno, el aviso cuenta para toda la provincia que nombre o, si
 * no, para toda la comunidad.
 * @param {OfficialNotice[]} notices
 * @param {import('../../../application/ports.js').GeocoderPort} geocoder
 * @returns {Promise<Map<string, Where>>} nombre del lugar → ubicación
 */
async function locateNotices(notices, geocoder, region) {
  const where = new Map();
  for (const n of notices) {
    const found = [];
    for (const name of n.candidates ?? []) {
      const hit = await geocoder.locate(name, { region, ...(n.province ? { province: n.province } : {}) });
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

/** Eventos de los avisos en vigor; los lugares sin ubicación propia van al centro de la comunidad. */
function eventsFrom(sourceId, notices, where, region, now, maxAgeFor, { wholeNotice = false } = {}) {
  const all = currentNotices(notices, { now, maxAgeMs: Math.max(PLAN_MAX_AGE, CUT_MAX_AGE), wholeNotice })
    .filter(({ notice }) => now - notice.at <= maxAgeFor(notice));
  const fallback = { ...COMUNIDADES[region], approx: 'comunidad' };
  return all.map(({ notice, place }) => toEvent(sourceId, notice, place, (place && where.get(place)) || fallback));
}
const maxAge = (n) => (n.power && !isPlanNotice(n.title) ? CUT_MAX_AGE : PLAN_MAX_AGE);

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
      places: islands.includes('*') ? [] : islands,
      title,
      description: notes ?? htmlText(text(it.description)).replace(/\s*\[…\]$/, '…'),
      url: link,
      power: mentionsPowerCut(`${title} ${body}`),
      severity: severityOf(title) ?? 'media',
    });
  }
  return { notices: out, updated: newest(rssDates(doc)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createCanariasAlertasSource({ http }) {
  return {
    id: 'emergencias-canarias',
    name: 'Gobierno de Canarias: alertas del plan de emergencias (PLATECA)',
    kind: 'events',
    interval: 300_000,
    url: CANARIAS,
    page: 'https://www3.gobiernodecanarias.org/noticias/category/alertas/',
    license: `${CREDITS['emergencias-canarias']} · CC BY 4.0`,
    async fetch() {
      const { notices, updated } = parseCanariasAlertas(await http.text(CANARIAS, { timeout: 30_000 }));
      const now = Date.now();
      const events = currentNotices(notices, { now, maxAgeMs: PLAN_MAX_AGE }).map(({ notice, place }) => {
        const isla = place && placeByName(ISLAS_CANARIAS, place);
        return toEvent('emergencias-canarias', notice, place, isla ? { ...isla, approx: 'isla' } : { ...COMUNIDADES.canarias, approx: 'comunidad' });
      });
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
    .filter((r) => r && fold(r.plaactivat) !== 'no')
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

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createCatalunaPlansSource({ http }) {
  return {
    id: 'emergencias-cataluna',
    name: 'Generalitat de Catalunya: plans de protecció civil activats',
    kind: 'events',
    interval: 300_000,
    url: CATALUNA,
    page: 'https://analisi.transparenciacatalunya.cat/d/wj9c-j6vf',
    license: `${CREDITS['emergencias-cataluna']} · Llicència oberta d'ús d'informació – Catalunya`,
    async fetch() {
      const events = parseCatalunaPlans(await http.json(CATALUNA, { timeout: 30_000 }));
      // La licencia pide la fecha de la última actualización: la da la ficha del conjunto.
      const meta = await http.json(CATALUNA_META, { timeout: 30_000 }).catch(() => null);
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
 * en los lugares que cita y otro de que la luz ha vuelto en otros. Las fotos no se usan: la licencia
 * del portal no permite reproducir sus logotipos.
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
    const province = provincesIn(title)[0] ?? null;
    if (isPlanNotice(title)) {
      out.push({
        ...base, id: `${id}:plan`, end: isEndNotice(title), subjects: subjectsOf(title), places: provincesIn(title),
        title, description: subtitle, power: mentionsPowerCut(title), severity: severityOf(title) ?? 'media',
      });
    }
    const { cut, back } = powerClauses(full);
    if (cut.length) {
      out.push({
        ...base, id: `${id}:luz`, end: false, subjects: ['luz'], places: [], candidates: placeCandidates(cut.join(' ')), province,
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

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../../../application/ports.js').GeocoderPort }} deps */
export function createAndaluciaEmergenciasSource({ http, geocoder }) {
  return {
    id: 'emergencias-andalucia',
    name: 'Junta de Andalucía: emergencias 112 (planes activados y cortes de luz)',
    kind: 'events',
    interval: 600_000,
    url: ANDALUCIA,
    page: 'https://www.juntadeandalucia.es/datosabiertos/portal/dataset/noticias-de-la-junta-de-andalucia',
    license: `${CREDITS['emergencias-andalucia']} · CC BY 4.0`,
    async fetch() {
      const { notices, updated } = parseAndaluciaNews(await http.json(ANDALUCIA, { timeout: 30_000 }));
      const now = Date.now();
      // Sólo se sitúan los avisos que aún pueden estar en vigor.
      const recent = notices.filter((n) => now - n.at <= maxAge(n));
      const where = await locateNotices(recent.filter((n) => n.candidates), geocoder, REGION.andalucia);
      for (const n of recent) {
        if (n.candidates) continue;
        for (const p of n.places) {
          const prov = placeByName(PROVINCIAS, p);
          if (prov) where.set(p, { ...prov, approx: 'provincia' });
        }
      }
      return { sourceTime: updated, events: eventsFrom('emergencias-andalucia', recent, where, 'andalucia', now, maxAge) };
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
      id: slug(link?.split('/').pop() ?? title),
      at: Date.parse(datetime) || Date.parse(text(it.pubDate)) || 0,
      end: isEndNotice(title),
      subjects: subjectsOf(title),
      places: provincesIn(title).filter((p) => ['Albacete', 'Ciudad Real', 'Cuenca', 'Guadalajara', 'Toledo'].includes(p)),
      title,
      description: '',
      url: link,
      power: mentionsPowerCut(title),
      severity: severityOf(title) ?? 'media',
    });
  }
  return { notices: out, updated: newest(out.map((n) => n.at)) };
}

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createClmPlansSource({ http }) {
  return {
    id: 'emergencias-castilla-la-mancha',
    name: '112 Castilla-La Mancha: planes de emergencia activados',
    kind: 'events',
    interval: 600_000,
    url: CLM,
    page: 'https://112.castillalamancha.es/',
    license: CREDITS['emergencias-castilla-la-mancha'],
    async fetch() {
      const { notices, updated } = parseClmPlans(await http.text(CLM, { timeout: 30_000 }));
      const where = new Map(PROVINCIAS.map((p) => [p.name, { ...p, approx: 'provincia' }]));
      return { sourceTime: updated, events: eventsFrom('emergencias-castilla-la-mancha', notices, where, 'castilla-la-mancha', Date.now(), maxAge) };
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
      id: slug(link?.split('/').pop() ?? title),
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

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../../../application/ports.js').GeocoderPort }} deps */
export function createRiojaSosSource({ http, geocoder }) {
  return {
    id: 'emergencias-la-rioja',
    name: 'SOS Rioja 112: cortes de luz',
    kind: 'events',
    interval: 600_000,
    url: RIOJA,
    page: 'https://www.larioja.org/emergencias-112/es',
    license: CREDITS['emergencias-la-rioja'],
    async fetch() {
      const { notices, updated } = parseRiojaSos(await http.text(RIOJA, { timeout: 30_000 }));
      const now = Date.now();
      const recent = notices.filter((n) => now - n.at <= CUT_MAX_AGE);
      const where = await locateNotices(recent, geocoder, REGION['la-rioja']);
      return { sourceTime: updated, events: eventsFrom('emergencias-la-rioja', recent, where, 'la-rioja', now, maxAge, { wholeNotice: true }) };
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

/** @param {{ http: import('../http/http-client.js').HttpClient, geocoder: import('../../../application/ports.js').GeocoderPort }} deps */
export function createCyl112Source({ http, geocoder }) {
  // El feed sólo trae la última incidencia: se guardan las de las últimas horas para que no
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
      const now = Date.now();
      const { notices: latest, updated } = parseCyl112(await http.text(CYL, { timeout: 30_000 }));
      for (const n of latest) kept.set(n.id, n);
      for (const [id, n] of kept) if (now - n.at > CUT_MAX_AGE) kept.delete(id);
      const notices = [...kept.values()];
      const where = await locateNotices(notices, geocoder, REGION['castilla-y-leon']);
      return { sourceTime: updated, events: eventsFrom('emergencias-castilla-y-leon', notices, where, 'castilla-y-leon', now, maxAge, { wholeNotice: true }) };
    },
  };
}
