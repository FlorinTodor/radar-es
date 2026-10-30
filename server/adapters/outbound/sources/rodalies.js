// Rodalies de Catalunya (API pública de su app): cancelaciones y avisos de servicio por tren.
// No publica incidencias por línea, así que se consultan las salidas de unas pocas estaciones
// nodales, que entre todas cubren casi todos los trenes en circulación.
import { madridLocalToMs } from './parse.js';

const BASE = 'https://serveisgrs.rodalies.gencat.cat/api';
// Sants, França, L'Hospitalet, Granollers Centre, Manresa, Sant Vicenç de Calders, Mataró, Terrassa Nord.
const HUBS = ['71801', '79400', '72305', '79100', '78600', '71600', '79500', '78700'];
const STATIONS_TTL_MS = 24 * 3600_000;

// Observaciones que indican una alteración del servicio (y no información comercial).
const DISRUPTION = /carretera|autob[uú]s|\bbus\b|suprim|cancel|anul|incid|aver[ií]a|obres|obras|interromp|interrump|tall|limitad|desv/i;
const SEVERE = /suprim|cancel|anul|interromp|interrump|tall/i;

/** @param {{ http: import('../http/http-client.js').HttpClient, log: import('../../../application/ports.js').LoggerPort }} deps */
export function createRodaliesSource({ http, log }) {
  let stations = new Map();
  let stationsAt = 0;

  async function loadStations() {
    if (stations.size && Date.now() - stationsAt < STATIONS_TTL_MS) return;
    const d = await http.json(`${BASE}/stations?limit=500&lang=es`);
    stations = new Map((d.included ?? []).map((s) => [s.id, { name: s.name, lat: s.latitude, lon: s.longitude }]));
    stationsAt = Date.now();
  }

  return {
    id: 'rodalies',
    name: 'Rodalies de Catalunya: cancelaciones y avisos por tren',
    kind: 'events',
    interval: 180_000,
    url: `${BASE}/departures`,
    license: 'Rodalies de Catalunya (API pública de su app)',
    async fetch() {
      await loadStations();
      const trains = new Map();
      for (const hub of HUBS) {
        try {
          const d = await http.json(`${BASE}/departures?stationId=${hub}&minute=60&fullResponse=true&lang=es`);
          for (const t of d.trains ?? []) trains.set(`${t.commercialNumber}:${t.launchingDate}`, t);
        } catch (err) {
          log.warn(`[rodalies] estación ${hub}: ${err.message}`);
        }
      }

      const events = [];
      const notices = new Map(); // línea + texto → aviso agrupado
      for (const t of trains.values()) {
        const line = t.line?.id ?? '?';
        const at = stations.get(t.nextStation?.id) ?? stations.get(t.originStation?.id);
        if (t.trainCancelled) {
          events.push({
            id: `rodalies:cancelado:${t.commercialNumber}:${t.launchingDate}`,
            category: 'ferroviario',
            type: 'cancelacion',
            severity: 'alta',
            title: `Rodalies ${line} · tren ${t.commercialNumber} cancelado`,
            description: `${t.originStation?.name ?? '?'} → ${t.destinationStation?.name ?? '?'}, salida ${t.originDateHour?.slice(11, 16) ?? '?'}.`,
            lat: at?.lat ?? null,
            lon: at?.lon ?? null,
            start: madridLocalToMs(t.originDateHour),
          });
        }
        const texts = [t.trainObservations, ...(t.stations ?? []).map((s) => s.stationObservations)].filter((x) => x && DISRUPTION.test(x));
        for (const text of new Set(texts)) {
          const key = `${line}:${text.trim().toLowerCase()}`;
          const notice = notices.get(key) ?? { line, text: text.trim(), trains: [], at };
          notice.trains.push(t.commercialNumber);
          notices.set(key, notice);
        }
      }
      for (const [key, n] of notices) {
        events.push({
          id: `rodalies:aviso:${key}`,
          category: 'ferroviario',
          type: 'aviso',
          severity: SEVERE.test(n.text) ? 'alta' : 'media',
          title: `Aviso Rodalies · ${n.line}`,
          description: `${n.text} (trenes ${n.trains.slice(0, 6).join(', ')}${n.trains.length > 6 ? '…' : ''})`,
          lat: n.at?.lat ?? null,
          lon: n.at?.lon ?? null,
          start: null,
        });
      }
      return { events };
    },
  };
}
