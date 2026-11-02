// Posición estimada a partir del horario GTFS (del NAP) para operadores que no publican GPS.
// - Sin tiempo real (Ouigo, metros, tranvías, autobuses): se colocan donde dice el horario.
// - Con trip updates GTFS-RT (Euskotren): sólo los viajes en curso, desplazados por su retraso real.
// Las posiciones se marcan `estimated` (anillo hueco en el mapa) y no cuentan para alertas.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFeed } from './gtfs-rt.js';
import { activeFrequencyOffsets, pointAlong, scheduledPosition, serviceRuns, stopsAlongShape } from '../../../domain/schedule.js';
import { madridLocalToMs } from './parse.js';
import { bearingDeg } from '../../../domain/geo.js';
import { napDatasetPage } from '../nap/nap-client.js';
import { createCpuPool } from '../workers/cpu-pool.js';
import { packSchedule, unpackSchedule } from '../gtfs/gtfs-schedule.js';

const RELOAD_MS = 24 * 3600_000;
// Un fichero de un grupo que no se ha podido leer se reintenta a los 10 min, sin releer los demás:
// si no, ese operador faltaría en el mapa hasta el día siguiente.
const RETRY_MS = 10 * 60_000;
const sha1 = (data) => createHash('sha1').update(data).digest('hex');
// Huella del código que calcula los horarios: un despliegue que lo cambie no reutiliza lo guardado.
const PARSER = sha1(['../gtfs/gtfs-schedule.js', '../gtfs/gtfs-reader.js', '../gtfs/gtfs-modes.js', '../../../domain/schedule.js']
  .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n')).slice(0, 12);
const PATH_WINDOW_S = 45 * 60; // el mismo tramo que el recorrido de los vehículos con GPS
// Sin trazado, lo que le queda se dibuja uniendo paradas sólo en estos modos (paradas cercanas).
const STRAIGHT_AHEAD = new Set(['metro', 'tranvia', 'cercanias']);
// Sin pool inyectado (tests, herramientas), los horarios se leen en el hilo principal de uno en uno.
const inlinePool = createCpuPool({ threads: 0 });

/** Paradas de un viaje como objetos, sólo cuando hace falta (viajes en circulación). */
function tripStops(trip, { times, stopList }) {
  const out = [];
  for (let i = trip.at; i < trip.at + trip.n * 4; i += 4) {
    out.push({ seq: times[i], ...stopList[times[i + 1]], arr: times[i + 2], dep: times[i + 3] });
  }
  return out;
}

/**
 * Distancia sobre el trazado de cada parada del viaje (se calcula una vez por viaje, sólo para los
 * que llegan a circular). null si no tiene trazado o sus paradas no encajan en él.
 */
function alongShape(schedule, trip, stops) {
  if (trip.along === undefined) trip.along = trip.shape >= 0 ? stopsAlongShape(stops, schedule.shapes[trip.shape]) : null;
  return trip.along;
}

/** Día de servicio en Madrid desplazado `offset` días. */
function madridServiceDay(now, offset) {
  const [y, m, d] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + offset));
  const iso = day.toISOString().slice(0, 10);
  return { ymd: iso.replaceAll('-', ''), iso, weekday: (day.getUTCDay() + 6) % 7, midnight: madridLocalToMs(`${iso}T00:00:00`) };
}

const hhmmss = (secs) => [Math.floor(secs / 3600) % 24, Math.floor(secs / 60) % 60, Math.floor(secs % 60)].map((n) => String(n).padStart(2, '0')).join(':');

