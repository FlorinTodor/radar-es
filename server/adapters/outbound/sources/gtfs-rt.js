// Adaptador genérico para feeds GTFS-Realtime de posiciones de vehículos (protobuf).
// Sirve para cualquier operador que publique el estándar: basta con registrar una
// instancia más en sources/index.js con su URL y su modo.
import { createRequire } from 'node:module';
import { csvRows, openGtfs, zipLocalDate } from '../gtfs/gtfs-reader.js';
import { madridLocalToMs } from './parse.js';
import { followOf, lineKey } from '../../../domain/seguir.js';
import { createTripTracker, readTripShapes } from '../gtfs/trip-shapes.js';

const require = createRequire(import.meta.url);
const { transit_realtime: rt } = require('gtfs-realtime-bindings');

const STALE_MS = 10 * 60_000;
const STATIC_TTL_MS = 24 * 3600_000;
const RETRY_SHAPES_MS = 3600_000;

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
 * `onVehicle(v, entity)`, si se da, se llama con cada vehículo y su entrada del feed (para saber qué viaje hace).
 * @param {object} feed
 * @param {{ id: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           line?: (entity: any) => string|null, describe?: (entity: any, gtfs?: StaticGtfs) => object, gtfs?: StaticGtfs,
 *           now?: number, onVehicle?: (v: object, entity: object) => void }} options
 */
