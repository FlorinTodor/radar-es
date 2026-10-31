// Posición estimada a partir del horario GTFS (del NAP) para operadores que no publican GPS.
// - Sin tiempo real (Ouigo, metros, tranvías, autobuses): se colocan donde dice el horario.
// - Con trip updates GTFS-RT (Euskotren): sólo los viajes en curso, desplazados por su retraso real.
// Las posiciones se marcan `estimated` (anillo hueco en el mapa) y no cuentan para alertas.
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { modeOf } from '../gtfs/gtfs-modes.js';
import { decodeFeed } from './gtfs-rt.js';
import { activeFrequencyOffsets, buildShape, gtfsTimeToSeconds, pointAlong, scheduledPosition, serviceRuns, stopsAlongShape } from '../../../domain/schedule.js';
import { madridLocalToMs } from './parse.js';
import { napDatasetPage } from '../nap/nap-client.js';

const RELOAD_MS = 24 * 3600_000;
const DAY_S = 86_400;

// Los horarios se cargan de uno en uno en todo el servidor: al arrancar (o al cambiar de día) se
// juntarían en memoria decenas de ZIP descomprimidos a la vez.
let loadQueue = Promise.resolve();
const oneAtATime = (fn) => {
  const run = loadQueue.then(fn, fn);
  loadQueue = run.catch(() => {});
  return run;
};
// route_type de autobús (básico y extendido): con mode 'bus' sólo se cogen estas rutas, para no
// duplicar el metro o el tranvía que algunos operadores publican en el mismo GTFS (TMB, TUSSAM…).
const isBusRoute = (type) => {
  const n = Number(type);
  return n === 3 || n === 11 || (n >= 200 && n < 300) || (n >= 700 && n < 800);
};
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const titleCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()));

/**
 * @param {{ today: { ymd: string, weekday: number }, yesterday: { ymd: string, weekday: number } }} days
 *   Sólo se guardan los viajes de hoy y los de ayer que siguen pasada la medianoche: los horarios
 *   grandes (ALSA, TMB, AMB…) suman millones de paradas programadas y no caben enteros en memoria.
 *   Por eso el horario se recarga al cambiar de día.
 * @param {{ excludeAgency?: RegExp, excludeRoute?: RegExp }} [filter]  Agencias (por nombre) o rutas (por nombre corto)
 *   que ya llegan por otra fuente, para no pintar dos veces el mismo vehículo.
 */
