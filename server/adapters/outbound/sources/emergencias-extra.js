// Otras situaciones: aviones (ADS-B, con códigos de emergencia), caídas de Internet (IODA)
// y alertas de catástrofes (GDACS). Todas públicas y sin clave.
import { arr, num, text, xmlParser } from './parse.js';

// Zona de interés: España peninsular, Baleares, Canarias y su entorno inmediato.
const inZone = (lat, lon) => lat >= 26 && lat <= 44.5 && lon >= -19.5 && lon <= 5;

// ---------- Aviones (adsb.lol) ----------
// Radios de 150–250 NM que cubren el espacio aéreo español (la API admite hasta 250 NM).
const ADSB_POINTS = [[40.2, -3.7, 250], [41.6, 1.5, 200], [42.6, -7.6, 200], [37.3, -5.5, 200], [39.6, 3.0, 150], [28.3, -15.8, 250]];

/** @param {{ http: import('../http/http-client.js').HttpClient, log: import('../../../application/ports.js').LoggerPort }} deps */
export function createAvionesSource({ http, log }) {
  return {
    id: 'aviones',
    name: 'Aviones en vuelo (ADS-B, adsb.lol)',
    kind: 'vehicles',
    interval: 60_000,
    url: 'https://api.adsb.lol/v2/point',
    license: 'adsb.lol (ODbL 1.0)',
    async fetch() {
      const now = Date.now();
      const byHex = new Map();
      for (const [lat, lon, nm] of ADSB_POINTS) {
        try {
          const d = await http.json(`https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`);
          for (const a of d.ac ?? []) if (Number.isFinite(a.lat) && Number.isFinite(a.lon) && inZone(a.lat, a.lon)) byHex.set(a.hex, a);
        } catch (err) {
          log.warn(`[aviones] ${lat},${lon}: ${err.message}`);
        }
      }
      const vehicles = [...byHex.values()].map((a) => {
        const callsign = a.flight?.trim() || null;
        return {
          id: `avion:${a.hex}`,
          mode: 'avion',
          operator: 'ADS-B',
          service: 'Avión',
          line: null,
          label: callsign ?? a.r ?? a.hex,
          lat: a.lat,
          lon: a.lon,
          delay: null,
          heading: num(a.track ?? a.true_heading),
          altitudeFt: a.alt_baro === 'ground' ? 0 : num(a.alt_baro),
          speedKt: num(a.gs),
          squawk: a.squawk ?? null,
          emergency: a.emergency ?? null,
          aircraftType: a.t ?? null,
          registration: a.r ?? null,
          fixTime: Number.isFinite(a.seen_pos) ? now - a.seen_pos * 1000 : null,
        };
      });
      return { vehicles };
    },
  };
}

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
