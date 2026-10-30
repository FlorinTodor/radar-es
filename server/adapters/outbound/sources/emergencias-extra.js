// Otras situaciones: caídas de Internet (IODA) y alertas de catástrofes (GDACS). Públicas y sin clave.
import { arr, num, text, xmlParser } from './parse.js';

// Zona de interés: España peninsular, Baleares, Canarias y su entorno inmediato.
const inZone = (lat, lon) => lat >= 26 && lat <= 44.5 && lon >= -19.5 && lon <= 5;

// ---------- Caídas de Internet (IODA, Georgia Tech) ----------
const IODA = 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createIodaSource({ http }) {
  return {
    id: 'ioda',
    name: 'IODA: caídas de conectividad a Internet en España',
    kind: 'events',
    interval: 600_000,
    url: IODA,
    license: 'IODA · Georgia Tech (Internet Outage Detection and Analysis)',
    async fetch() {
      const until = Math.floor(Date.now() / 1000);
      const from = until - 24 * 3600;
      const [country, regions] = await Promise.all([
        http.json(`${IODA}?entityType=country&entityCode=ES&from=${from}&until=${until}`),
        http.json(`${IODA}?entityType=region&relatedTo=country/ES&from=${from}&until=${until}`),
      ]);
      const events = [...(country.data ?? []), ...(regions.data ?? [])].map((o) => ({
        id: `ioda:${o.location}:${o.start}`,
        category: 'internet',
        type: o.datasource ?? 'outage',
        scope: String(o.location).startsWith('country') ? 'country' : 'region',
        severity: String(o.location).startsWith('country') ? 'muy alta' : 'alta',
        title: `Caída de conectividad a Internet · ${o.location_name ?? o.location}`,
        description: `Detectada por IODA (${o.datasource ?? '?'}), puntuación ${Math.round(o.score ?? 0)}, duración ${Math.round((o.duration ?? 0) / 60)} min.`,
        lat: null,
        lon: null,
        start: o.start ? o.start * 1000 : null,
        end: o.start && o.duration ? (o.start + o.duration) * 1000 : null,
      }));
      return { events };
    },
  };
}

// ---------- Catástrofes (GDACS, ONU/Comisión Europea) ----------
const GDACS = 'https://www.gdacs.org/xml/rss.xml';
const GDACS_LEVEL = { Green: 'verde', Orange: 'naranja', Red: 'rojo' };
const GDACS_TYPE = { EQ: 'Terremoto', TC: 'Ciclón tropical', FL: 'Inundación', VO: 'Volcán', DR: 'Sequía', WF: 'Incendio forestal', TS: 'Tsunami' };

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createGdacsSource({ http }) {
  return {
    id: 'gdacs',
    name: 'GDACS: alertas de catástrofes (zona de España)',
    kind: 'events',
    interval: 900_000,
    url: GDACS,
    license: 'GDACS (Naciones Unidas y Comisión Europea)',
    async fetch() {
      const doc = xmlParser.parse(await http.text(GDACS, { timeout: 60_000 }));
      const events = [];
      for (const it of arr(doc.rss?.channel?.item)) {
        const lat = num(text(it.Point?.lat));
        const lon = num(text(it.Point?.long));
        if (lat === null || lon === null || !inZone(lat, lon)) continue;
        const level = GDACS_LEVEL[text(it.alertlevel)] ?? 'verde';
        events.push({
          id: `gdacs:${text(it.eventtype)}:${text(it.eventid)}`,
          category: 'catastrofe',
          type: GDACS_TYPE[text(it.eventtype)] ?? text(it.eventtype),
          level,
          severity: level === 'rojo' ? 'muy alta' : level === 'naranja' ? 'alta' : 'baja',
          title: text(it.title) ?? 'Alerta GDACS',
          description: text(it.description) ?? '',
          lat,
          lon,
          start: Date.parse(text(it.fromdate)) || null,
          end: Date.parse(text(it.todate)) || null,
          url: text(it.link),
        });
      }
      return { events };
    },
  };
}