export function vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs, now = Date.now(), onVehicle }) {
  // Un mismo vehículo puede venir dos veces en el feed (lo ha hecho el de Bizkaibus): dos marcadores con el mismo id en el
  // mapa, y su ficha y su recorrido de uno u otro. Se queda su posición más reciente.
  const latest = new Map(); // id del vehículo → { e, fixTime }
  // Una hora sin dar o en el futuro (un reloj mal puesto) no gana a una de verdad.
  const rank = (t) => (t === null || t > now + 5 * 60_000 ? -Infinity : t);
  for (const e of feed.entity ?? []) {
    const vp = e.vehicle;
    const pos = vp?.position;
    if (!pos || !Number.isFinite(pos.latitude) || !Number.isFinite(pos.longitude)) continue;
    const fixTime = vp.timestamp ? vp.timestamp * 1000 : null;
    if (fixTime && now - fixTime > STALE_MS) continue;
    const vehicleId = vp.vehicle?.id || vp.vehicle?.label || e.id;
    const seen = latest.get(vehicleId);
    if (!seen || rank(fixTime) > rank(seen.fixTime)) latest.set(vehicleId, { e, fixTime });
  }
  const vehicles = [];
  for (const [vehicleId, { e, fixTime }] of latest) {
    const vp = e.vehicle;
    const pos = vp.position;
    const v = {
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
    };
    // Sólo su línea (o toda la red, si no la dice): el número es el del coche, que cambia de un día a otro, y
    // no hay forma de saber qué servicio del horario hace (ver domain/seguir.js).
    v.follow = followOf(lineKey({ operator, line: v.line }));
    onVehicle?.(v, e);
    vehicles.push(v);
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
 * Cuándo empezó el viaje de un vehículo según su tiempo real (start_date y start_time; las horas pueden pasar de 24,
 * como en los horarios), en epoch ms; null si no lo dice. Como pide GTFS: desde el mediodía de ese día menos 12 h.
 */
export function tripStartMs(trip) {
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(trip?.startDate ?? '');
  const h = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(trip?.startTime ?? '');
  if (!d || !h) return null;
  const noon = madridLocalToMs(`${d[1]}-${d[2]}-${d[3]}T12:00:00`);
  return noon === null ? null : noon - 12 * 3600_000 + ((+h[1] * 60 + +h[2]) * 60 + +h[3]) * 1000;
}

/**
 * Los trazados de los viajes de una fuente de GTFS-RT (o de cada operador de una fuente que agrupa varios, Euskadi): se
 * leen de su horario una vez al día, por turnos con las demás lecturas pesadas (pool.queue), y cada vehículo apunta al de
 * su viaje mientras lo hace. Si el horario no se puede leer, sin trazados hasta el día siguiente: los vehículos siguen
 * igual, con su recorrido tal cual llega y sin lo que les queda.
 * @param {{ zip: () => Promise<Uint8Array>, queue?: <T>(fn: () => Promise<T>) => Promise<T>, log?: object, now: () => number, label: string }} o
 */
export function createTripShapesOf({ zip, queue = (fn) => fn(), log, now, label }) {
  let shapes = null;
  let loadedAt = -Infinity;
  let loading = null;
  const tracker = createTripTracker();
  async function load() {
    if (now() - loadedAt < STATIC_TTL_MS) return;
    loadedAt = now(); // aunque falle, no se reintenta en cada lectura
    loading ??= queue(async () => readTripShapes(await zip()))
      .then((read) => { shapes = read; })
      .catch((err) => {
        log?.warn(`[${label}] trazados del horario: ${err.message} (se reintenta dentro de una hora)`);
        loadedAt = now() - STATIC_TTL_MS + RETRY_SHAPES_MS;
      })
      .finally(() => { loading = null; });
    await loading;
  }
  return {
    load,
    /** Apunta el viaje de cada vehículo de esta lectura y marca los que tienen trazado (sabrán lo que les queda). */
    note(vehicles, tripOf) {
      const t = now();
      for (const v of vehicles) {
        const trip = tripOf.get(v.id);
        tracker.see(v.id, trip?.tripId, shapes?.shapeOf(trip?.tripId) ?? null, t, tripStartMs(trip));
        if (tracker.get(v.id)) v.ahead = true;
      }
      tracker.keep(new Set(vehicles.map((v) => v.id)));
    },
    get: (vehicleId) => tracker.get(vehicleId),
  };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cache?: { bytes: Function }, log?: import('../../../application/ports.js').LoggerPort,
 *           now?: () => number, pool?: { queue: Function } }} deps  now: reloj (para los tests).
 * @param {{ id: string, name: string, url: string, mode: import('../../../domain/model.js').Mode, operator: string,
 *           license?: string, interval?: number, line?: (entity: any) => string|null,
 *           describe?: (entity: any, gtfs?: StaticGtfs) => Partial<import('../../../domain/model.js').Vehicle>,
 *           staticUrl?: string, shapesZip?: () => Promise<Uint8Array>, rawTrack?: boolean }} options
 *   staticUrl: su GTFS estático (nombres de parada y viajes), si lo hay.
 *   shapesZip: el GTFS estático con los trazados de sus viajes: si su tiempo real dice qué viaje hace cada vehículo, su
 *   recorrido y lo que le queda van por el trazado (tripShape). rawTrack: su licencia pide no alterar el contenido: el
 *   recorrido, sus posiciones tal cual (sólo lo que le queda va por el trazado del operador).
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsRtVehicleSource({ http, cache, log, now = Date.now, pool }, { id, name, url, mode, operator, license, interval = 30_000, line, describe, staticUrl, shapesZip, rawTrack = false }) {
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
  const trips = shapesZip ? createTripShapesOf({ zip: shapesZip, queue: pool?.queue, log, now, label: id }) : null;
  const own = `${id}:`;
  return {
    id,
    name,
    kind: 'vehicles',
    interval,
    url,
    license: license ?? `${operator} (GTFS-Realtime)`,
    ...(trips && {
      /** El trazado del viaje que hace ahora un vehículo y desde cuándo; null si no se sabe; undefined si no es suyo. */
      tripShape: (vehicleId) => (vehicleId.startsWith(own) ? trips.get(vehicleId) : undefined),
      rawTrack,
    }),
    async fetch() {
      await loadStatic();
      // En segundo plano: la primera lectura tras arrancar no espera a que se lea el horario (va por turnos con los
      // demás y puede tardar); hasta entonces, los vehículos salen como siempre.
      trips?.load();
      const feed = decodeFeed(await http.bytes(url));
      if (feed.damaged) log?.warn(`[${id}] su feed llega mal formado: se descartan ${feed.damaged} partes y se usa el resto`);
      const tripOf = new Map();
      const vehicles = vehiclesFromFeed(feed, { id, mode, operator, line, describe, gtfs, now: now(), onVehicle: (v, e) => tripOf.set(v.id, e.vehicle?.trip) });
      trips?.note(vehicles, tripOf);
      return {
        vehicles,
        ...(gtfsUpdated ? { datasetUpdated: gtfsUpdated } : {}),
        sourceTime: feed.header?.timestamp ? feed.header.timestamp * 1000 : null,
      };
    },
  };
}
