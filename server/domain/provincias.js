// Las 50 provincias, Ceuta y Melilla, para avisar a quien sigue una de ellas de lo que pasa en su zona: avisos
// naranja y rojo de AEMET, terremotos que pueden sentirse y avisos oficiales (planes de emergencia y cortes de
// luz). Sin sus límites (pesarían megas): cada provincia es uno o varios círculos de su tamaño (las islas, uno
// por isla), y un punto es de la provincia cuyo círculo le queda más cerca en proporción a su radio. Es una
// aproximación: cerca de una frontera puede tocarle a la vecina, y así se dice en los avisos («en tu zona»).
// Puro: datos fijos y cuentas.
import { distanceKm } from './geo.js';

/**
 * @typedef {{ lat: number, lon: number, km: number, name?: string }} Circle
 * @typedef {{ id: string, name: string, aliases: string[], region: string, regionAliases: string[], circles: Circle[] }} Province
 */

// Radio del círculo de una provincia a partir de su superficie (km²), con un 10 % de margen: las provincias no
// son redondas.
const radius = (areaKm2) => Math.round(Math.sqrt(areaKm2 / Math.PI) * 1.1);
// `extra`: más círculos ([lat, lon, km]) para las provincias alargadas, que con uno solo perderían sus extremos.
const P = (name, lat, lon, area, aliases = [], extra = []) => ({
  name, aliases, circles: [{ lat, lon, km: radius(area) }, ...extra.map(([la, lo, km]) => ({ lat: la, lon: lo, km }))],
});
const islands = (name, list, aliases = []) => ({ name, aliases, circles: list.map(([isla, lat, lon, km]) => ({ name: isla, lat, lon, km })) });

