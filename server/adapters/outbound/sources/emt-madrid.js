// EMT Madrid: avisos de servicio (desvíos por obras, manifestaciones…) del GTFS-RT que publica en el
// NAP, sin clave. Sus posiciones no: el NAP no las tiene, y estimarlas con su horario por frecuencias
// da cifras irreales.
import { decodeFeed } from './gtfs-rt.js';

const ALERTS = 'https://openapi.emtmadrid.es/v1/bus/servicealerts/proto';
const SEVERE_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS']);

const text = (t) => ((t?.translation ?? []).find((x) => !x.language || x.language.startsWith('es')) ?? t?.translation?.[0])?.text?.trim() ?? '';

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createEmtMadridAlertsSource({ http }) {
  return {
    id: 'emt-madrid-avisos',
    name: 'EMT Madrid: avisos de servicio (GTFS-RT)',
    kind: 'events',
    interval: 300_000,
    url: ALERTS,
    license: 'Powered by MITRAMS (Punto de Acceso Nacional) · Powered by EMT de Madrid',
    async fetch() {
      const feed = decodeFeed(await http.bytes(ALERTS));
      const now = Date.now() / 1000;
      const events = new Map(); // el mismo aviso viene repetido por cada línea afectada
      for (const e of feed.entity ?? []) {
        const a = e.alert;
        if (!a) continue;
        const periods = a.activePeriod ?? [];
        const period = periods.find((p) => (!p.start || +p.start <= now) && (!p.end || +p.end >= now));
        if (periods.length && !period) continue;
        const title = text(a.headerText);
        const description = text(a.descriptionText);
        const key = `${title}|${description}|${period?.start ?? ''}`;
        if (events.has(key)) continue;
        events.set(key, {
          id: `emt-madrid:${e.id}`,
          category: 'carretera',
          type: 'aviso',
          severity: SEVERE_EFFECTS.has(a.effect) ? 'alta' : 'media',
          title: title ? `EMT Madrid · ${title}` : 'Aviso EMT Madrid',
          description,
          url: text(a.url) || undefined,
          lat: null,
          lon: null,
          start: period?.start ? +period.start * 1000 : null,
          end: period?.end ? +period.end * 1000 : null,
        });
      }
      return { events: [...events.values()], sourceTime: feed.header?.timestamp ? Number(feed.header.timestamp) * 1000 : null };
    },
  };
}
