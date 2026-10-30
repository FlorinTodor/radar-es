// Posición estimada a partir del horario GTFS (del NAP) para operadores que no publican GPS.
// - Sin tiempo real (Ouigo, metros y tranvías): se colocan los trenes donde dice el horario.
// - Con trip updates GTFS-RT (Euskotren): sólo los viajes en curso, desplazados por su retraso real.
// Las posiciones se marcan `estimated` (anillo hueco en el mapa) y no cuentan para alertas.
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { modeOf } from '../gtfs/gtfs-modes.js';
import { decodeFeed } from './gtfs-rt.js';
import { activeFrequencyOffsets, gtfsTimeToSeconds, scheduledPosition, serviceRuns } from '../../../domain/schedule.js';
import { madridLocalToMs } from './parse.js';

const RELOAD_MS = 24 * 3600_000;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const titleCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase()));

function parseSchedule(zip, forcedMode) {
  const f = openGtfs(zip, ['routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt']);

  const routes = new Map();
  for (const r of csvRows(f['routes.txt'])) {
    const mode = forcedMode ?? modeOf(r.route_type);
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
  const exceptions = new Map();
  for (const d of csvRows(f['calendar_dates.txt'])) {
    if (!exceptions.has(d.service_id)) exceptions.set(d.service_id, new Map());
    exceptions.get(d.service_id).set(d.date, +d.exception_type);
  }

  const trips = new Map();
  for (const t of csvRows(f['trips.txt'])) {
    const route = routes.get(t.route_id);
    if (route) trips.set(t.trip_id, { id: t.trip_id, serviceId: t.service_id, route, label: t.trip_short_name || null, raw: [], freqs: [] });
  }
  // Las paradas se guardan en arrays tipados (seq, índice de parada, llegada, salida): las redes
  // grandes tienen más de un millón de horarios y como objetos ocuparían cientos de MB.
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
  const compact = [];
  for (const t of trips.values()) {
    const n = t.raw.length / 4;
    if (n < 2) continue;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => t.raw[a * 4] - t.raw[b * 4]);
    const times = new Int32Array(n * 4);
    order.forEach((src, i) => times.set(t.raw.slice(src * 4, src * 4 + 4), i * 4));
    compact.push({ id: t.id, serviceId: t.serviceId, route: t.route, label: t.label, freqs: t.freqs, times, first: times[3], last: times[(n - 1) * 4 + 2] });
  }
  return { calendar, exceptions, stopList, trips: compact };
}

/** Paradas de un viaje como objetos, sólo cuando hace falta (viajes en circulación). */
function tripStops(trip, stopList) {
  const out = [];
  for (let i = 0; i < trip.times.length; i += 4) {
    out.push({ seq: trip.times[i], ...stopList[trip.times[i + 1]], arr: trip.times[i + 2], dep: trip.times[i + 3] });
  }
  return out;
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
    const stops = tripStops(trip, schedule.stopList);
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
 * @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>, http: import('../http/http-client.js').HttpClient }} deps
 * @param {{ id: string, name: string, operator: string, ficheroId: number, license?: string, interval?: number,
 *           mode?: import('../../../domain/model.js').Mode, tripUpdatesUrl?: string, label?: (trip: object) => string }} options
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsScheduleSource({ nap, http }, options) {
  const { id, name, operator, ficheroId, mode, tripUpdatesUrl, interval = 30_000 } = options;
  let schedule = null;
  let loadedAt = 0;

  function vehicle(trip, day, t, delaySec, offset = 0) {
    const tt = t - offset;
    if (tt < trip.first || tt > trip.last) return null; // descarte barato antes de crear objetos
    const stops = tripStops(trip, schedule.stopList);
    const pos = scheduledPosition(stops, tt);
    if (!pos) return null;
    const instance = offset ? `:${offset}` : '';
    return {
      id: `${id}:${trip.id}:${day.ymd}${instance}`,
      mode: trip.route.mode,
      operator,
      service: operator,
      line: trip.route.line,
      label: options.label?.(trip) ?? trip.label ?? null,
      lat: pos.lat,
      lon: pos.lon,
      delay: delaySec === null ? null : Math.round(delaySec / 60),
      estimated: true,
      origin: stops[0].name,
      destination: stops.at(-1).name,
      current: pos.atStop ? pos.prev.name : null,
      next: pos.atStop ? pos.next?.name ?? null : pos.next.name,
      nextEta: pos.next ? `${day.iso}T${hhmmss(pos.next.arr + offset + (delaySec ?? 0))}` : null,
    };
  }

  return {
    id,
    name,
    kind: 'vehicles',
    interval,
    requires: ['NAP_API_KEY'],
    url: tripUpdatesUrl ?? 'https://nap.transportes.gob.es',
    license: options.license ?? `Powered by MITRAMS (Punto de Acceso Nacional, transportes.gob.es) · ${operator}. Posición estimada a partir del horario (dato explotado, no GPS)`,
    async fetch() {
      if (!schedule || Date.now() - loadedAt > RELOAD_MS) {
        schedule = parseSchedule(await nap.gtfs(ficheroId, RELOAD_MS), mode);
        loadedAt = Date.now();
      }
      const rt = tripUpdatesUrl ? delaysFromTripUpdates(decodeFeed(await http.bytes(tripUpdatesUrl)), schedule) : null;
      const now = Date.now();
      const vehicles = [];
      // Un tren que salió antes de medianoche pertenece al día de servicio anterior.
      for (const dayOffset of [0, -1]) {
        const day = madridServiceDay(now, dayOffset);
        const t = Math.floor((now - day.midnight) / 1000);
        for (const trip of schedule.trips) {
          if (rt) {
            const live = rt.get(trip.id);
            if (!live || (live.ymd && live.ymd !== day.ymd)) continue;
            const v = vehicle(trip, day, t - live.delay, live.delay);
            if (v) vehicles.push(v);
            continue;
          }
          if (!serviceRuns(schedule.calendar.get(trip.serviceId), schedule.exceptions.get(trip.serviceId), day.ymd, day.weekday)) continue;
          if (!trip.freqs.length) {
            const v = vehicle(trip, day, t, null);
            if (v) vehicles.push(v);
            continue;
          }
          const first = trip.first;
          const duration = trip.last - first;
          for (const fr of trip.freqs) {
            for (const off of activeFrequencyOffsets(fr, first, duration, t)) {
              const v = vehicle(trip, day, t, null, off);
              if (v) vehicles.push(v);
            }
          }
        }
      }
      return { vehicles };
    },
  };
}
