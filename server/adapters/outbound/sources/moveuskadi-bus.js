// Autobuses de Euskadi: Open Data Euskadi publica un índice con los feeds GTFS-RT de ~25
// operadores (Bizkaibus, Dbus, Tuvisa, Lurraldebus…). Se leen todos en una sola fuente.
// Metro Bilbao y Euskotren se excluyen: son ferroviarios y tienen sus propios adaptadores.
import { createTripShapesOf, decodeFeed, vehiclesFromFeed } from './gtfs-rt.js';

const INDEX = 'https://opendata.euskadi.eus/transport/moveuskadi/data-index-gtfs-rt.json';
// El de sus horarios (un GTFS por operador, con el trazado de sus viajes), con los mismos nombres de operador.
const GTFS_INDEX = 'https://opendata.euskadi.eus/transport/moveuskadi/data-index-gtfs.json';
const GTFS_TTL_MS = 24 * 3600_000;
const RAIL = /^(metro bilbao|euskotren)$/i;
const INDEX_TTL_MS = 3600_000;
const CONCURRENCY = 6;

const slug = (s) => s.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, log: import('../../../application/ports.js').LoggerPort,
 *           cache?: { bytes: Function }, pool?: { queue: Function }, now?: () => number }} deps
 *   cache: sin ella, sin trazados (lo que les queda no se sabe y su recorrido va como siempre).
 */
export function createMoveuskadiBusSource({ http, log, cache, pool, now = Date.now }) {
  let feeds = [];
  let indexAt = 0;
  const warned = new Set(); // algunos operadores publican feeds vacíos: avisar una vez basta
  // Los trazados de los viajes de cada operador, de su horario: sólo de los que tienen vehículos en la calle (de los
  // ~25, unos pocos a la vez). El recorrido va tal cual llega (rawTrack): su licencia pide no alterar el contenido.
  let gtfsUrls = null;
  let gtfsIndexAt = -Infinity;
  const tripsByPrefix = new Map(); // «bus-<operador>:» → createTripShapesOf
  async function gtfsUrlOf(name) {
    if (!gtfsUrls || now() - gtfsIndexAt >= GTFS_TTL_MS) {
      gtfsIndexAt = now();
      const { data } = await http.json(GTFS_INDEX);
      gtfsUrls = new Map(Object.entries(data ?? {}).map(([n, files]) => [n, files.find((f) => /\.zip$/i.test(f.url))?.url]).filter(([, u]) => u));
    }
    return gtfsUrls.get(name) ?? null;
  }
  const tripsOf = (name, id) => {
    const prefix = `${id}:`;
    if (!tripsByPrefix.has(prefix)) {
      tripsByPrefix.set(prefix, createTripShapesOf({
        label: `moveuskadi-bus ${name}`, queue: pool?.queue, log, now,
        zip: async () => {
          const url = await gtfsUrlOf(name);
          if (!url) throw new Error('su horario no está en el índice de Open Data Euskadi');
          return cache.bytes(encodeURI(url), `moveuskadi-${id}-gtfs.zip`, GTFS_TTL_MS);
        },
      }));
    }
    return tripsByPrefix.get(prefix);
  };

  async function loadIndex() {
    if (feeds.length && Date.now() - indexAt < INDEX_TTL_MS) return;
    const { data } = await http.json(INDEX);
    feeds = Object.entries(data ?? {})
      .filter(([name]) => !RAIL.test(name.trim()))
      .map(([name, files]) => ({ name, url: files.find((f) => /position/i.test(f.url))?.url }))
      .filter((f) => f.url);
    indexAt = Date.now();
  }

  return {
    id: 'moveuskadi-bus',
    name: 'Autobuses de Euskadi (GTFS-RT, Open Data Euskadi)',
    kind: 'vehicles',
    interval: 60_000,
    url: INDEX,
    license: 'Open Data Euskadi · MoveUskadi (CC BY 4.0). Formato adaptado, contenido sin alterar; lo que le queda a cada '
      + 'autobús, por el trazado de su viaje en el horario de su operador (también de Open Data Euskadi)',
    ...(cache && {
      /** El trazado del viaje que hace ahora un vehículo; null si no se sabe; undefined si no es de esta fuente. */
      tripShape(vehicleId) {
        for (const [prefix, trips] of tripsByPrefix) if (vehicleId.startsWith(prefix)) return trips.get(vehicleId);
        // De uno de sus operadores que aún no tiene trazados: suyo, sin trazado. Los demás «bus-…» son de otras fuentes.
        return feeds.some((f) => vehicleId.startsWith(`bus-${slug(f.name)}:`)) ? null : undefined;
      },
      rawTrack: true,
    }),
    async fetch() {
      await loadIndex();
      const vehicles = [];
      let sourceTime = null; // la del feed más reciente
      for (let i = 0; i < feeds.length; i += CONCURRENCY) {
        await Promise.all(feeds.slice(i, i + CONCURRENCY).map(async ({ name, url }) => {
          try {
            const feed = decodeFeed(await http.bytes(encodeURI(url)));
            const at = Number(feed.header?.timestamp) * 1000;
            if (at > (sourceTime ?? 0)) sourceTime = at;
            const id = `bus-${slug(name)}`;
            const tripOf = new Map();
            const mine = vehiclesFromFeed(feed, { id, mode: 'bus', operator: name, now: now(), onVehicle: (v, e) => tripOf.set(v.id, e.vehicle?.trip) });
            if (cache && mine.some((v) => tripOf.get(v.id)?.tripId)) {
              const trips = tripsOf(name, id);
              trips.load(); // en segundo plano, como en las demás fuentes de GTFS-RT
              trips.note(mine, tripOf);
            }
            vehicles.push(...mine);
          } catch (err) {
            if (!warned.has(name)) log.warn(`[moveuskadi-bus] ${name}: ${err.message} (no se volverá a avisar)`);
            warned.add(name);
          }
        }));
      }
      return { vehicles, sourceTime };
    },
  };
}