// Comunidad → sus provincias. El nombre de la comunidad es el que usan los avisos oficiales (ver lugares.js,
// COMUNIDADES); los alias, otras formas de escribirla.
const REGIONS = [
  ['Andalucía', [], [
    P('Almería', 37.19, -2.34, 8775, [], [[36.85, -2.75, 25]]), P('Cádiz', 36.55, -5.76, 7436), P('Córdoba', 37.99, -4.78, 13771),
    P('Granada', 37.31, -3.27, 12647), P('Huelva', 37.57, -6.83, 10128), P('Jaén', 37.99, -3.46, 13496),
    P('Málaga', 36.81, -4.59, 7308), P('Sevilla', 37.43, -5.68, 14036),
  ]],
  ['Aragón', [], [P('Huesca', 42.18, -0.07, 15636), P('Teruel', 40.66, -0.82, 14809), P('Zaragoza', 41.62, -1.06, 17274)]],
  ['Principado de Asturias', ['Asturias'], [P('Asturias', 43.29, -5.99, 10604, ['Oviedo'])]],
  ['Illes Balears', ['Islas Baleares', 'Baleares', 'Balears'], [islands('Illes Balears', [
    ['Mallorca', 39.62, 2.98, 50], ['Menorca', 39.95, 4.08, 25], ['Ibiza', 38.98, 1.43, 20], ['Eivissa', 38.98, 1.43, 20],
    ['Formentera', 38.7, 1.45, 10],
  ], ['Islas Baleares', 'Baleares', 'Balears'])]],
  ['Canarias', ['Islas Canarias'], [
    islands('Las Palmas', [['Gran Canaria', 27.96, -15.6, 28], ['Fuerteventura', 28.36, -14.05, 45], ['Lanzarote', 29.04, -13.63, 32],
      ['La Graciosa', 29.25, -13.5, 6]], ['Las Palmas de Gran Canaria']),
    islands('Santa Cruz de Tenerife', [['Tenerife', 28.29, -16.62, 32], ['La Palma', 28.68, -17.86, 25], ['La Gomera', 28.11, -17.23, 14],
      ['El Hierro', 27.74, -18.02, 15]], ['Tenerife', 'S/C de Tenerife']),
  ]],
  ['Cantabria', [], [P('Cantabria', 43.2, -4.03, 5321, ['Santander'])]],
  ['Castilla-La Mancha', ['Castilla La Mancha'], [
    P('Albacete', 38.82, -1.98, 14926, [], [[38.8, -1.25, 30]]), P('Ciudad Real', 38.92, -3.84, 19813), P('Cuenca', 39.9, -2.19, 17141),
    P('Guadalajara', 40.81, -2.62, 12214), P('Toledo', 39.79, -4.15, 15370),
  ]],
  ['Castilla y León', ['Castilla León'], [
    P('Ávila', 40.57, -4.98, 8050), P('Burgos', 42.35, -3.58, 14292, [], [[42.72, -3.1, 25]]), P('León', 42.62, -5.84, 15581),
    P('Palencia', 42.37, -4.54, 8052), P('Salamanca', 40.8, -6.06, 12350), P('Segovia', 41.17, -4.05, 6923),
    P('Soria', 41.62, -2.59, 10306), P('Valladolid', 41.64, -4.85, 8110), P('Zamora', 41.73, -6.05, 10561),
  ]],
  ['Cataluña', ['Catalunya'], [
    P('Barcelona', 41.73, 1.98, 7726), P('Girona', 42.12, 2.67, 5910, ['Gerona']), P('Lleida', 42.05, 1.05, 12172, ['Lérida']),
    P('Tarragona', 41.09, 0.82, 6303),
  ]],
  ['Comunitat Valenciana', ['Comunidad Valenciana', 'C. Valenciana'], [
    P('Alicante', 38.48, -0.57, 5817, ['Alacant']), P('Castellón', 40.2, -0.15, 6636, ['Castelló', 'Castellón de la Plana']),
    P('Valencia', 39.37, -0.78, 10806, ['València']),
  ]],
  ['Extremadura', [], [P('Badajoz', 38.71, -6.14, 21766), P('Cáceres', 39.71, -6.16, 19868)]],
  ['Galicia', [], [
    P('A Coruña', 43.13, -8.42, 7950, ['La Coruña', 'Coruña']), P('Lugo', 43.01, -7.56, 9856),
    P('Ourense', 42.19, -7.62, 7273, ['Orense']), P('Pontevedra', 42.43, -8.48, 4495, ['Vigo']),
  ]],
  ['Comunidad de Madrid', ['Madrid'], [P('Madrid', 40.5, -3.72, 8028, [], [[40.62, -3.75, 38], [40.15, -3.62, 25], [40.95, -3.62, 20], [40.86, -3.9, 15]])]],
  ['Región de Murcia', ['Murcia'], [P('Murcia', 38.0, -1.49, 11313)]],
  ['Comunidad Foral de Navarra', ['Navarra', 'Nafarroa'], [P('Navarra', 42.67, -1.65, 10391, ['Nafarroa', 'Pamplona'], [[42.1, -1.6, 22]])]],
  ['La Rioja', [], [P('La Rioja', 42.27, -2.52, 5045, ['Rioja', 'Logroño'])]],
  ['País Vasco', ['Euskadi'], [
    P('Álava', 42.83, -2.72, 3037, ['Araba']), P('Bizkaia', 43.24, -2.85, 2217, ['Vizcaya']),
    P('Gipuzkoa', 43.14, -2.17, 1980, ['Guipúzcoa'], [[43.28, -1.9, 15]]),
  ]],
  ['Ceuta', [], [{ name: 'Ceuta', aliases: [], circles: [{ lat: 35.889, lon: -5.316, km: 5 }] }]],
  ['Melilla', [], [{ name: 'Melilla', aliases: [], circles: [{ lat: 35.292, lon: -2.938, km: 5 }] }]],
];

/** Sin tildes ni mayúsculas, y lo que no es letra o número, un espacio. */
export const plainName = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9ñ]+/g, ' ').trim();
const slug = (s) => plainName(s).replaceAll(' ', '-');

/** @type {readonly Province[]} */
export const PROVINCIAS_ES = Object.freeze(REGIONS.flatMap(([region, regionAliases, list]) => list.map((p) => Object.freeze({
  id: slug(p.name), name: p.name, aliases: p.aliases, region, regionAliases, circles: p.circles,
}))));

const BY_ID = new Map(PROVINCIAS_ES.map((p) => [p.id, p]));
const BY_NAME = new Map();
for (const p of PROVINCIAS_ES) for (const n of [p.name, ...p.aliases]) if (!BY_NAME.has(plainName(n))) BY_NAME.set(plainName(n), p);

