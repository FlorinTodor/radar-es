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

const AS_OBJECT = { longs: Number, enums: String };

/**
 * Decodifica un FeedMessage GTFS-RT (protobuf) a objeto plano. Si llega mal formado, se leen sus entradas
 * una a una y sólo se descartan las partes que no se pueden leer: Euskotren publica a veces un fichero con
 * una entrada mal medida (sus paradas quedan sueltas en el fichero) y, leyéndolo de golpe, se perdía entero
 * con «missing required 'trip'». Entonces `damaged` dice cuántas partes se han descartado.
 * Un fichero vacío (BilboBus publica a veces 0 bytes) es un error que lo dice, no uno de protobuf.
 * @returns {{ header?: object, entity: object[], damaged?: number }}
 */
export function decodeFeed(bytes) {
  if (!bytes?.length) throw new Error('el fichero llega vacío (0 bytes)');
  try {
    return rt.FeedMessage.toObject(rt.FeedMessage.decode(bytes), AS_OBJECT);
  } catch (err) {
    const feed = decodeEntityByEntity(bytes);
    if (!feed) throw err;
    return feed;
  }
}

/**
 * Lectura de un FeedMessage campo a campo (su cabecera, campo 1, y cada entrada, campo 2), quedándose con
 * lo que se lee bien. null si ni siquiera tiene cabecera: entonces no es un feed.
 */
function decodeEntityByEntity(bytes) {
  let header = null;
  const entity = [];
  let damaged = 0;
  let pos = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (pos >= bytes.length || shift > 63) throw new Error('varint cortado');
      const b = bytes[pos++];
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
    }
  };
  try {
    while (pos < bytes.length) {
      const tag = varint();
      const field = Math.floor(tag / 8);
      const wire = tag % 8;
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else if (wire === 2) {
        const length = varint();
        const part = bytes.subarray(pos, pos + length);
        if (pos + length > bytes.length) throw new Error('parte cortada');
        pos += length;
        try {
          if (field === 1) header ??= rt.FeedHeader.toObject(rt.FeedHeader.decode(part), AS_OBJECT);
          else if (field === 2) entity.push(rt.FeedEntity.toObject(rt.FeedEntity.decode(part), AS_OBJECT));
        } catch {
          damaged++;
        }
      } else throw new Error(`tipo de campo ${wire}`);
    }
  } catch {
    damaged++; // lo que queda ya no se puede recorrer: vale lo leído hasta aquí
  }
  return header ? { header, entity, damaged } : null;
}

/**
 * Vehículos de un FeedMessage ya decodificado, descartando posiciones de hace más de 10 min.
 * `gtfs`, si la fuente tiene horario estático: nombres de parada y viajes (ver createGtfsRtVehicleSource).
 * `now`: el instante con el que se miden esos 10 min (epoch ms; para los tests).
 * @param {object} feed
 * @param {{ id: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           line?: (entity: any) => string|null, describe?: (entity: any, gtfs?: StaticGtfs) => object, gtfs?: StaticGtfs,
 *           now?: number }} options
 */
export function vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs, now = Date.now() }) {
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
 * @param {{ http: import('../http/http-client.js').HttpClient, cache?: { bytes: Function }, log?: import('../../../application/ports.js').LoggerPort,
 *           now?: () => number }} deps  now: reloj (para los tests).
 * @param {{ id: string, name: string, url: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           license?: string, interval?: number, line?: (entity: any) => string|null,
 *           describe?: (entity: any, gtfs?: StaticGtfs) => Partial<import('../../../domain/model.js').Vehicle>,
 *           staticUrl?: string }} options  staticUrl: su GTFS estático (nombres de parada y viajes), si lo hay.
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsRtVehicleSource({ http, cache, log, now = Date.now }, { id, name, url, mode, operator, license, interval = 30_000, line, describe, staticUrl }) {
  let gtfs;
  let gtfsUpdated = null; // fecha de su última actualización: la licencia de Open Data Euskadi pide mencionarla
  let loadedAt = 0;
  async function loadStatic() {
    if (!staticUrl || now() - loadedAt < STATIC_TTL_MS) return;
    loadedAt = now(); // aunque falle, no reintentar en cada lectura
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
      if (feed.damaged) log?.warn(`[${id}] su feed llega mal formado: se descartan ${feed.damaged} partes y se usa el resto`);
      return {
        vehicles: vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs, now: now() }),
        ...(gtfsUpdated ? { datasetUpdated: gtfsUpdated } : {}),
        sourceTime: feed.header?.timestamp ? feed.header.timestamp * 1000 : null,
      };
    },
  };
}
