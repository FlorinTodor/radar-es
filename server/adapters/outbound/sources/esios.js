// Red Eléctrica (e·sios, la API del operador del sistema): demanda real y programada, cada 5 minutos,
// de los sistemas eléctricos aislados: cada isla o grupo de islas de Canarias, Ceuta y Melilla.
// REData (ree.js) sólo da en tiempo real la demanda de toda España, donde el apagón de una isla no se
// nota. Pide un token personal gratuito (ESIOS_TOKEN, se envía en una cabecera, nunca en la URL).
// Condiciones de REE: uso informativo y sin fines comerciales, citando la fuente y la fecha del dato.

const BASE = 'https://api.esios.ree.es/indicators';
const REAL = 1740;       // «Demanda real territorios no peninsulares»
const PROGRAMMED = 1741; // «Demanda programada territorios no peninsulares»

// geo_id de e·sios → sistema. «Tenerife - La Gomera» (8831) suma dos que ya vienen por separado, y
// «Baleares» sólo trae la demanda programada: ninguno de los dos se usa.
const SYSTEMS = new Map([
  [8795, 'Gran Canaria'], [8796, 'Lanzarote y Fuerteventura'], [8797, 'Tenerife'], [8798, 'La Palma'],
  [8799, 'La Gomera'], [8800, 'El Hierro'], [12, 'Ceuta'], [49, 'Melilla'],
]);
const CANARIAS = new Set([8795, 8796, 8797, 8798, 8799, 8800]);
// e·sios pone la hora de Canarias como si fuera la peninsular: el apagón de La Palma del 2-11-2026, que
// el Gobierno de Canarias sitúa a las 06:42 (hora canaria = UTC en invierno), sale a las «06:40+01:00»
// (05:40 UTC), y sus datos acaban una hora antes que los de Ceuta y Melilla. Las dos zonas cambian de
// hora el mismo día, así que la diferencia es siempre de una hora.
const CANARY_SHIFT = 3_600_000;
const RECENT_MS = 2 * 3_600_000; // «lo que consumía hace poco»: las dos últimas horas (en hora real)

/**
 * Último dato de cada sistema: demanda real, la programada para ese mismo momento y la mayor real de
 * lo leído (las dos últimas horas), en MW. Tras un apagón REE reprograma la demanda prevista (en La
 * Palma, a 0 durante una hora): la mayor reciente sirve de referencia mientras tanto.
 * @returns {Array<{ id: number, name: string, real: number, programmed: number|null, recentMax: number, at: number }>}
 */
export function parseEsiosDemand(real, programmed) {
  // Sólo valen los números: Number(null) y Number('') dan 0, y un dato vacío no es «0 MW» (un apagón falso).
  const mw = (v) => (typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : null);
  const planned = new Map();
  for (const v of programmed?.indicator?.values ?? []) if (mw(v) !== null) planned.set(`${v.geo_id}|${v.datetime_utc}`, mw(v));
  const atOf = (v) => Date.parse(v.datetime_utc) + (CANARIAS.has(v.geo_id) ? CANARY_SHIFT : 0);
  const bySystem = new Map();
  for (const v of real?.indicator?.values ?? []) {
    if (!SYSTEMS.has(v.geo_id) || mw(v) === null || !Number.isFinite(atOf(v))) continue;
    if (!bySystem.has(v.geo_id)) bySystem.set(v.geo_id, []);
    bySystem.get(v.geo_id).push(v);
  }
  return [...bySystem.values()].map((values) => {
    const last = values.reduce((a, b) => (atOf(b) > atOf(a) ? b : a));
    const at = atOf(last);
    const recent = values.filter((v) => atOf(v) >= at - RECENT_MS).map(mw);
    const plan = planned.get(`${last.geo_id}|${last.datetime_utc}`);
    return {
      id: last.geo_id, name: SYSTEMS.get(last.geo_id), real: mw(last), programmed: Number.isFinite(plan) ? plan : null,
      recentMax: Math.max(...recent), at,
    };
  });
}

/** @param {{ http: import('../http/http-client.js').HttpClient, env: Record<string, string|undefined> }} deps */
export function createEsiosSource({ http, env }) {
  const headers = () => ({
    Accept: 'application/json; application/vnd.esios-api-v1+json',
    'Content-Type': 'application/json',
    'x-api-key': env.ESIOS_TOKEN ?? '',
  });
  const indicator = (id, from, to) => `${BASE}/${id}?start_date=${from}&end_date=${to}`;
  return {
    id: 'esios-sistemas-aislados',
    name: 'Red Eléctrica (e·sios): demanda de cada isla de Canarias, Ceuta y Melilla',
    kind: 'metrics',
    interval: 300_000,
    requires: ['ESIOS_TOKEN'],
    url: `${BASE}/${REAL}`,
    page: 'https://www.esios.ree.es/es',
    license: 'Fuente: Red Eléctrica (e·sios). Uso informativo, sin fines comerciales',
    async fetch() {
      // Tres horas en la hora de e·sios: así llegan las dos últimas horas reales también de Canarias,
      // que va una hora por detrás.
      const now = Date.now();
      const iso = (t) => new Date(t).toISOString().slice(0, 19) + 'Z';
      const from = iso(now - 3 * 3_600_000);
      const to = iso(now + 15 * 60_000);
      const opts = { timeout: 30_000, headers: headers(), maxBytes: 8 * 1024 * 1024 };
      const [real, programmed] = await Promise.all([http.json(indicator(REAL, from, to), opts), http.json(indicator(PROGRAMMED, from, to), opts)]);
      const systems = parseEsiosDemand(real, programmed);
      return { sourceTime: systems.reduce((max, s) => Math.max(max, s.at), 0) || null, metrics: { systems } };
    },
  };
}
