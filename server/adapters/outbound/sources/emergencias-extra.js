// Alertas de catástrofes de GDACS (Naciones Unidas y Comisión Europea). Públicas y sin clave.
import { arr, num, text, xmlParser } from './parse.js';

// Zona de interés: España peninsular, Baleares, Canarias y su entorno inmediato.
const inZone = (lat, lon) => lat >= 26 && lat <= 44.5 && lon >= -19.5 && lon <= 5;

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
    license: 'Global Disaster Awareness and Coordination System (GDACS) · CC BY 4.0 · Filtrado a España; no sustituye las alertas oficiales',
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
