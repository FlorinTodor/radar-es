// Lo que se avisa a quien sigue una provincia, además de los avisos de AEMET, los terremotos y los avisos oficiales
// (provincias.js, eventInProvince):
// - los posibles apagones que el motor de alertas ve en la demanda eléctrica de los sistemas aislados (cada isla o
//   grupo de islas de Canarias, Ceuta y Melilla: domain/alerts/rules.js, isolatedGridBlackouts), en la provincia
//   de sus islas. De Baleares no hay: Red Eléctrica no publica su demanda real en tiempo real;
// - y, para quien los pide («/provincia Granada incendios»), los focos de calor por satélite (NASA FIRMS) que
//   pueden ser un incendio: sólo los más claros, agrupados y como mucho un aviso por zona y día.
// Los textos, en el idioma de quien los recibe (`tr`, de idioma.js; en español si no se dice): los de las alertas
// de nuestro servidor, con las plantillas de la web (en-servidor.js); la atribución, tal cual.
// Puro: sin red, ni reloj, ni disco (la hora llega en `now`).
import { PROVINCIAS_ES, plainName, provinceById, provinceOfPoint } from '../provincias.js';
import { CALOR_FIJO, SISTEMAS_AISLADOS } from '../lugares.js';
import { distanceKm } from '../geo.js';
import { DEFAULT_THRESHOLDS } from '../alerts/thresholds.js';
import { REE_CREDIT } from '../alerts/rules.js';
import { SEVERITY_RANK } from '../model.js';
import { ES } from './idioma.js';

const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const madridDay = (ms) => MADRID_DAY.format(ms);

// ---------- Apagones de los sistemas eléctricos aislados ----------

/** Las alertas de un sistema aislado llevan este id y el del sistema (rules.js). */
const GRID_PREFIX = 'red-aislada:';
/** Lo que pide el aviso legal de Red Eléctrica: citarla como fuente (la hora del dato va en el texto de la alerta). */
const GRID_CREDIT = REE_CREDIT;
/** La gravedad más alta (un apagón total; el parcial, por debajo). */
const TOP_SEVERITY = Math.max(...Object.values(SEVERITY_RANK));

const samePlace = (a, b) => plainName(a) === plainName(b);
/** Las provincias a las que da luz un sistema: las de sus islas (o la ciudad: Ceuta, Melilla); si no, por dónde está. */
function gridProvinceIds(system) {
  const ids = PROVINCIAS_ES.filter((p) => system.places.some((place) => samePlace(p.name, place)
    || p.circles.some((c) => c.name && samePlace(c.name, place)))).map((p) => p.id);
  if (ids.length) return ids;
  const p = provinceOfPoint(system.lat, system.lon);
  return p ? [p.id] : [];
}
const GRID_PROVINCES = new Map(SISTEMAS_AISLADOS.map((s) => [s.id, gridProvinceIds(s)]));

/** ¿Se ven los apagones de esta provincia en la demanda de sus sistemas aislados? (Canarias, Ceuta, Melilla) */
export const hasIsolatedGrid = (provinceId) => [...GRID_PROVINCES.values()].some((ids) => ids.includes(provinceId));

/**
 * Los posibles apagones de una provincia: las alertas abiertas de sus sistemas aislados, con su texto (la demanda,
 * la hora del dato y que es una estimación de Radar España con datos de Red Eléctrica) y su atribución. Un hecho
 * por alerta y nivel: si un corte parcial pasa a total, se vuelve a avisar; si un apagón total se queda en parcial
 * al volver la luz, no (el parcial va callado, como los escalones de un retraso). Sin la hora de la alerta en el
 * id: tras un reinicio o un relevo la alerta se vuelve a abrir y no es un apagón nuevo. Su título y su texto los
 * escribe el motor de alertas: en otro idioma, con las plantillas de la web (tr.server).
 * @param {Array<{ id: string, severity: string, title: string, description: string, credit?: string, lat?: number, lon?: number }>} alerts
 * @param {string} provinceId
 * @param {import('./idioma.js').Translator} [tr]
 */
export function gridFacts(alerts, provinceId, tr = ES) {
  const out = [];
  for (const a of alerts ?? []) {
    if (typeof a?.id !== 'string' || !a.id.startsWith(GRID_PREFIX)) continue;
    const ids = GRID_PROVINCES.get(a.id.slice(GRID_PREFIX.length)) ?? [provinceOfPoint(a.lat, a.lon)?.id];
    if (!ids.includes(provinceId)) continue;
    const total = SEVERITY_RANK[a.severity] === TOP_SEVERITY;
    const fact = { id: `${a.id}|${total ? 'total' : 'parcial'}`, kind: 'apagon', text: `${tr.server(a.title)}. ${tr.server(a.description)}`, credit: a.credit ?? GRID_CREDIT };
    out.push(fact);
    if (total) out.push({ ...fact, id: `${a.id}|parcial`, silent: true });
  }
  return out;
}

