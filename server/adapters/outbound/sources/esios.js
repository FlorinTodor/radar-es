// Red Eléctrica (e·sios, la API del operador del sistema): demanda real y programada, cada 5 minutos,
// de los sistemas eléctricos aislados: cada isla o grupo de islas de Canarias, Ceuta y Melilla.
// REData (ree.js) sólo da en tiempo real la demanda de toda España, donde el apagón de una isla no se
// nota. Pide un token personal gratuito (ESIOS_TOKEN, se envía en una cabecera, nunca en la URL).
// Condiciones de REE (aviso legal, apartado 5.1, que e·sios enlaza como suyo): uso informativo y sin
// fines comerciales, citando la fuente y la fecha del dato. La métrica lleva las dos (`credit` y `at`;
// cada sistema, además, la hora de su dato) porque la API la redistribuye tal cual.
import { GRID_METRICS } from '../../../domain/alerts/rules.js';
import { SISTEMAS_AISLADOS } from '../../../domain/lugares.js';

const BASE = 'https://api.esios.ree.es/indicators';
const REAL = 1740;       // «Demanda real territorios no peninsulares»
const PROGRAMMED = 1741; // «Demanda programada territorios no peninsulares»
const CREDIT = 'Fuente: Red Eléctrica (e·sios)';

// geo_id de e·sios → clave del sistema en el dominio (SISTEMAS_AISLADOS), que lo sitúa en el mapa.
// «Tenerife - La Gomera» (8831) suma dos que ya vienen por separado, y «Baleares» sólo trae la demanda
// programada: ninguno de los dos se usa.
export const ESIOS_SYSTEMS = new Map([
  [8795, 'gran-canaria'], [8796, 'lanzarote-fuerteventura'], [8797, 'tenerife'], [8798, 'la-palma'],
  [8799, 'la-gomera'], [8800, 'el-hierro'], [12, 'ceuta'], [49, 'melilla'],
]);
const nameOf = (id) => SISTEMAS_AISLADOS.find((p) => p.id === id)?.name ?? id;
const CANARIAS = new Set([8795, 8796, 8797, 8798, 8799, 8800]);
// e·sios pone la hora de Canarias como si fuera la peninsular: el apagón de La Palma del 2-11-2026, que
// el Gobierno de Canarias sitúa a las 06:42 (hora canaria = UTC en invierno), sale a las «06:40+01:00»
// (05:40 UTC), y sus datos acaban una hora antes que los de Ceuta y Melilla. Las dos zonas cambian de
// hora el mismo día, así que la diferencia es siempre de una hora.
const CANARY_SHIFT = 3_600_000;
const RECENT_MS = 2 * 3_600_000; // «lo que consumía hace poco»: las dos últimas horas (en hora real)
// Lo que se lee: seis horas reales. Si un apagón dura más de dos horas y REE programa 0 todo ese rato,
// lo que consumía antes del corte sigue a mano para decir que la isla sigue sin luz.
const READ_MS = 6 * 3_600_000;

/**
 * Último dato de cada sistema: demanda real, la programada para ese mismo momento, la mayor real de
 * las dos últimas horas (`recentMax`) y de todo lo leído (`readMax`, seis horas), en MW, y el dato
 * anterior (`previous`): la regla pide dos seguidos. Tras un apagón REE reprograma la demanda prevista
 * (en La Palma, a 0 durante una hora): la mayor reciente sirve de referencia mientras tanto.
 * `id` es la clave del sistema en el dominio (SISTEMAS_AISLADOS) y `name`, su nombre allí.
 * @returns {Array<{ id: string, name: string, real: number, programmed: number|null, recentMax: number, readMax: number,
 *   previous: { real: number, at: number } | null, at: number }>}
 */
export function parseEsiosDemand(real, programmed) {
  // Sólo valen los números: Number(null) y Number('') dan 0, y un dato vacío no es «0 MW» (un apagón falso).
  const mw = (v) => (typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : null);
  const planned = new Map();
  for (const v of programmed?.indicator?.values ?? []) if (mw(v) !== null) planned.set(`${v.geo_id}|${v.datetime_utc}`, mw(v));
  const atOf = (v) => Date.parse(v.datetime_utc) + (CANARIAS.has(v.geo_id) ? CANARY_SHIFT : 0);
  const bySystem = new Map();
  for (const v of real?.indicator?.values ?? []) {
    if (!ESIOS_SYSTEMS.has(v.geo_id) || mw(v) === null || !Number.isFinite(atOf(v))) continue;
    if (!bySystem.has(v.geo_id)) bySystem.set(v.geo_id, []);
    bySystem.get(v.geo_id).push(v);
  }
  return [...bySystem.values()].map((values) => {
    values.sort((a, b) => atOf(a) - atOf(b));
    const last = values.at(-1);
    const prev = values.at(-2);
    const at = atOf(last);
    const recent = values.filter((v) => atOf(v) >= at - RECENT_MS).map(mw);
    const plan = planned.get(`${last.geo_id}|${last.datetime_utc}`);
    const id = ESIOS_SYSTEMS.get(last.geo_id);
    return {
      id, name: nameOf(id), real: mw(last), programmed: Number.isFinite(plan) ? plan : null,
      recentMax: Math.max(...recent), readMax: Math.max(...values.map(mw)),
      previous: prev ? { real: mw(prev), at: atOf(prev) } : null, at,
    };
  });
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, env: Record<string, string|undefined>, now?: () => number }} deps
 */
export function createEsiosSource({ http, env, now = Date.now }) {
  const headers = () => ({
    Accept: 'application/json; application/vnd.esios-api-v1+json',
    'Content-Type': 'application/json',
    'x-api-key': env.ESIOS_TOKEN ?? '',
  });
  const indicator = (id, from, to) => `${BASE}/${id}?start_date=${from}&end_date=${to}`;
  return {
    // La regla de los apagones de cada isla lee la métrica por este id: lo fija el dominio.
    id: GRID_METRICS.aislados,
    name: 'Red Eléctrica (e·sios): demanda de cada isla de Canarias, Ceuta y Melilla',
    kind: 'metrics',
    interval: 300_000,
    requires: ['ESIOS_TOKEN'],
    url: `${BASE}/${REAL}`,
    page: 'https://www.esios.ree.es/es',
    license: 'Fuente: Red Eléctrica (e·sios). Uso informativo, sin fines comerciales',
    async fetch() {
      // Seis horas reales: en la hora de e·sios, siete, porque Canarias va una hora por detrás.
      const t = now();
      const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
      const from = iso(t - READ_MS - CANARY_SHIFT);
      const to = iso(t + 15 * 60_000);
      const opts = { timeout: 30_000, headers: headers(), maxBytes: 8 * 1024 * 1024 };
      const [real, programmed] = await Promise.all([http.json(indicator(REAL, from, to), opts), http.json(indicator(PROGRAMMED, from, to), opts)]);
      const systems = parseEsiosDemand(real, programmed);
      const at = systems.reduce((max, s) => Math.max(max, s.at), 0) || null;
      return { sourceTime: at, metrics: { systems, at, credit: CREDIT } };
    },
  };
}
