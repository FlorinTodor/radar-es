// AEMET: avisos meteorológicos en CAP con el polígono de cada zona (sin clave).
// El RSS lista los CAP vigentes; cada CAP es inmutable, así que sólo se descargan los nuevos.
import { arr, num, text, xmlParser } from './parse.js';
import { roughCentroid } from '../../../domain/geo.js';

const RSS = 'https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml';
const LEVELS = { yellow: 'amarillo', orange: 'naranja', red: 'rojo' };
const SEVERITY = { amarillo: 'media', naranja: 'alta', rojo: 'muy alta' };

/** "lat,lon lat,lon ..." (CAP) → anillo GeoJSON [[lon, lat], ...] cerrado. */
function ring(polygon) {
  const pts = polygon.trim().split(/\s+/).map((p) => p.split(',').map(Number)).filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon)).map(([lat, lon]) => [lon, lat]);
  if (pts.length && (pts[0][0] !== pts.at(-1)[0] || pts[0][1] !== pts.at(-1)[1])) pts.push(pts[0]);
  return pts;
}

function parseCap(xml) {
  const alert = xmlParser.parse(xml).alert ?? {};
  if (text(alert.msgType) === 'Cancel') return [];
  const infos = arr(alert.info);
  const info = infos.find((i) => text(i.language)?.startsWith('es')) ?? infos[0];
  if (!info) return [];

  const params = Object.fromEntries(arr(info.parameter).map((p) => [text(p.valueName), text(p.value)]));
  // AEMET usa "AEMET-Meteoalerta nivel: amarillo"; MeteoAlarm, "awareness_level: 2; yellow; Moderate".
  const aemetLevel = params['AEMET-Meteoalerta nivel']?.trim().toLowerCase();
  const level = SEVERITY[aemetLevel] ? aemetLevel : LEVELS[(params.awareness_level ?? '').split(';')[1]?.trim()];
  if (!level) return []; // nivel verde = sin aviso
  // "Aviso de tormentas de nivel amarillo" → "tormentas"
  const phenomenon = (text(info.event) ?? 'fenómenos adversos').replace(/^aviso (de|por)\s+/i, '').replace(/\s+de nivel \w+$/i, '');

  return arr(info.area).flatMap((area, i) => {
    const rings = arr(area.polygon).map((p) => ring(text(p) ?? '')).filter((r) => r.length >= 4);
    if (!rings.length) return [];
    const geometry = rings.length === 1 ? { type: 'Polygon', coordinates: [rings[0]] } : { type: 'MultiPolygon', coordinates: rings.map((r) => [r]) };
    const center = roughCentroid(geometry);
    const areaName = text(area.areaDesc) ?? '';
    return [{
      id: `aemet:${text(alert.identifier)}:${i}`,
      category: 'meteo',
      type: phenomenon,
      level,
      severity: SEVERITY[level],
      title: `Aviso ${level} por ${phenomenon} · ${areaName}`,
      description: text(info.description) ?? '',
      area: areaName,
      lat: num(center.lat),
      lon: num(center.lon),
      issued: Date.parse(text(alert.sent)) || null, // AEMET pide mostrar la fecha de emisión
      start: Date.parse(text(info.onset) ?? text(info.effective)) || null,
      end: Date.parse(text(info.expires)) || null,
      geometry,
      url: text(info.web),
    }];
  });
}

/** @param {{ http: import('../http/http-client.js').HttpClient, log: import('../../../application/ports.js').LoggerPort }} deps */
export function createAemetAvisosSource({ http, log }) {
  const cache = new Map(); // URL del CAP → eventos

  return {
    id: 'aemet-avisos',
    name: 'AEMET avisos meteorológicos (CAP con polígonos)',
    kind: 'events',
    interval: 600_000,
    url: RSS,
    license: 'Fuente: AEMET',
    async fetch() {
      const rss = xmlParser.parse(await http.text(RSS));
      const links = arr(rss.rss?.channel?.item).map((it) => text(it.link)).filter(Boolean);
      const current = new Set(links);
      for (const url of cache.keys()) if (!current.has(url)) cache.delete(url);

      const missing = links.filter((url) => !cache.has(url));
      for (let i = 0; i < missing.length; i += 4) {
        await Promise.all(missing.slice(i, i + 4).map(async (url) => {
          try {
            cache.set(url, parseCap(await http.text(url)));
          } catch (err) {
            log.warn(`[aemet-avisos] ${url.split('/').pop()}: ${err.message}`);
          }
        }));
      }
      const now = Date.now();
      return { events: [...cache.values()].flat().filter((e) => !e.end || e.end > now) };
    },
  };
}