function parseSchedule(zip, forcedMode, days, { excludeAgency, excludeRoute } = {}) {
  const f = openGtfs(zip, ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'shapes.txt']);

  const agencies = new Map([...csvRows(f['agency.txt'])].map((a) => [a.agency_id, a.agency_name]));
  const routes = new Map();
  for (const r of csvRows(f['routes.txt'])) {
    if (excludeAgency?.test(agencies.get(r.agency_id) ?? '') || excludeRoute?.test(r.route_short_name)) continue;
    const mode = forcedMode === 'bus' ? (isBusRoute(r.route_type) ? 'bus' : null) : forcedMode ?? modeOf(r.route_type);
    if (mode) routes.set(r.route_id, { mode, line: r.route_short_name || r.route_long_name || null });
  }

  const stopList = [];
  const stopIndex = new Map();
  for (const s of csvRows(f['stops.txt'])) {
    if (!Number.isFinite(+s.stop_lat) || !Number.isFinite(+s.stop_lon)) continue;
    stopIndex.set(s.stop_id, stopList.length);
    stopList.push({ stopId: s.stop_id, name: titleCase(s.stop_name), lat: +s.stop_lat, lon: +s.stop_lon });
  }

  const calendar = new Map();
  for (const c of csvRows(f['calendar.txt'])) calendar.set(c.service_id, { start: c.start_date, end: c.end_date, days: DAYS.map((d) => c[d] === '1') });
  const wanted = new Set([days.today.ymd, days.yesterday.ymd]);
  const exceptions = new Map();
  for (const d of csvRows(f['calendar_dates.txt'])) {
    if (!wanted.has(d.date)) continue;
    if (!exceptions.has(d.service_id)) exceptions.set(d.service_id, new Map());
    exceptions.get(d.service_id).set(d.date, +d.exception_type);
  }

  const active = new Map(); // service_id → [circula hoy, circulaba ayer]
  const runs = (id) => {
    if (!active.has(id)) {
      active.set(id, [days.today, days.yesterday].map((d) => serviceRuns(calendar.get(id), exceptions.get(id), d.ymd, d.weekday)));
    }
    return active.get(id);
  };
  const trips = new Map();
  for (const t of csvRows(f['trips.txt'])) {
    const route = routes.get(t.route_id);
    const [today, yesterday] = runs(t.service_id);
    if (route && (today || yesterday)) {
      trips.set(t.trip_id, { id: t.trip_id, serviceId: t.service_id, route, label: t.trip_short_name || null, today, shapeId: t.shape_id || null, raw: [], freqs: [] });
    }
  }
  // Las paradas de todos los viajes van en un único array tipado (seq, índice de parada, llegada,
  // salida): como objetos, o con un array por viaje, ocuparían cientos de MB.
  for (const st of csvRows(f['stop_times.txt'])) {
    const trip = trips.get(st.trip_id);
    const si = trip && stopIndex.get(st.stop_id);
    if (si === undefined) continue;
    const arr = gtfsTimeToSeconds(st.arrival_time || st.departure_time);
    const dep = gtfsTimeToSeconds(st.departure_time || st.arrival_time);
    if (arr !== null && dep !== null) trip.raw.push(+st.stop_sequence, si, arr, dep);
  }
  for (const fr of csvRows(f['frequencies.txt'])) {
    const trip = trips.get(fr.trip_id);
    const start = gtfsTimeToSeconds(fr.start_time);
    const end = gtfsTimeToSeconds(fr.end_time);
    if (trip && start !== null && end !== null) trip.freqs.push({ start, end, headway: +fr.headway_secs });
  }
  const kept = [];
  let total = 0;
  for (const t of trips.values()) {
    const n = t.raw.length / 4;
    if (n < 2) continue;
    // De ayer sólo interesan los viajes que siguen circulando pasada la medianoche.
    const ends = Math.max(...Array.from({ length: n }, (_, i) => t.raw[i * 4 + 2]));
    const latest = t.freqs.length ? Math.max(...t.freqs.map((fr) => fr.end)) + ends : ends;
    if (!t.today && latest <= DAY_S) continue;
    kept.push(t);
    total += t.raw.length;
  }
  // Trazados (shapes.txt), sólo los de los viajes que se quedan y aligerados (buildShape).
  const wantedShapes = new Set(kept.map((t) => t.shapeId).filter(Boolean));
  // Cada trazado se lee en un array plano [seq, lon, lat, seq, lon, lat…]: un array por punto
  // ocuparía varias veces más mientras se carga (hay GTFS con 800.000 puntos).
  const shapePoints = new Map();
  for (const p of csvRows(f['shapes.txt'])) {
    if (!wantedShapes.has(p.shape_id)) continue;
    const lon = +p.shape_pt_lon;
    const lat = +p.shape_pt_lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!shapePoints.has(p.shape_id)) shapePoints.set(p.shape_id, []);
    shapePoints.get(p.shape_id).push(+p.shape_pt_sequence, lon, lat);
  }
  const shapes = [];
  const shapeIndex = new Map();
  for (const [sid, raw] of shapePoints) {
    const n = raw.length / 3;
    if (n < 2) continue;
    let order = null; // casi siempre vienen ya en orden: sólo se ordena si hace falta
    for (let i = 1; i < n && !order; i++) if (raw[i * 3] < raw[(i - 1) * 3]) order = Array.from({ length: n }, (_, k) => k).sort((a, b) => raw[a * 3] - raw[b * 3]);
    const lonLat = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const src = order ? order[i] : i;
      lonLat[i * 2] = raw[src * 3 + 1];
      lonLat[i * 2 + 1] = raw[src * 3 + 2];
    }
    shapeIndex.set(sid, shapes.length);
    shapes.push(buildShape(lonLat));
    shapePoints.set(sid, null); // libera el array crudo en cuanto se usa
  }
  shapePoints.clear();

  const times = new Int32Array(total);
  const compact = [];
  let offset = 0;
  for (const t of kept) {
    const n = t.raw.length / 4;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t.raw[a * 4] - t.raw[b * 4]);
    order.forEach((src, i) => times.set(t.raw.slice(src * 4, src * 4 + 4), offset + i * 4));
    compact.push({ id: t.id, serviceId: t.serviceId, route: t.route, label: t.label, freqs: t.freqs, at: offset, n,
      first: times[offset + 3], last: times[offset + (n - 1) * 4 + 2], shape: shapeIndex.get(t.shapeId) ?? -1 });
    offset += n * 4;
  }
  return { calendar, exceptions, stopList, times, trips: compact, shapes };
}

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

