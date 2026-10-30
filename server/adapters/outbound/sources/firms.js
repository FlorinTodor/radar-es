// NASA FIRMS: focos de calor detectados por el satélite NOAA-20 (VIIRS) en las últimas
// 24 h. CSV públicos sin clave; el de Europa no llega a Canarias, por eso se añade el de África.
// Un foco no siempre es un incendio: también detecta industrias, quemas agrícolas, etc.

const BASE = 'https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv';
const FILES = [`${BASE}/J1_VIIRS_C2_Europe_24h.csv`, `${BASE}/J1_VIIRS_C2_Northern_and_Central_Africa_24h.csv`];

// Península (con Portugal y la franja pirenaica francesa), Baleares y Canarias.
const AREAS = [
  { latMin: 35.8, latMax: 43.9, lonMin: -9.6, lonMax: 4.5 },
  { latMin: 27.4, latMax: 29.6, lonMin: -18.3, lonMax: -13.2 },
];
// El recuadro peninsular roza la costa de Argelia: al sur de 37° N no hay territorio español al este de -1,6° (Cabo de Gata).
const isAlgeria = (lat, lon) => lat < 37 && lon > -1.6;
const inSpain = (lat, lon) => !isAlgeria(lat, lon) && AREAS.some((a) => lat >= a.latMin && lat <= a.latMax && lon >= a.lonMin && lon <= a.lonMax);

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createFirmsSource({ http }) {
  return {
    id: 'firms',
    name: 'NASA FIRMS: focos de calor por satélite (VIIRS)',
    kind: 'events',
    interval: 3_600_000, // el CSV se regenera cada hora
    url: FILES[0],
    license: 'NASA FIRMS (LANCE/ESDIS). No apto para decisiones tácticas',
    async fetch() {
      const events = [];
      for (const url of FILES) {
        const [header, ...lines] = (await http.text(url, { timeout: 60_000 })).trim().split('\n');
        const cols = header.split(',');
        const col = (name) => cols.indexOf(name);
        const [iLat, iLon, iFrp, iConf, iDate, iTime] = ['latitude', 'longitude', 'frp', 'confidence', 'acq_date', 'acq_time'].map(col);
        for (const line of lines) {
          const c = line.split(',');
          const lat = +c[iLat];
          const lon = +c[iLon];
          if (!inSpain(lat, lon) || /^l/i.test(c[iConf])) continue;
          const frp = +c[iFrp] || 0;
          const hhmm = c[iTime].padStart(4, '0');
          const time = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
          events.push({
            id: `firms:${lat.toFixed(4)}:${lon.toFixed(4)}:${c[iDate]}${hhmm}`,
            category: 'incendio',
            type: 'foco',
            severity: frp >= 50 ? 'alta' : frp >= 10 ? 'media' : 'baja',
            title: `Foco de calor de ${Math.round(frp)} MW`,
            description: `Detectado por satélite (VIIRS, NOAA-20) a las ${hhmm.slice(0, 2)}:${hhmm.slice(2)} UTC, confianza ${c[iConf]}. ` +
              'Puede ser un incendio, una quema agrícola o una fuente de calor industrial.',
            frp,
            lat,
            lon,
            start: Number.isNaN(time) ? null : time,
          });
        }
      }
      return { events };
    },
  };
}