// ---------- Focos de calor por satélite ----------

/**
 * Cuándo unos focos de calor son un aviso. Un foco no es un incendio confirmado: también lo dan las quemas
 * agrícolas (muchas y flojas), la industria (siempre en el mismo sitio) y, en Canarias, los volcanes.
 */
export const FIRE_RULES = Object.freeze({
  // Sólo focos de confianza alta (VIIRS: un píxel saturado, la anomalía de calor más fuerte) y de 10 MW o más de
  // potencia radiativa: las quemas agrícolas suelen quedarse por debajo, y el adaptador ya llama «media» a esa
  // potencia (firms.js).
  minFrp: 10,
  // Un grupo es aviso si su foco más fuerte llega a 30 MW o junta 3 focos: lo que el motor de alertas llama
  // gravedad «alta» en un posible incendio cerca de trenes (rules.js, firesNearTrains).
  strongFrp: 30,
  minFocos: 3,
  // Focos a menos de esto (encadenados) son el mismo grupo: el criterio del motor de alertas.
  clusterKm: DEFAULT_THRESHOLDS.fireClusterKm,
  // La zona de un aviso: una casilla de este tamaño en grados (unos 25 km). Como mucho un aviso por zona y día, y
  // por eso sólo cuentan los focos de hoy (hora peninsular), no los de las últimas 12 horas como en el motor de
  // alertas: ver fireZones. El satélite pasa de madrugada y a primera hora de la tarde: no se pierde ninguno.
  zoneDeg: 0.25,
});

/**
 * Fuentes de calor fijas que el satélite ve a menudo y no son incendios (refinerías, siderurgias y los volcanes de
 * Canarias): un foco dentro no cuenta. La lista, con sus nombres, en domain/lugares.js (CALOR_FIJO).
 */
export const STATIC_HEAT = CALOR_FIJO;
const isStaticHeat = (e) => STATIC_HEAT.some((s) => distanceKm(s.lat, s.lon, e.lat, e.lon) <= s.km);

const byStartThenId = (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Grupos de focos encadenados a menos de `km`, con una rejilla para no medir cada foco con todos. */
function chainGroups(focos, km) {
  const latDeg = km / 110;
  const lonDeg = km / 75; // 1° de longitud son 80 km a 44° N: la casilla nunca es más estrecha que `km`
  const cellOf = (f) => [Math.floor(f.lat / latDeg), Math.floor(f.lon / lonDeg)];
  const cells = new Map();
  focos.forEach((f, i) => {
    const k = cellOf(f).join(':');
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(i);
  });
  const group = new Array(focos.length).fill(-1);
  const groups = [];
  for (let i = 0; i < focos.length; i++) {
    if (group[i] >= 0) continue;
    const members = [i];
    group[i] = groups.length;
    for (let m = 0; m < members.length; m++) {
      const a = focos[members[m]];
      const [y, x] = cellOf(a);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of cells.get(`${y + dy}:${x + dx}`) ?? []) {
            if (group[j] >= 0 || distanceKm(a.lat, a.lon, focos[j].lat, focos[j].lon) > km) continue;
            group[j] = groups.length;
            members.push(j);
          }
        }
      }
    }
    groups.push(members.sort((p, q) => p - q).map((m) => focos[m]));
  }
  return groups;
}

/**
 * @typedef {object} FireZone  Uno o varios grupos de focos de una misma zona y día: un aviso.
 * @property {string} zone        «<día del primer foco>|<casilla>»: el id del aviso.
 * @property {number} focos       Cuántos focos.
 * @property {number} maxFrp      La potencia del más fuerte (MW).
 * @property {number} lat         Dónde está el más fuerte.
 * @property {number} lon
 * @property {number} last        Cuándo se detectó el último.
 * @property {string[]} provinces Las provincias en las que caen sus focos.
 * @property {object} strongest   El suceso del foco más fuerte (para su fuente y su atribución).
 */

// Los avisos de cada lista de sucesos (la de una ronda), a una hora: el parte y /estado de muchos chats en la misma
// ronda los piden con la misma lista.
const ZONES = new WeakMap();

