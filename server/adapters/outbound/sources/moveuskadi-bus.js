// Autobuses de Euskadi: Open Data Euskadi publica un índice con los feeds GTFS-RT de ~25
// operadores (Bizkaibus, Dbus, Tuvisa, Lurraldebus…). Se leen todos en una sola fuente.
// Metro Bilbao y Euskotren se excluyen: son ferroviarios y tienen sus propios adaptadores.
import { decodeFeed, vehiclesFromFeed } from './gtfs-rt.js';

const INDEX = 'https://opendata.euskadi.eus/transport/moveuskadi/data-index-gtfs-rt.json';
const RAIL = /^(metro bilbao|euskotren)$/i;
const INDEX_TTL_MS = 3600_000;
const CONCURRENCY = 6;

const slug = (s) => s.normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** @param {{ http: import('../http/http-client.js').HttpClient, log: import('../../../application/ports.js').LoggerPort }} deps */
export function createMoveuskadiBusSource({ http, log }) {
  let feeds = [];
  let indexAt = 0;
  const warned = new Set(); // algunos operadores publican feeds vacíos: avisar una vez basta

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
    license: 'Open Data Euskadi · MoveUskadi (CC BY 4.0)',
    async fetch() {
      await loadIndex();
      const vehicles = [];
      for (let i = 0; i < feeds.length; i += CONCURRENCY) {
        await Promise.all(feeds.slice(i, i + CONCURRENCY).map(async ({ name, url }) => {
          try {
            const feed = decodeFeed(await http.bytes(encodeURI(url)));
            vehicles.push(...vehiclesFromFeed(feed, { id: `bus-${slug(name)}`, mode: 'bus', operator: name }));
          } catch (err) {
            if (!warned.has(name)) log.warn(`[moveuskadi-bus] ${name}: ${err.message} (no se volverá a avisar)`);
            warned.add(name);
          }
        }));
      }
      return { vehicles };
    },
  };
}
