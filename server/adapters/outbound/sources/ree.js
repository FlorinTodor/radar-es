// Red Eléctrica (REData): demanda peninsular real frente a prevista, cada 5 minutos. Sin clave.
import { madridToday } from './parse.js';

/** @param {{ http: import('../http/http-client.js').HttpClient }} deps */
export function createReeSource({ http }) {
  return {
    id: 'ree',
    name: 'Red Eléctrica: demanda peninsular en tiempo real',
    kind: 'metrics',
    interval: 300_000,
    license: 'Fuente: Red Eléctrica (REData). Uso informativo, sin fines comerciales',
    get url() {
      const day = madridToday();
      return `https://apidatos.ree.es/es/datos/demanda/demanda-tiempo-real?start_date=${day}T00:00&end_date=${day}T23:59&time_trunc=hour`;
    },
    async fetch() {
      const d = await http.json(this.url);
      const series = Object.fromEntries((d.included ?? []).map((s) => [s.type, s.attributes?.values ?? []]));
      const real = series.Real ?? [];
      const forecast = new Map((series.Prevista ?? []).map((v) => [v.datetime, v.value]));
      const last = real.at(-1);
      const expected = last ? forecast.get(last.datetime) ?? null : null;
      return {
        metrics: {
          demandMW: last?.value ?? null,
          forecastMW: expected,
          deviation: last && expected ? (last.value - expected) / expected : null,
          at: last ? Date.parse(last.datetime) : null,
          // Últimas 3 h (muestras de 5 min) para el gráfico del panel.
          history: real.slice(-36).map((v) => ({ t: Date.parse(v.datetime), real: v.value, forecast: forecast.get(v.datetime) ?? null })),
        },
      };
    },
  };
}
