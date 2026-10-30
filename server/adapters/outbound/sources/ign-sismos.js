// Instituto Geográfico Nacional: terremotos de los últimos 10 días (GeoRSS). Sin clave.
import { arr, num, text, xmlParser } from './parse.js';

// "Se ha producido un terremoto de magnitud 2.6 en NE SIDI SLIMANE.MAC en la fecha 30/10/2026 1:26:27 en la siguiente localización: ..."
const DESCRIPTION = /magnitud\s+([\d.]+)\s+en\s+(.+?)\s+en la fecha\s+(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)/;

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createIgnSismosSource({ http }) {
  return {
    id: 'ign-sismos',
    name: 'IGN terremotos (últimos 10 días)',
    kind: 'events',
    interval: 180_000,
    url: 'https://www.ign.es/ign/RssTools/sismologia.xml',
    license: 'Instituto Geográfico Nacional',
    async fetch() {
      const rss = xmlParser.parse(await http.text(this.url));
      const events = [];
      for (const it of arr(rss.rss?.channel?.item)) {
        const desc = text(it.description) ?? '';
        const m = desc.match(DESCRIPTION);
        const lat = num(text(it.lat));
        const lon = num(text(it.long));
        if (!m || lat === null || lon === null) continue;
        const [, mag, place, dd, mm, yyyy, hh, mi, ss] = m;
        // Las horas del RSS del IGN están en UTC (contrastado con el EMSC).
        const time = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi, +ss);
        const magnitude = Number(mag);
        events.push({
          id: `ign:${text(it.guid)?.match(/evid=(\w+)/)?.[1] ?? time}`,
          category: 'sismo',
          type: 'terremoto',
          severity: magnitude >= 5 ? 'muy alta' : magnitude >= 4 ? 'alta' : magnitude >= 3 ? 'media' : 'baja',
          title: `Terremoto M${magnitude.toFixed(1)} · ${place}`,
          description: desc,
          magnitude,
          lat,
          lon,
          start: time,
          url: text(it.link),
        });
      }
      return { events };
    },
  };
}
