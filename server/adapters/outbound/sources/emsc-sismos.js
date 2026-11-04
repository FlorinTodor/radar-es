// EMSC-CSEM SeismicPortal (servicio FDSN event): terremotos de magnitud 1,5 o más de los últimos 10
// días en España y sus alrededores. El RSS del IGN sólo trae los de magnitud 2,6 o más; los pequeños
// (como un enjambre sísmico en Granada) llegan por aquí, la mayoría localizados por el propio IGN.
// Son de respaldo: si el IGN publica el mismo terremoto, se queda el del IGN (domain/sismos.js).
// Licencia CC BY 4.0 (seismicportal.eu/terms.html), con el crédito «EMSC-CSEM SeismicPortal».
import { SPAIN_BOUNDS, widenBounds } from '../../../domain/geo.js';
import { quakeSeverity } from '../../../domain/sismos.js';
import { lookup, num } from './parse.js';

const BASE = 'https://www.seismicportal.eu/fdsnws/event/1/query';
const PAGE = 'https://www.seismicportal.eu';
const DAYS = 10; // los mismos que el RSS del IGN
const MIN_MAGNITUDE = 1.5; // la misma que la lista de últimos terremotos de la web del IGN
const [WEST, SOUTH, EAST, NORTH] = widenBounds(SPAIN_BOUNDS, 1);

// Tipos de suceso: «ke» terremoto confirmado, «se» probable. Las voladuras de canteras y las
// explosiones («qb», «kx»…) no son terremotos.
const QUAKE_TYPES = new Set(['ke', 'se', '']);

// Regiones de Flinn-Engdahl que da el EMSC, en español (las que salen alrededor de España).
const REGION = {
  SPAIN: 'España',
  'CANARY ISLANDS, SPAIN REGION': 'Canarias',
  'BALEARIC ISLANDS, SPAIN': 'Baleares',
  'STRAIT OF GIBRALTAR': 'Estrecho de Gibraltar',
  PYRENEES: 'Pirineos',
  'BAY OF BISCAY': 'Golfo de Vizcaya',
  'WESTERN MEDITERRANEAN SEA': 'Mediterráneo occidental',
  'AZORES-CAPE ST. VINCENT RIDGE': 'Azores-Cabo de San Vicente',
  PORTUGAL: 'Portugal',
  FRANCE: 'Francia',
  'SOUTHERN FRANCE': 'Sur de Francia',
  MOROCCO: 'Marruecos',
  'NORTHERN ALGERIA': 'Norte de Argelia',
  ALGERIA: 'Argelia',
};

// Quién lo ha localizado (campo «auth»).
const AUTHOR = {
  IGN: 'el Instituto Geográfico Nacional (IGN)',
  EMSC: 'el EMSC',
  IPMA: 'el IPMA (Portugal)',
  ReNaSS: 'el ReNaSS (Francia)',
  ICGC: "l'Institut Cartogràfic i Geològic de Catalunya (ICGC)",
};

const fmt = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createEmscSismosSource({ http, now = Date.now }) {
  return {
    id: 'emsc-sismos',
    name: 'EMSC: terremotos pequeños (magnitud 1,5 o más, últimos 10 días)',
    kind: 'events',
    interval: 300_000,
    url: BASE,
    page: PAGE,
    license: 'Credit: EMSC-CSEM SeismicPortal, https://www.seismicportal.eu · CC BY 4.0 · La mayoría, localizados por el Instituto Geográfico Nacional (IGN). Datos preliminares',
    async fetch() {
      const start = new Date(now() - DAYS * 86_400_000).toISOString().slice(0, 19);
      const url = `${BASE}?format=json&starttime=${start}&minmag=${MIN_MAGNITUDE}`
        + `&minlat=${SOUTH}&maxlat=${NORTH}&minlon=${WEST}&maxlon=${EAST}&limit=1000`;
      const doc = await http.json(url, { timeout: 30_000 });
      const events = [];
      for (const f of Array.isArray(doc?.features) ? doc.features : []) {
        const p = f?.properties ?? {};
        const lat = num(p.lat);
        const lon = num(p.lon);
        const magnitude = num(p.mag);
        const start = Date.parse(p.time ?? '');
        const unid = typeof p.unid === 'string' && /^[\w-]{1,40}$/.test(p.unid) ? p.unid : null;
        if (lat === null || lon === null || magnitude === null || !Number.isFinite(start) || !unid) continue;
        if (!QUAKE_TYPES.has(String(p.evtype ?? ''))) continue;
        const region = lookup(REGION, p.flynn_region) ?? titleCase(String(p.flynn_region ?? 'zona sin nombre'));
        const depth = num(p.depth);
        const author = lookup(AUTHOR, p.auth) ?? (typeof p.auth === 'string' ? p.auth.slice(0, 40) : 'una red sísmica');
        events.push({
          id: `emsc:${unid}`,
          category: 'sismo',
          type: 'terremoto',
          severity: quakeSeverity(magnitude),
          title: `Terremoto M${magnitude.toFixed(1)} · ${region}`,
          description: `Terremoto de magnitud ${magnitude.toFixed(1)}${depth !== null ? ` a ${Math.round(Math.abs(depth))} km de profundidad` : ''}`
            + ` (${region}), el ${fmt.format(start)}. Localizado por ${author}; datos del EMSC-CSEM SeismicPortal.`,
          magnitude,
          lat,
          lon,
          start,
          url: `${PAGE}/eventdetails.html?unid=${unid}`,
          backup: true,
        });
      }
      return { events };
    },
  };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s,-])\p{L}/gu, (c) => c.toUpperCase()).slice(0, 60);