/** Una provincia por su id. */
export const provinceById = (id) => BY_ID.get(id);

/**
 * La provincia que nombra un texto («valencia», «València», «La Coruña», «provincia de Cádiz»); null si no
 * nombra ninguna o es ambiguo.
 */
export function findProvince(text) {
  const t = plainName(text).replace(/^(?:la )?provincia (?:de )?/, '');
  if (!t) return null;
  return BY_NAME.get(t) ?? null;
}

/** Lo cerca que está un punto de una provincia: la distancia a su círculo más cercano partida por su radio (≤ 1: dentro). */
function ratio(p, lat, lon) {
  return Math.min(...p.circles.map((c) => distanceKm(lat, lon, c.lat, c.lon) / c.km));
}

// Hasta dónde se da un punto a la provincia más cercana (en radios): la costa y los bordes quedan algo fuera del círculo.
const MAX_RATIO = 1.6;

/** La provincia en la que (aproximadamente) cae un punto; null si no cae cerca de ninguna (en alta mar, fuera de España). */
export function provinceOfPoint(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  let bestRatio = Infinity;
  for (const p of PROVINCIAS_ES) {
    const r = ratio(p, lat, lon);
    if (r < bestRatio) {
      best = p;
      bestRatio = r;
    }
  }
  return bestRatio <= MAX_RATIO ? best : null;
}

/** Km desde un punto hasta el borde (aproximado) de una provincia; 0 si está dentro. */
export function kmToProvince(p, lat, lon) {
  return Math.max(0, Math.min(...p.circles.map((c) => distanceKm(lat, lon, c.lat, c.lon) - c.km)));
}

/**
 * Hasta dónde puede sentirse un terremoto, en km, por su magnitud: la misma cuenta que la alerta de terremotos
 * cerca de trenes (domain/alerts/rules.js): M3,5 → unos 37 km; M5 → 75 km.
 */
export const feltRadiusKm = (magnitude) => 25 * (magnitude - 2);

const namesRegion = (p, area) => [p.region, ...p.regionAliases].some((n) => plainName(n) === plainName(area));
const namesProvince = (p, area) => [p.name, ...p.aliases].some((n) => plainName(n) === plainName(area));
const namesIsland = (p, area) => p.circles.some((c) => c.name && plainName(c.name) === plainName(area));

/**
 * ¿Es de esta provincia un suceso de zona?
 * - Avisos de AEMET (category 'meteo'), sólo naranja y rojo: por el centro de su zona de aviso.
 * - Terremotos (category 'sismo') de magnitud `quakeMinMagnitude` o más y de las últimas `quakeWindowHours`:
 *   si la provincia queda dentro de lo que pueden sentirse (feltRadiusKm).
 * - Avisos oficiales (category 'emergencia': planes y cortes de luz): por lo que nombran (su comunidad entera,
 *   la provincia o una de sus islas) o, si es un municipio, por dónde está.
 * @param {import('./model.js').IncidentEvent} e
 * @param {Province} p
 * @param {{ now: number, quakeMinMagnitude?: number, quakeWindowHours?: number }} opts
 */
export function eventInProvince(e, p, { now, quakeMinMagnitude = 3.5, quakeWindowHours = 3 }) {
  if (!e || !p) return false;
  if (e.category === 'meteo') {
    if (e.level !== 'naranja' && e.level !== 'rojo') return false;
    return provinceOfPoint(e.lat, e.lon)?.id === p.id;
  }
  if (e.category === 'sismo') {
    if (!(e.magnitude >= quakeMinMagnitude) || !Number.isFinite(e.start) || now - e.start > quakeWindowHours * 3600_000) return false;
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) return false;
    return kmToProvince(p, e.lat, e.lon) <= feltRadiusKm(e.magnitude);
  }
  if (e.category === 'emergencia') {
    if (e.area && e.approx === 'comunidad') return namesRegion(p, e.area);
    if (e.area && e.approx === 'provincia') return namesProvince(p, e.area);
    if (e.area && e.approx === 'isla') return namesIsland(p, e.area);
    if (e.area && (namesRegion(p, e.area) || namesProvince(p, e.area))) return true;
    return provinceOfPoint(e.lat, e.lon)?.id === p.id;
  }
  return false;
}
