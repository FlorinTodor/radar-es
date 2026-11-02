// Red Eléctrica (REData): demanda peninsular real frente a prevista, cada 5 minutos. Sin clave.
// Condiciones de REE (aviso legal, apartado 5.1): uso informativo y sin fines comerciales, citándola
// como fuente y con la fecha del dato. La métrica lleva las dos (`credit` y `at`) porque la API
// (/api/metrics, /api/live, /api/snapshot) la redistribuye tal cual.
import { GRID_METRICS } from '../../../domain/alerts/rules.js';

const CREDIT = 'Fuente: Red Eléctrica';
// El día de hoy en Madrid (AAAA-MM-DD), con el reloj de la fuente: el de parse.js lee la hora del sistema.
const MADRID_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' });

/**
 * Respuesta de REData → último dato real y la previsión para ese mismo momento. Sólo lo que muestra
 * la web (panels.js: demanda, desviación y hora) y lo que usa la regla gridDemandDrop: cada lectura
 * viaja en cada /api/live, y una serie que nadie dibuja sólo la engorda.
 * @returns {{ demandMW: number|null, forecastMW: number|null, deviation: number|null, at: number|null, credit: string }}
 */
export function parseReeDemand(d) {
  const series = Object.fromEntries((d?.included ?? []).map((s) => [s.type, s.attributes?.values ?? []]));
  const real = (series.Real ?? []).filter((v) => Number.isFinite(v?.value) && Number.isFinite(Date.parse(v.datetime)));
  const forecast = new Map((series.Prevista ?? []).map((v) => [v.datetime, v.value]));
  const last = real.at(-1);
  const expected = last ? forecast.get(last.datetime) : undefined;
  const forecastMW = Number.isFinite(expected) ? expected : null;
  return {
    demandMW: last ? last.value : null,
    forecastMW,
    // Sin previsión (o con una previsión de 0) no hay desviación que calcular.
    deviation: last && forecastMW ? (last.value - forecastMW) / forecastMW : null,
    at: last ? Date.parse(last.datetime) : null,
    credit: CREDIT,
  };
}

/** @param {{ http: import('../http/http-client.js').HttpClient, now?: () => number }} deps */
export function createReeSource({ http, now = Date.now }) {
  const urlAt = (t) => {
    const day = MADRID_DAY.format(t);
    return `https://apidatos.ree.es/es/datos/demanda/demanda-tiempo-real?start_date=${day}T00:00&end_date=${day}T23:59&time_trunc=hour`;
  };
  return {
    // La regla de la demanda peninsular lee la métrica por este id: lo fija el dominio.
    id: GRID_METRICS.peninsular,
    name: 'Red Eléctrica: demanda peninsular en tiempo real',
    kind: 'metrics',
    interval: 300_000,
    license: 'Fuente: Red Eléctrica (REData). Uso informativo, sin fines comerciales',
    // Su aviso legal pide enlazar sólo a la portada, no a la API.
    page: 'https://www.ree.es/',
    get url() {
      return urlAt(now());
    },
    async fetch() {
      const metrics = parseReeDemand(await http.json(urlAt(now())));
      return { sourceTime: metrics.at, metrics };
    },
  };
}
