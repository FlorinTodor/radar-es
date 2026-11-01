// Adaptador genérico para feeds GTFS-Realtime de posiciones de vehículos (protobuf).
// Sirve para cualquier operador que publique el estándar: basta con registrar una
// instancia más en sources/index.js con su URL y su modo.
import { createRequire } from 'node:module';
import { csvRows, openGtfs, zipLocalDate } from '../gtfs/gtfs-reader.js';
import { madridLocalToMs } from './parse.js';

const require = createRequire(import.meta.url);
const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const STALE_MS = 10 * 60_000;
const STATIC_TTL_MS = 24 * 3600_000;

/** Decodifica un FeedMessage GTFS-RT (protobuf) a objeto plano. */
export function decodeFeed(bytes) {
  return rt.FeedMessage.toObject(rt.FeedMessage.decode(bytes), { longs: Number, enums: String });
}

/**
 * Vehículos de un FeedMessage ya decodificado, descartando posiciones de hace más de 10 min.
 * `gtfs`, si la fuente tiene horario estático: nombres de parada y viajes (ver createGtfsRtVehicleSource).
 * @param {object} feed
 * @param {{ id: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           line?: (entity: any) => string|null, describe?: (entity: any, gtfs?: StaticGtfs) => object, gtfs?: StaticGtfs }} options
 */
export function vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs }) {
  const now = Date.now();
  const vehicles = [];
  for (const e of feed.entity ?? []) {
    const vp = e.vehicle;
    const pos = vp?.position;
    if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;
    const fixTime = vp.timestamp ? vp.timestamp * 1000 : null;
    if (fixTime && now - fixTime > STALE_MS) continue;
    const vehicleId = vp.vehicle?.id || vp.vehicle?.label || e.id;
    vehicles.push({
      id: `${id}:${vehicleId}`,
      mode,
      operator,
      service: operator,
      line: line ? line(e) : vp.trip?.routeId ?? null,
      label: vp.vehicle?.label || vehicleId,
      lat: pos.latitude,
      lon: pos.longitude,
      delay: null,
      next: (gtfs ? gtfs.stop(vp.stopId)?.name : vp.stopId) ?? null,
      fixTime,
      ...describe?.(e, gtfs),
    });
  }
  return vehicles;
}

/**
 * @typedef {{ stop: (idOrCode: string|undefined) => { name: string, at: [number, number] }|undefined,
 *             trip: (tripId: string|undefined) => { shape: string|null, headsign: string|null }|undefined }} StaticGtfs
 */

/**
 * Paradas (por stop_id y por stop_code) y viajes de un GTFS estático, para dar nombres en vez de códigos.
 * @returns {StaticGtfs}
 */
export function staticGtfs(files) {
  const stops = new Map();
  for (const s of csvRows(files['stops.txt'])) {
    const stop = { name: s.stop_name, at: [+s.stop_lon, +s.stop_lat] };
    stops.set(s.stop_id, stop);
    if (s.stop_code && !stops.has(s.stop_code)) stops.set(s.stop_code, stop);
  }
  const trips = new Map([...csvRows(files['trips.txt'])].map((t) => [t.trip_id, { shape: t.shape_id || null, headsign: t.trip_headsign || null }]));
  return { stop: (k) => (k ? stops.get(k) : undefined), trip: (k) => (k ? trips.get(k) : undefined) };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cache?: { bytes: Function }, log?: import('../../../application/ports.js').LoggerPort }} deps
 * @param {{ id: string, name: string, url: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           license?: string, interval?: number, line?: (entity: any) => string|null,
 *           describe?: (entity: any, gtfs?: StaticGtfs) => Partial<import('../../../domain/model.js').Vehicle>,
 *           staticUrl?: string }} options  staticUrl: su GTFS estático (nombres de parada y viajes), si lo hay.
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsRtVehicleSource({ http, cache, log }, { id, name, url, mode, operator, license, interval = 30_000, line, describe, staticUrl }) {
  let gtfs;
  let gtfsUpdated = null; // fecha de su última actualización: la licencia de Open Data Euskadi pide mencionarla
  let loadedAt = 0;
  async function loadStatic() {
    if (!staticUrl || Date.now() - loadedAt < STATIC_TTL_MS) return;
    loadedAt = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      const zip = await cache.bytes(staticUrl, `${id}-gtfs.zip`, STATIC_TTL_MS);
      gtfs = staticGtfs(await openGtfs(zip, ['stops.txt', 'trips.txt']));
      gtfsUpdated = madridLocalToMs(zipLocalDate(zip));
    } catch (err) {
      log?.warn(`[${id}] horario estático: ${err.message}`);
    }
  }
  return {
    id,
    name,
    kind: 'vehicles',
    interval,
    url,
    license: license ?? `${operator} (GTFS-Realtime)`,
    async fetch() {
      await loadStatic();
      const feed = decodeFeed(await http.bytes(url));
      return {
        vehicles: vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs }),
        ...(gtfsUpdated ? { datasetUpdated: gtfsUpdated } : {}),
        sourceTime: feed.header?.timestamp ? feed.header.timestamp * 1000 : null,
      };
    },
  };
}