/**
 * Los focos de calor que son un aviso, por zona. Sólo los de confianza alta y de `minFrp` o más, fuera de las
 * fuentes de calor fijas (STATIC_HEAT) y de hoy (hora de Madrid); encadenados a menos de `clusterKm`, y de cada
 * grupo sólo los que tienen un foco de `strongFrp` o `minFocos` focos.
 *
 * Como mucho un aviso por zona y día: la zona de un grupo es el día y la casilla de su primer foco, y los focos de
 * hoy cuentan hasta medianoche, así que en todo el día el primero de un grupo no cambia aunque el fuego crezca o se
 * mueva, ni desaparece para volver horas después como nuevo; si dos grupos se juntan, su zona es la de uno de los
 * dos. Dos grupos de la misma zona son un solo aviso. Al día siguiente, si sigue ardiendo, es otro aviso.
 * @param {object[]} events  los sucesos en vigor (los de FIRMS: category 'incendio', con frp y confidence)
 * @param {number} now
 * @returns {FireZone[]}
 */
export function fireZones(events, now, rules = FIRE_RULES) {
  const cached = ZONES.get(events);
  if (cached?.now === now && cached.rules === rules) return cached.zones;
  const today = madridDay(now);
  const byId = new Map();
  for (const e of events ?? []) {
    if (e?.category !== 'incendio' || e.withdrawn || e.confidence !== 'alta' || !(e.frp >= rules.minFrp)) continue;
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon) || !Number.isFinite(e.start) || e.start > now) continue;
    if (madridDay(e.start) !== today) continue;
    if (byId.has(e.id) || isStaticHeat(e)) continue; // los dos ficheros de FIRMS (Europa y África) se solapan
    byId.set(e.id, e);
  }
  const zones = new Map();
  for (const list of chainGroups([...byId.values()].sort(byStartThenId), rules.clusterKm)) {
    const strongest = list.reduce((max, f) => (f.frp > max.frp ? f : max));
    if (strongest.frp < rules.strongFrp && list.length < rules.minFocos) continue;
    const first = list[0];
    const zone = `${madridDay(first.start)}|${Math.floor(first.lat / rules.zoneDeg)}:${Math.floor(first.lon / rules.zoneDeg)}`;
    const provinces = list.map((f) => provinceOfPoint(f.lat, f.lon)?.id).filter(Boolean);
    const last = Math.max(...list.map((f) => f.start));
    const had = zones.get(zone);
    if (!had) {
      zones.set(zone, { zone, focos: list.length, maxFrp: strongest.frp, lat: strongest.lat, lon: strongest.lon, last, provinces: [...new Set(provinces)], strongest });
      continue;
    }
    had.focos += list.length;
    had.last = Math.max(had.last, last);
    had.provinces = [...new Set([...had.provinces, ...provinces])];
    if (strongest.frp > had.maxFrp) Object.assign(had, { maxFrp: strongest.frp, lat: strongest.lat, lon: strongest.lon, strongest });
  }
  const out = [...zones.values()];
  if (events) ZONES.set(events, { now, rules, zones: out });
  return out;
}

/**
 * Un aviso de focos lleva en su id el día de su zona («…|incendio|2026-11-10|…»): se recuerda más de un día aunque
 * deje de verse un rato (un fallo de la fuente, un paso del satélite sin nada), para que nunca vuelva a avisar de la
 * misma zona el mismo día. Al día siguiente su id ya es otro.
 */
export const DAY_FACT_FORGET_MS = 26 * 3600_000;
/** ¿Es de un aviso de focos esta clave del registro de lo avisado («<suscripción>|<id del hecho>»)? */
export const isDayFact = (key) => /^prov:[a-z0-9-]+\|incendio\|/.test(key);

const coord = (x) => x.toFixed(4);
/** Un enlace al mapa de OpenStreetMap en ese punto (sólo un enlace: no se carga nada hasta pulsarlo). */
const mapLink = (lat, lon) => `https://www.openstreetmap.org/?mlat=${coord(lat)}&mlon=${coord(lon)}#map=13/${coord(lat)}/${coord(lon)}`;

/**
 * Los avisos de focos de calor de una provincia: uno por zona, diciendo siempre que es una detección por satélite
 * y no un incendio confirmado, qué más puede ser y dónde.
 * @param {FireZone[]} zones  de fireZones
 * @param {string} provinceId
 * @param {(e: object) => string|null} [creditOf]  la atribución de la fuente de un foco
 * @param {import('./idioma.js').Translator} [tr]  el idioma del texto (el mismo id en todos)
 */
