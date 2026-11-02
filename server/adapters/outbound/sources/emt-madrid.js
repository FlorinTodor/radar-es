// EMT Madrid: avisos de servicio (desvíos por obras, manifestaciones…) del GTFS-RT que publica en el
// NAP. Sus condiciones (mobilitylabs.emtmadrid.es/sip/terms-of-use) piden identificarse para los datos
// dinámicos: se entra con las claves de nuestra aplicación en MobilityLabs y se usa su token. Sus
// posiciones no: el NAP no las tiene, y estimarlas con su horario por frecuencias da cifras irreales.
import { decodeFeed } from './gtfs-rt.js';

const ALERTS = 'https://openapi.emtmadrid.es/v1/bus/servicealerts/proto';
// Acceso «protegido» de MobilityLabs (apidocs.emtmadrid.es, Block_1_User_identity): X-ClientId y passKey
// de la aplicación, sin usuario ni contraseña personales. El token dura hasta 24 h y se alarga solo
// con cada llamada.
const LOGIN = 'https://openapi.emtmadrid.es/v1/mobilitylabs/user/login/';
// Margen para no usar un token a punto de caducar.
const TOKEN_MARGIN_MS = 5 * 60_000;
const SEVERE_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS']);

const text = (t) => ((t?.translation ?? []).find((x) => !x.language || x.language.startsWith('es')) ?? t?.translation?.[0])?.text?.trim() ?? '';

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, env?: Record<string, string | undefined>, now?: () => number }} deps
 *   env: EMT_MADRID_CLIENT_ID y EMT_MADRID_PASSKEY. Ni ellas ni el token salen nunca en un error o en el registro.
 */
export function createEmtMadridAlertsSource({ http, env = {}, now = Date.now }) {
  let token = null;
  let tokenUntil = 0;

  async function login() {
    const res = await http.json(LOGIN, { headers: { 'X-ClientId': env.EMT_MADRID_CLIENT_ID ?? '', passKey: env.EMT_MADRID_PASSKEY ?? '' } });
    const session = res?.data?.[0];
    // Su `description` lleva el token cuando todo va bien: no se copia a ningún mensaje.
    if (res?.code !== '00' || !session?.accessToken) throw new Error(`EMT Madrid no acepta las claves de MobilityLabs (código ${res?.code ?? '?'})`);
    token = session.accessToken;
    tokenUntil = now() + (Number(session.tokenSecExpiration) || 0) * 1000 - TOKEN_MARGIN_MS;
  }

  /** Los avisos con el token vigente; si EMT lo da por caducado antes de tiempo, se entra otra vez. */
  async function alerts() {
    if (!token || now() >= tokenUntil) await login();
    try {
      return await http.bytes(ALERTS, { headers: { accessToken: token } });
    } catch (err) {
      if (!/HTTP 40[13]\b/.test(err.message)) throw err;
      await login();
      return http.bytes(ALERTS, { headers: { accessToken: token } });
    }
  }

  return {
    id: 'emt-madrid-avisos',
    name: 'EMT Madrid: avisos de servicio (GTFS-RT)',
    kind: 'events',
    interval: 300_000,
    url: ALERTS,
    requires: ['EMT_MADRID_CLIENT_ID', 'EMT_MADRID_PASSKEY'],
    license: 'Powered by MITRAMS (Punto de Acceso Nacional) · Powered by EMT de Madrid (MobilityLabs)',
    async fetch() {
      const feed = decodeFeed(await alerts());
      const nowS = now() / 1000;
      const events = new Map(); // el mismo aviso viene repetido por cada línea afectada
      for (const e of feed.entity ?? []) {
        const a = e.alert;
        if (!a) continue;
        const periods = a.activePeriod ?? [];
        const period = periods.find((p) => (!p.start || +p.start <= nowS) && (!p.end || +p.end >= nowS));
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
