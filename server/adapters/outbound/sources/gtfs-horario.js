// Posición estimada a partir del horario GTFS (del NAP) para operadores que no publican GPS.
// - Sin tiempo real (Ouigo, metros, tranvías, autobuses): se colocan donde dice el horario.
// - Con trip updates GTFS-RT (Euskotren, AMB): sólo los viajes en curso, desplazados por su retraso real.
// Las posiciones se marcan `estimated` (anillo hueco en el mapa) y no cuentan para alertas.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeFeed } from './gtfs-rt.js';
import { activeFrequencyOffsets, buildShape, pointAlong, serviceRuns, stopsAlongShape } from '../../../domain/schedule.js';
import { refineToRail } from '../../../domain/rail-match.js';
import { estimatePosition } from '../../../domain/estimated-position.js';
import { round5 } from '../../../domain/geo.js';
import { madridLocalToMs } from './parse.js';
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
// Sin pool inyectado (tests, herramientas), los horarios se leen en el hilo principal de uno en uno.
const inlinePool = createCpuPool({ threads: 0 });

/**
 * Paradas de un viaje como objetos, sólo cuando hace falta (viajes en circulación). Con `keep`, se
 * guardan en el viaje mientras circula: montarlas en cada lectura, para miles de autobuses, era casi
 * todo el trabajo (ver vehicle(), que las suelta cuando el viaje acaba).
 */
function tripStops(trip, { times, stopList }, keep = false) {
  if (trip.stopObjects) return trip.stopObjects;
  const out = [];
  for (let i = trip.at; i < trip.at + trip.n * 4; i += 4) {
    out.push({ seq: times[i], ...stopList[times[i + 1]], arr: times[i + 2], dep: times[i + 3] });
  }
  if (keep) trip.stopObjects = out;
  return out;
}

// Trazados por la vía (domain/rail-match.js, refineToRail): los de cada horario se rehacen la primera vez
// que circula un viaje que los usa, y no más de REFINE_PER_READ en cada lectura (al llegar la red de
// vías, cientos de viajes a la vez pararían la web; los demás esperan a la lectura siguiente).
const REFINE_PER_READ = 40;

/** Puntos [lon, lat] de un trazado preparado (buildShape). */
function shapePoints(shape) {
  const out = [];
  for (let i = 0; i + 1 < shape.coords.length; i += 2) out.push([shape.coords[i], shape.coords[i + 1]]);
  return out;
}

const MADRID_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' });