/**
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>, http: import('../http/http-client.js').HttpClient,
 *           log?: import('../../../application/ports.js').LoggerPort }} deps
 * @param {{ id: string, name: string, operator?: string, ficheroId?: number, dataset?: number, feeds?: Feed[], credit?: string,
 *           license?: string, interval?: number, mode?: import('../../../domain/model.js').Mode, tripUpdatesUrl?: string,
 *           label?: (trip: object) => string, line?: (name: string|null) => string|null }} options
 *   dataset: conjunto de datos del NAP al que pertenece el fichero (para su fecha de actualización).
 *   feeds: varios ficheros en una sola fuente (empresas con muchos conjuntos), en lugar de ficheroId/dataset/operator.
 *   credit: atribución que pide el propio operador además de la del NAP ("Powered by CRTM"…).
 * @typedef {{ ficheroId: number, dataset: number, operator: string, excludeAgency?: RegExp, excludeRoute?: RegExp }} Feed
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsScheduleSource({ nap, http, log }, options) {
  const { id, name, mode, tripUpdatesUrl, interval = 30_000 } = options;
  const feeds = options.feeds ?? [{ ficheroId: options.ficheroId, dataset: options.dataset, operator: options.operator }];
  const loaded = new Map(); // índice del fichero → { schedule, updatedAt }
  let loadedAt = 0;
  let loadedDay = null; // día de servicio (Madrid) para el que se cargaron los horarios

  function vehicle(fi, schedule, trip, day, t, delaySec, offset = 0) {
    const tt = t - offset;
    if (tt < trip.first || tt > trip.last) return null; // descarte barato antes de crear objetos
    const stops = tripStops(trip, schedule);
    const pos = scheduledPosition(stops, tt);
    if (!pos) return null;
    let { lat, lon } = pos;
    let atLastStop = false;
    if (!pos.atStop) {
      const along = alongShape(schedule, trip, stops);
      if (along) {
        // Por su recorrido: a la misma fracción del tramo entre paradas, pero medida sobre el trazado.
        ({ lat, lon } = pointAlong(schedule.shapes[trip.shape], along[pos.i] + (along[pos.i + 1] - along[pos.i]) * pos.k));
      } else if (trip.route.mode === 'bus') {
        // Sin trazado, en línea recta un autobús interurbano cruzaría el campo: se deja en la última
        // parada por la que ha pasado. Los trenes sí siguen la recta (las vías suelen ser bastante rectas).
        ({ lat, lon } = pos.prev);
        atLastStop = true;
      }
    }
    const { operator } = feeds[fi];
    const instance = offset ? `:${offset}` : '';
    return {
      id: `${id}:${feeds.length > 1 ? `${fi}:` : ''}${trip.id}:${day.ymd}${instance}`,
      mode: trip.route.mode,
      operator,
      service: operator,
      line: options.line ? options.line(trip.route.line) : trip.route.line,
      label: options.label?.(trip) ?? trip.label ?? null,
      lat,
      lon,
      delay: delaySec === null ? null : Math.round(delaySec / 60),
      estimated: true,
      atLastStop,
      origin: stops[0].name,
      destination: stops.at(-1).name,
      current: pos.atStop || atLastStop ? pos.prev.name : null,
      next: pos.atStop ? pos.next?.name ?? null : pos.next.name,
      nextEta: pos.next ? `${day.iso}T${hhmmss(pos.next.arr + offset + (delaySec ?? 0))}` : null,
    };
  }

  /** Carga los horarios (de uno en uno en todo el servidor); si falla un fichero de un grupo, el resto sigue. */
  async function load(today) {
    const days = { today: madridServiceDay(Date.now(), 0), yesterday: madridServiceDay(Date.now(), -1) };
    for (const [fi, feed] of feeds.entries()) {
      try {
        const schedule = await oneAtATime(async () => parseSchedule(await nap.gtfs(feed.ficheroId, RELOAD_MS), mode, days, feed));
        const updatedAt = await nap.updatedAt(feed.dataset, feed.ficheroId).then(madridLocalToMs).catch(() => loaded.get(fi)?.updatedAt ?? null);
        loaded.set(fi, { schedule, updatedAt });
      } catch (err) {
        if (feeds.length === 1) throw err;
        log?.warn(`[${id}] ${feed.operator} (fichero ${feed.ficheroId}): ${err.message}`);
      }
    }
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
    async fetch() {
      // Se recarga cada día (sólo se guardan los viajes de hoy y los de ayer que pasan de medianoche).
      const today = madridServiceDay(Date.now(), 0).ymd;
      if (!loaded.size || today !== loadedDay || Date.now() - loadedAt > RELOAD_MS) await load(today);
      const first = loaded.get(0)?.schedule;
      const rt = tripUpdatesUrl && first ? delaysFromTripUpdates(decodeFeed(await http.bytes(tripUpdatesUrl)), first) : null;
      const now = Date.now();
      const vehicles = [];
      for (const [fi, { schedule }] of loaded) {
        // Un tren que salió antes de medianoche pertenece al día de servicio anterior.
        for (const dayOffset of [0, -1]) {
          const day = madridServiceDay(now, dayOffset);
          const t = Math.floor((now - day.midnight) / 1000);
          for (const trip of schedule.trips) {
            if (rt) {
              const live = rt.get(trip.id);
              if (!live || (live.ymd && live.ymd !== day.ymd)) continue;
              const v = vehicle(fi, schedule, trip, day, t - live.delay, live.delay);
              if (v) vehicles.push(v);
              continue;
            }
            if (!serviceRuns(schedule.calendar.get(trip.serviceId), schedule.exceptions.get(trip.serviceId), day.ymd, day.weekday)) continue;
            if (!trip.freqs.length) {
              const v = vehicle(fi, schedule, trip, day, t, null);
              if (v) vehicles.push(v);
              continue;
            }
            const duration = trip.last - trip.first;
            for (const fr of trip.freqs) {
              for (const off of activeFrequencyOffsets(fr, trip.first, duration, t)) {
                const v = vehicle(fi, schedule, trip, day, t, null, off);
                if (v) vehicles.push(v);
              }
            }
          }
        }
      }
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