export function fireFacts(zones, provinceId, creditOf = () => null, tr = ES) {
  const { t } = tr;
  const p = provinceById(provinceId);
  // En Canarias, un volcán también da calor (los conocidos ya no cuentan: STATIC_HEAT).
  const also = plainName(p?.region ?? '') === 'canarias' ? t('una quema agrícola, actividad volcánica o una fuente de calor industrial')
    : t('una quema agrícola o una fuente de calor industrial');
  return (zones ?? []).filter((z) => z.provinces.includes(provinceId)).map((z) => {
    const at = { mw: Math.round(z.maxFrp), when: tr.when(z.last), n: z.focos };
    const what = z.focos === 1 ? t('un foco de calor de {mw} MW, detectado el {when}', at)
      : t('{n} focos de calor en la zona, el más fuerte de {mw} MW; el último, detectado el {when}', at);
    return {
      id: `incendio|${z.zone}`,
      kind: 'incendio',
      text: t('Posible incendio: {what}. Es una detección por satélite, no un incendio confirmado: también puede ser {also}. Dónde: {map}',
        { what, also, map: mapLink(z.lat, z.lon) }),
      credit: creditOf(z.strongest),
    };
  });
}

// ---------- Lo que se pide al seguir una provincia ----------

// También en inglés, para quien escribe así: «Granada fires», «fires in Granada», «Granada no fires».
const FIRE_WORDS = '(?:incendios?|fuegos?|focos?(?:\\s+de\\s+calor)?|(?:wild)?fires?|hotspots?)';
const WITHOUT_FIRES = new RegExp(`^(.+?)\\s+(?:sin|without|no)\\s+${FIRE_WORDS}$`, 'iu');
const WITH_FIRES = new RegExp(`^(.+?)\\s+(?:con\\s+|y\\s+|with\\s+|and\\s+)?${FIRE_WORDS}$`, 'iu');
const FIRES_FIRST = new RegExp(`^${FIRE_WORDS}\\s+(?:en\\s+|de\\s+|in\\s+)?(.+)$`, 'iu');
// Sólo los focos, sin la provincia («incendios», «sin incendios», «no fires»).
const ONLY_FIRES = new RegExp(`^(?:(sin|without|no)\\s+|(?:con|with)\\s+)?${FIRE_WORDS}$`, 'iu');

/**
 * Lo que se pide con /provincia: la provincia y si quiere los focos de calor («Granada incendios», «incendios en
 * Granada», «Granada fires»: true; «Granada sin incendios», «Granada no fires»: false; sólo la provincia: null, lo
 * que ya tuviera). Sólo los focos, sin la provincia («incendios», «sin incendios»): `place` vacío.
 * @param {string} arg
 * @returns {{ place: string, fires: boolean|null }}
 */
export function provinceOption(arg) {
  const t = String(arg ?? '').trim();
  let m = ONLY_FIRES.exec(t);
  if (m) return { place: '', fires: !m[1] };
  m = WITHOUT_FIRES.exec(t);
  if (m) return { place: m[1], fires: false };
  m = WITH_FIRES.exec(t) ?? FIRES_FIRST.exec(t);
  if (m) return { place: m[1], fires: true };
  return { place: t, fires: null };
}

/**
 * Lo que se añade a la respuesta al seguir una provincia: los apagones de sus islas, si los tiene, y los focos de
 * calor (que los tendrá o cómo pedirlos), en el idioma del chat.
 * @param {{ id: string, name: string, circles: object[] }} p
 * @param {{ fires: boolean, tr?: import('./idioma.js').Translator }} opts
 */
export function provinceExtrasText(p, { fires, tr = ES }) {
  const { t } = tr;
  const grid = hasIsolatedGrid(p.id);
  const province = p.name;
  const firesText = t('de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio '
    + 'confirmado. Para quitarlos: /provincia {province} sin incendios', { province });
  return [
    grid ? (p.circles.length > 1
      ? t('También te aviso de los posibles apagones que se ven en la demanda eléctrica de cada isla (una estimación de Radar España con datos de Red Eléctrica).')
      : t('También te aviso de los posibles apagones que se ven en la demanda eléctrica de {province} (una estimación de Radar España con datos de Red Eléctrica).',
        { province })) : null,
    fires ? `${grid ? t('Y') : t('También te aviso')} ${firesText}`
      : t('Si quieres también los focos de calor que detecta el satélite (posibles incendios, sin confirmar): /provincia {province} incendios', { province }),
  ].filter(Boolean).join(' ');
}

/**
 * Los hechos de una provincia que se cuentan a un chat: sin los callados y, si no los ha pedido, sin los focos de
 * calor.
 * @param {Array<{ kind: string, silent?: boolean }>} facts
 */
export const provinceFacts = (facts, { fires = false } = {}) => (facts ?? []).filter((f) => !f.silent && (fires || f.kind !== 'incendio'));