/** Día de servicio en Madrid desplazado `offset` días. */
function madridServiceDay(now, offset) {
  const [y, m, d] = MADRID_DATE.format(now).split('-').map(Number);
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
  const at = (d) => { const q = pointAlong(shape, d); return [round5(q.lon), round5(q.lat)]; };
  const out = [at(from)];
  for (let i = 0; i < dist.length; i++) if (dist[i] > from && dist[i] < to) out.push([round5(coords[i * 2]), round5(coords[i * 2 + 1])]);
  out.push(at(to));
  return out;
}

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>, http: import('../http/http-client.js').HttpClient,
 *           log?: import('../../../application/ports.js').LoggerPort, pool?: import('../workers/cpu-pool.js').CpuPool,
 *           railGeometry?: import('../../../application/ports.js').RailNetworkPort | null }} deps
 *   railGeometry: red de vías detallada (con metro y tranvía) para llevar a la vía los trazados que se
 *   salen de ella; sin ella, los de cada operador tal cual.
 *   pool: hilos de cálculo donde se leen los horarios (de uno en uno por hilo en todo el servidor: al
 *   arrancar, o al cambiar de día, se juntarían en memoria decenas de ZIP descomprimidos a la vez).
 * @param {{ id: string, name: string, operator?: string, ficheroId?: number, dataset?: number, feeds?: Feed[], credit?: string,
 *           license?: string, interval?: number, mode?: import('../../../domain/model.js').Mode, tripUpdatesUrl?: string,
 *           label?: (trip: object) => string, line?: (name: string|null) => string|null }} options
 *   dataset: conjunto de datos del NAP al que pertenece el fichero (para su fecha de actualización).
 *   feeds: varios ficheros en una sola fuente (empresas con muchos conjuntos), en lugar de ficheroId/dataset/operator.
 *   credit: atribución que pide el propio operador además de la del NAP ("Powered by CRTM"…). En un grupo,
 *   la que pide uno solo de sus operadores va en su fichero (Feed.credit) y no en la de todo el grupo.
 * @typedef {{ ficheroId: number, dataset: number, operator: string, credit?: string, excludeAgency?: RegExp, excludeRoute?: RegExp }} Feed
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsScheduleSource({ nap, http, log, cache, pool = inlinePool, railGeometry = null }, options) {
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
  // Los que no son autobuses pueden ir por las vías del IGN (ver tripShape): su licencia pide citarlas.
  const viaCredit = mode !== 'bus' && railGeometry?.credit ? ` · trazado por la vía: ${railGeometry.credit}` : '';
  const estimatedLicense = (credit) => `Powered by MITRAMS (Punto de Acceso Nacional) · ${credit} · `
    + `Posición estimada a partir del horario (dato explotado, no GPS)${viaCredit}`;
  const feedCredit = (f) => f.credit ?? f.operator;
  let refineBudget = REFINE_PER_READ; // trazados que aún se pueden rehacer en esta lectura

  /**
   * Trazado del viaje y distancia de cada parada sobre él (se calcula una vez por viaje, sólo para los que
   * llegan a circular); null si no tiene o sus paradas no encajan en él. Con la red de vías, los tramos que
   * se salen de la vía se rehacen por ella, y un viaje de metro, tranvía o tren sin trazado (o con uno que
   * no pasa por sus paradas: en el TRAM d'Alacant hay viajes con el de otra línea) lo toma de la vía entre
   * sus paradas. Los autobuses no: no van por vías.
   */
  function tripShape(schedule, trip, stops) {
    const net = trip.route.mode === 'bus' ? null : railGeometry?.network() ?? null;
    if (trip.onShape !== undefined && trip.onShapeNet === net) return trip.onShape;
    if (net && schedule.onRail?.net !== net) schedule.onRail = { net, shapes: new Map(), byStops: new Map() };
    let complete = true; // false: algún trazado se queda para la próxima lectura (sin turno en esta)
    /** El trazado por la vía de estos puntos, guardado por clave; undefined si en esta lectura ya no hay turno. */
    const onRail = (memo, key, points, unchanged) => {
      if (!memo.has(key)) {
        if (refineBudget <= 0) {
          complete = false;
          return undefined;
        }
        refineBudget--;
        const pts = points();
        const out = refineToRail(net, pts);
        memo.set(key, out === pts ? unchanged : buildShape(out.flat()));
      }
      return memo.get(key);
    };
    const original = trip.shape >= 0 ? schedule.shapes[trip.shape] : null;
    let shape = null;
    let along = null;
    if (original) {
      const refined = net ? onRail(schedule.onRail.shapes, trip.shape, () => shapePoints(original), original) ?? original : original;
      along = stopsAlongShape(stops, refined);
      shape = refined;
      if (!along && refined !== original) {
        along = stopsAlongShape(stops, original); // las paradas no encajan en el rehecho: el del operador
        shape = original;
      }
    }
    if (!along && net) {
      const key = stops.map((st) => `${st.lon},${st.lat}`).join(';');
      const byStops = onRail(schedule.onRail.byStops, key, () => stops.map((st) => [st.lon, st.lat]), null);
      const fit = byStops ? stopsAlongShape(stops, byStops) : null;
      if (fit) {
        shape = byStops;
        along = fit;
      }
    }
    if (!complete && trip.onShape !== undefined) return trip.onShape; // el de antes, hasta la próxima lectura
    trip.onShape = along ? { shape, along } : null;
    trip.onShapeNet = complete ? net : null;
    return trip.onShape;
  }

  function vehicle(fi, schedule, trip, day, t, delaySec, offset = 0, nextPaths = paths) {
    const tt = t - offset;
    if (tt < trip.first || tt > trip.last) { // descarte barato antes de crear objetos
      if (tt > trip.last) trip.stopObjects = undefined; // ya ha acabado: no hace falta guardarlas
      return null;
    }
    const stops = tripStops(trip, schedule, true);
    const onShape = tripShape(schedule, trip, stops);
    // Dónde está, lo recorrido, lo que le queda y hacia dónde va: reglas del dominio.
    const est = estimatePosition({ stops, mode: trip.route.mode, shape: onShape?.shape ?? null, along: onShape?.along ?? null, t: tt });
    if (!est) return null;
    const instance = offset ? `:${offset}` : '';
    const vid = `${id}:${feeds.length > 1 ? `${fi}:` : ''}${trip.id}:${day.ymd}${instance}`;
    if (est.path !== undefined) nextPaths.set(vid, est.path);
    const { operator } = feeds[fi];
    return {
      id: vid,
      mode: trip.route.mode,
      operator,
      service: operator,
      line: options.line ? options.line(trip.route.line) : trip.route.line,
      label: options.label?.(trip) ?? trip.label ?? null,
      lat: est.lat,
      lon: est.lon,
      delay: delaySec === null ? null : Math.round(delaySec / 60),
      estimated: true,
      ...(est.ahead ? { ahead: true } : {}),
      ...(est.heading !== null ? { heading: est.heading } : {}),
      atLastStop: est.atLastStop,
      origin: stops[0].name,
      destination: stops.at(-1).name,
      current: est.current,
      next: est.next,
      nextEta: est.nextArr !== null ? `${day.iso}T${hhmmss(est.nextArr + offset + (delaySec ?? 0))}` : null,
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
        // La licencia pide citar esta fecha: si el NAP no la da, se avisa y se sigue con la anterior.
        const updatedAt = await nap.updatedAt(feed.dataset, feed.ficheroId).then(madridLocalToMs).catch((err) => {
          log?.warn(`[${id}] ${feed.operator}: sin fecha de actualización del NAP (${err.message})`);
          return loaded.get(fi)?.updatedAt ?? null;
        });
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
    license: options.license ?? estimatedLicense(options.credit
      ?? [...new Set(feeds.map((f) => (f.credit ? `${f.operator} (${f.credit})` : f.operator)))].join(', ')),
    // En un grupo, la ficha de cada vehículo cita sólo a su operador (y lo que este pida, como TMB).
    ...(feeds.length > 1 ? { operatorLicenses: Object.fromEntries(feeds.map((f) => [f.operator, estimatedLicense(feedCredit(f))])) } : {}),
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
      if (p?.stops) return [p.at, ...p.stops].map(([lon, lat]) => [round5(lon), round5(lat)]);
      return p ? stretch(p.shape, p.to, p.end) : p;
    },
    async fetch() {
      refineBudget = REFINE_PER_READ;
      // Se recarga cada día (sólo se guardan los viajes de hoy y los de ayer que pasan de medianoche).
      const today = madridServiceDay(Date.now(), 0).ymd;
      if (!loaded.size || today !== loadedDay || Date.now() - loadedAt > RELOAD_MS) await load(today);
      else if (failed.size && Date.now() - failedAt >= RETRY_MS) await load(today, [...failed]);
      const first = loaded.get(0)?.schedule;
      const rtFeed = tripUpdatesUrl && first ? decodeFeed(await http.bytes(tripUpdatesUrl)) : null;
      const rt = rtFeed ? delaysFromTripUpdates(rtFeed, first) : null;
      const now = Date.now();
      const vehicles = [];
      const nextPaths = new Map();
      // Un tren que salió antes de medianoche pertenece al día de servicio anterior.
      const serviceDays = [madridServiceDay(now, 0), madridServiceDay(now, -1)];
      for (const [fi, { schedule }] of loaded) {
        for (const day of serviceDays) {
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
      // En los grupos, la fecha del horario más reciente, la del más antiguo y la de cada operador.
      const dates = [...loaded.values()].map((l) => l.updatedAt).filter(Boolean);
      const byOperator = {};
      if (feeds.length > 1) {
        for (const [fi, { updatedAt }] of loaded) {
          const op = feeds[fi].operator;
          if (updatedAt && updatedAt > (byOperator[op] ?? 0)) byOperator[op] = updatedAt;
        }
      }
      return {
        vehicles,
        datasetUpdated: dates.length ? Math.max(...dates) : null,
        datasetUpdatedFrom: dates.length > 1 ? Math.min(...dates) : null,
        ...(feeds.length > 1 ? { datasetUpdatedBy: byOperator } : {}),
        // Hora de los retrasos en tiempo real (AMB, Euskotren), la que hay que citar con ellos.
        ...(rtFeed ? { sourceTime: Number(rtFeed.header?.timestamp) * 1000 || null } : {}),
      };
    },
  };
}