/** Retraso (s) de cada viaje en curso según los trip updates: hora prevista menos hora programada. */
function delaysFromTripUpdates(feed, schedule) {
  const byId = new Map(schedule.trips.map((t) => [t.id, t]));
  const out = new Map();
  for (const e of feed.entity ?? []) {
    const tu = e.tripUpdate;
    const trip = tu && byId.get(tu.trip?.tripId);
    if (!trip) continue;
    const ymd = tu.trip.startDate;
    const stops = tripStops(trip, schedule);
    let delay = null;
    for (const u of tu.stopTimeUpdate ?? []) {
      const ev = u.arrival ?? u.departure;
      if (Number.isFinite(ev?.delay)) { delay = ev.delay; break; }
      const stop = stops.find((s) => (u.stopSequence !== undefined ? s.seq === u.stopSequence : s.stopId === u.stopId));
      if (stop && Number.isFinite(ev?.time) && ymd) {
        const midnight = madridLocalToMs(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}T00:00:00`);
        delay = ev.time - (midnight / 1000 + (u.arrival ? stop.arr : stop.dep));
        break;
      }
    }
    out.set(trip.id, { delay: delay ?? tu.delay ?? 0, ymd });
  }
  return out;
}

/** Trozo de un trazado entre dos distancias (m), como [lon, lat] redondeados. */
function stretch(shape, from, to) {
  const { coords, dist } = shape;
  const round = (x) => Math.round(x * 1e5) / 1e5;
  const at = (d) => { const q = pointAlong(shape, d); return [round(q.lon), round(q.lat)]; };
  const out = [at(from)];
  for (let i = 0; i < dist.length; i++) if (dist[i] > from && dist[i] < to) out.push([round(coords[i * 2]), round(coords[i * 2 + 1])]);
  out.push(at(to));
  return out;
}

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>, http: import('../http/http-client.js').HttpClient,
 *           log?: import('../../../application/ports.js').LoggerPort, pool?: import('../workers/cpu-pool.js').CpuPool }} deps
 *   pool: hilos de cálculo donde se leen los horarios (de uno en uno por hilo en todo el servidor: al
 *   arrancar, o al cambiar de día, se juntarían en memoria decenas de ZIP descomprimidos a la vez).
 * @param {{ id: string, name: string, operator?: string, ficheroId?: number, dataset?: number, feeds?: Feed[], credit?: string,
 *           license?: string, interval?: number, mode?: import('../../../domain/model.js').Mode, tripUpdatesUrl?: string,
 *           label?: (trip: object) => string, line?: (name: string|null) => string|null }} options
 *   dataset: conjunto de datos del NAP al que pertenece el fichero (para su fecha de actualización).
 *   feeds: varios ficheros en una sola fuente (empresas con muchos conjuntos), en lugar de ficheroId/dataset/operator.
 *   credit: atribución que pide el propio operador además de la del NAP ("Powered by CRTM"…).
 * @typedef {{ ficheroId: number, dataset: number, operator: string, excludeAgency?: RegExp, excludeRoute?: RegExp }} Feed
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsScheduleSource({ nap, http, log, cache, pool = inlinePool }, options) {
  const { id, name, mode, tripUpdatesUrl, interval = 30_000 } = options;
  const feeds = options.feeds ?? [{ ficheroId: options.ficheroId, dataset: options.dataset, operator: options.operator }];
  const loaded = new Map(); // índice del fichero → { schedule, updatedAt }
  let loadedAt = 0;
  let loadedDay = null; // día de servicio (Madrid) para el que se cargaron los horarios
  const failed = new Set(); // índices de los ficheros del grupo que fallaron en la última carga
  let failedAt = 0;
  // Tramo de trazado recorrido en los últimos 45 min por cada vehículo de la última lectura y hasta
  // dónde llega su viaje: id → { shape, from, to, end } (distancias en metros), o null si se queda
  // en la última parada.
  let paths = new Map();

  function vehicle(fi, schedule, trip, day, t, delaySec, offset = 0, nextPaths = paths) {
    const tt = t - offset;
    if (tt < trip.first || tt > trip.last) return null; // descarte barato antes de crear objetos
    const stops = tripStops(trip, schedule);
    const pos = scheduledPosition(stops, tt);
    if (!pos) return null;
    const instance = offset ? `:${offset}` : '';
    const vid = `${id}:${feeds.length > 1 ? `${fi}:` : ''}${trip.id}:${day.ymd}${instance}`;
    let { lat, lon } = pos;
    let atLastStop = false;
    const along = alongShape(schedule, trip, stops);
    // Distancia sobre el trazado: a la misma fracción del tramo entre paradas, pero medida sobre él.
    const alongAt = (p) => along[p.i] + ((along[p.i + 1] ?? along[p.i]) - along[p.i]) * p.k;
    if (along) {
      const shape = schedule.shapes[trip.shape];
      if (!pos.atStop) ({ lat, lon } = pointAlong(shape, alongAt(pos)));
      const before = scheduledPosition(stops, Math.max(tt - PATH_WINDOW_S, stops[0].dep));
      nextPaths.set(vid, { shape, from: before ? alongAt(before) : 0, to: alongAt(pos), end: along.at(-1) });
    } else if (!pos.atStop && trip.route.mode === 'bus') {
      // Sin trazado, en línea recta un autobús interurbano cruzaría el campo: se deja en la última
      // parada por la que ha pasado. Los trenes sí siguen la recta (las vías suelen ser bastante rectas).
      ({ lat, lon } = pos.prev);
      atLastStop = true;
      nextPaths.set(vid, null);
    } else if (trip.route.mode === 'bus') {
      nextPaths.set(vid, null);
    } else if (STRAIGHT_AHEAD.has(trip.route.mode)) {
      // Metro o tranvía sin trazado: va en línea recta entre paradas, como el mapa dibuja su red, y
      // lo que le queda también. Un tren de larga distancia no: entre ciudades la recta se sale de la vía.
      nextPaths.set(vid, { at: [lon, lat], stops: stops.slice(pos.i + 1).map((s) => [s.lon, s.lat]) });
    }
    const p = nextPaths.get(vid);
    const ahead = p ? (p.stops ? p.stops.length > 0 : p.to < p.end) : false;
    // Hacia dónde va: por su recorrido, 100 m más allá. Con el rastro, cada cambio de retraso
    // (la posición retrocede o salta) giraría la flecha.
    let heading = null;
    if (p?.stops?.length) heading = bearingDeg(lat, lon, p.stops[0][1], p.stops[0][0]);
    else if (p && p.end - p.to > 20) {
      const q = pointAlong(p.shape, Math.min(p.to + 100, p.end));
      heading = bearingDeg(lat, lon, q.lat, q.lon);
    }
    const { operator } = feeds[fi];
    return {
      id: vid,
      mode: trip.route.mode,
      operator,
      service: operator,
      line: options.line ? options.line(trip.route.line) : trip.route.line,
      label: options.label?.(trip) ?? trip.label ?? null,
      lat,
      lon,
      delay: delaySec === null ? null : Math.round(delaySec / 60),
      estimated: true,
      ...(ahead ? { ahead: true } : {}),
      ...(heading !== null ? { heading } : {}),
      atLastStop,
      origin: stops[0].name,
      destination: stops.at(-1).name,
      current: pos.atStop || atLastStop ? pos.prev.name : null,
      next: pos.atStop ? pos.next?.name ?? null : pos.next.name,
      nextEta: pos.next ? `${day.iso}T${hhmmss(pos.next.arr + offset + (delaySec ?? 0))}` : null,
    };
  }

  /**
   * El horario de un fichero para hoy y ayer. Leerlo cuesta mucha CPU (en el servidor, más de tres
   * minutos todos juntos al arrancar), así que se guarda en disco con la huella del ZIP, los días y
   * el código que lo calcula: tras un despliegue o un reinicio, el mismo día, se lee de ahí.
   */
  async function scheduleOf(feed, days) {
    const zip = await nap.gtfs(feed.ficheroId, RELOAD_MS);
    if (!cache?.readValue) return pool.run('schedule', [zip, mode, days, feed]);
    const name = `horario-${feed.ficheroId}-${sha1(`${id}|${mode}|${feed.excludeAgency}|${feed.excludeRoute}`).slice(0, 8)}.v8`;
    const key = [PARSER, sha1(zip), days.today.ymd, days.yesterday.ymd].join('|');
    const saved = await cache.readValue(name);
    if (saved?.key === key) return unpackSchedule(saved.schedule);
    const schedule = await pool.run('schedule', [zip, mode, days, feed]);
    await cache.writeValue(name, { key, schedule: packSchedule(schedule).value });
    return schedule;
  }

  /**
   * Carga los horarios (de uno en uno en todo el servidor); si falla un fichero de un grupo, el resto
   * sigue. `only`: sólo esos ficheros (los que fallaron), sin cambiar cuándo toca la carga completa.
   */
  async function load(today, only = null) {
    const days = { today: madridServiceDay(Date.now(), 0), yesterday: madridServiceDay(Date.now(), -1) };
    for (const [fi, feed] of feeds.entries()) {
      if (only && !only.includes(fi)) continue;
      try {
        const schedule = await pool.queue(() => scheduleOf(feed, days));
        const updatedAt = await nap.updatedAt(feed.dataset, feed.ficheroId).then(madridLocalToMs).catch(() => loaded.get(fi)?.updatedAt ?? null);
        loaded.set(fi, { schedule, updatedAt });
        failed.delete(fi);
      } catch (err) {
        if (feeds.length === 1) throw err;
        failed.add(fi);
        log?.warn(`[${id}] ${feed.operator} (fichero ${feed.ficheroId}): ${err.message}${only ? '' : '; se reintentará en 10 min'}`);
      }
    }
    failedAt = Date.now();
    if (only) return;
    loadedAt = Date.now();
    loadedDay = today;
  }

  return {
    id,
    name,
    kind: 'vehicles',
    interval,
    requires: ['NAP_API_KEY'],
    url: tripUpdatesUrl ?? (feeds.length === 1 ? napDatasetPage(feeds[0].dataset) : 'https://nap.transportes.gob.es'),
    license: options.license
      ?? `Powered by MITRAMS (Punto de Acceso Nacional) · ${options.credit ?? [...new Set(feeds.map((f) => f.operator))].join(', ')} · `
        + 'Posición estimada a partir del horario (dato explotado, no GPS)',
    /**
     * Tramo de su trazado recorrido en los últimos 45 min, como [lon, lat], para dibujarlo por la calle
     * y no uniendo con rectas las posiciones de cada lectura. null: autobús sin trazado (se queda en la
     * última parada); undefined: no es un vehículo de esta fuente o su ruta no tiene trazado.
     */
    path(vehicleId) {
      const p = paths.get(vehicleId);
      if (p?.stops) return undefined; // sin trazado: sus posiciones ya van en línea recta entre paradas
      return p ? stretch(p.shape, p.from, p.to) : p;
    },
    /** Lo que le queda hasta la última parada de su viaje, por su trazado o, si no tiene, uniendo sus
     * paradas (null o undefined como en path). */
    ahead(vehicleId) {
      const p = paths.get(vehicleId);
      if (p?.stops) return [p.at, ...p.stops].map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
      return p ? stretch(p.shape, p.to, p.end) : p;
    },
    async fetch() {
      // Se recarga cada día (sólo se guardan los viajes de hoy y los de ayer que pasan de medianoche).
      const today = madridServiceDay(Date.now(), 0).ymd;
      if (!loaded.size || today !== loadedDay || Date.now() - loadedAt > RELOAD_MS) await load(today);
      else if (failed.size && Date.now() - failedAt >= RETRY_MS) await load(today, [...failed]);
      const first = loaded.get(0)?.schedule;
      const rt = tripUpdatesUrl && first ? delaysFromTripUpdates(decodeFeed(await http.bytes(tripUpdatesUrl)), first) : null;
      const now = Date.now();
      const vehicles = [];
      const nextPaths = new Map();
      for (const [fi, { schedule }] of loaded) {
        // Un tren que salió antes de medianoche pertenece al día de servicio anterior.
        for (const dayOffset of [0, -1]) {
          const day = madridServiceDay(now, dayOffset);
          const t = Math.floor((now - day.midnight) / 1000);
          for (const trip of schedule.trips) {
            if (rt) {
              const live = rt.get(trip.id);
              if (!live || (live.ymd && live.ymd !== day.ymd)) continue;
              const v = vehicle(fi, schedule, trip, day, t - live.delay, live.delay, 0, nextPaths);
              if (v) vehicles.push(v);
              continue;
            }
            if (!serviceRuns(schedule.calendar.get(trip.serviceId), schedule.exceptions.get(trip.serviceId), day.ymd, day.weekday)) continue;
            if (!trip.freqs.length) {
              const v = vehicle(fi, schedule, trip, day, t, null, 0, nextPaths);
              if (v) vehicles.push(v);
              continue;
            }
            const duration = trip.last - trip.first;
            for (const fr of trip.freqs) {
              for (const off of activeFrequencyOffsets(fr, trip.first, duration, t)) {
                const v = vehicle(fi, schedule, trip, day, t, null, off, nextPaths);
                if (v) vehicles.push(v);
              }
            }
          }
        }
      }
      paths = nextPaths;
      // En los grupos, la fecha del horario más reciente y la del más antiguo.
      const dates = [...loaded.values()].map((l) => l.updatedAt).filter(Boolean);
      return {
        vehicles,
        datasetUpdated: dates.length ? Math.max(...dates) : null,
        datasetUpdatedFrom: dates.length > 1 ? Math.min(...dates) : null,
      };
    },
  };
}
