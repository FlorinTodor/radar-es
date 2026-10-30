// Adaptador genérico para feeds GTFS-Realtime de posiciones de vehículos (protobuf).
// Sirve para cualquier operador que publique el estándar: basta con registrar una
// instancia más en sources/index.js con su URL y su modo.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const STALE_MS = 10 * 60_000;

/**
 * @param {{ http: import('../http/http-client.js').HttpClient }} deps
 * @param {{ id: string, name: string, url: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           license?: string, interval?: number, line?: (entity: any) => string|null,
 *           describe?: (entity: any) => Partial<import('../../../domain/model.js').Vehicle> }} options
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsRtVehicleSource({ http }, { id, name, url, mode, operator, license, interval = 30_000, line, describe }) {
  return {
    id,
    name,
    kind: 'vehicles',
    interval,
    url,
    license: license ?? `${operator} (GTFS-Realtime)`,
    async fetch() {
      const feed = rt.FeedMessage.toObject(rt.FeedMessage.decode(await http.bytes(url)), { longs: Number, enums: String });
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
          line: line?.(e) ?? vp.trip?.routeId ?? null,
          label: vp.vehicle?.label || vehicleId,
          lat: pos.latitude,
          lon: pos.longitude,
          delay: null,
          next: vp.stopId ?? null,
          fixTime,
          ...describe?.(e),
        });
      }
      return { vehicles, sourceTime: feed.header?.timestamp ? feed.header.timestamp * 1000 : null };
    },
  };
}
