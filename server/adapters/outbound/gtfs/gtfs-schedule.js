// Lectura de un horario GTFS para estimar posiciones (fuentes "según horario"): de un ZIP del NAP a
// una estructura compacta con sólo los viajes de hoy y los de ayer que pasan de medianoche.
// Es trabajo de CPU puro (sin E/S ni estado): se puede ejecutar en un hilo aparte (workers/) o en el
// principal, y por eso devuelve casi todo en arrays tipados, que pasan entre hilos sin copiarse.
import { createPacer, csvColumns, csvRows, openGtfs, own } from './gtfs-reader.js';
import { modeOf } from './gtfs-modes.js';
import { buildShape, gtfsTimeToSeconds, serviceRuns } from '../../../domain/schedule.js';

const DAY_S = 86_400;

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
export async function parseSchedule(zip, forcedMode, days, { excludeAgency, excludeRoute } = {}) {
  const pace = createPacer(); // horarios de millones de filas: sin bloquear el servidor mientras se leen
  const f = await openGtfs(zip, ['agency.txt', 'routes.txt', 'trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt', 'frequencies.txt', 'shapes.txt']);

  const agencies = new Map([...csvRows(f['agency.txt'])].map((a) => [a.agency_id, a.agency_name]));
  const routes = new Map();
  for (const r of csvRows(f['routes.txt'])) {
    if (excludeAgency?.test(agencies.get(r.agency_id) ?? '') || excludeRoute?.test(r.route_short_name)) continue;
    const mode = forcedMode === 'bus' ? (isBusRoute(r.route_type) ? 'bus' : null) : forcedMode ?? modeOf(r.route_type);
    if (mode) routes.set(r.route_id, { mode, line: r.route_short_name || r.route_long_name || null });
  }

  const stopList = [];
  const stopIndex = new Map();
  for (const [stopId, stopName, lat, lon] of csvColumns(f['stops.txt'], ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'])) {
    if (!Number.isFinite(+lat) || !Number.isFinite(+lon)) continue;
    const id = own(stopId);
    stopIndex.set(id, stopList.length);
    stopList.push({ stopId: id, name: own(titleCase(stopName)), lat: +lat, lon: +lon });
  }

  const calendar = new Map();
  for (const c of csvRows(f['calendar.txt'])) calendar.set(c.service_id, { start: c.start_date, end: c.end_date, days: DAYS.map((d) => c[d] === '1') });
  const wanted = new Set([days.today.ymd, days.yesterday.ymd]);
  const exceptions = new Map();
  for (const [serviceId, date, type] of csvColumns(f['calendar_dates.txt'], ['service_id', 'date', 'exception_type'])) {
    if (pace.due()) await pace.pause();
    if (!wanted.has(date)) continue;
    if (!exceptions.has(serviceId)) exceptions.set(own(serviceId), new Map());
    exceptions.get(serviceId).set(own(date), +type);
  }

  const active = new Map(); // service_id → [circula hoy, circulaba ayer]
  const runs = (id) => {
    if (!active.has(id)) {
      active.set(id, [days.today, days.yesterday].map((d) => serviceRuns(calendar.get(id), exceptions.get(id), d.ymd, d.weekday)));
    }
    return active.get(id);
  };
  const trips = new Map();
  const tripColumns = ['trip_id', 'route_id', 'service_id', 'trip_short_name', 'shape_id'];
  for (const [tripId, routeId, serviceId, shortName, shapeId] of csvColumns(f['trips.txt'], tripColumns)) {
    if (pace.due()) await pace.pause();
    const route = routes.get(routeId);
    const [today, yesterday] = runs(serviceId);
    if (route && (today || yesterday)) {
      const id = own(tripId);
      trips.set(id, { id, serviceId: own(serviceId), route, label: own(shortName) || null, today, shapeId: shapeId || null, raw: [], freqs: [] });
    }
  }
  // Las paradas de todos los viajes van en un único array tipado (seq, índice de parada, llegada,
  // salida): como objetos, o con un array por viaje, ocuparían cientos de MB.
  const stopTimeColumns = ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'];
  for (const [tripId, stopId, seq, arrival, departure] of csvColumns(f['stop_times.txt'], stopTimeColumns)) {
    if (pace.due()) await pace.pause();
    const trip = trips.get(tripId);
    const si = trip && stopIndex.get(stopId);
    if (si === undefined) continue;
    const arr = gtfsTimeToSeconds(arrival || departure);
    const dep = gtfsTimeToSeconds(departure || arrival);
    if (arr !== null && dep !== null) trip.raw.push(+seq, si, arr, dep);
  }
  for (const [tripId, startTime, endTime, headway] of csvColumns(f['frequencies.txt'], ['trip_id', 'start_time', 'end_time', 'headway_secs'])) {
    const trip = trips.get(tripId);
    const start = gtfsTimeToSeconds(startTime);
    const end = gtfsTimeToSeconds(endTime);
    if (trip && start !== null && end !== null) trip.freqs.push({ start, end, headway: +headway });
  }
  const kept = [];
  let total = 0;
  for (const t of trips.values()) {
    if (pace.due()) await pace.pause();
    const n = t.raw.length / 4;
    if (n < 2) continue;
    // De ayer sólo interesan los viajes que siguen circulando pasada la medianoche.
    let ends = -Infinity;
    for (let i = 2; i < t.raw.length; i += 4) if (t.raw[i] > ends) ends = t.raw[i];
    const latest = t.freqs.length ? Math.max(...t.freqs.map((fr) => fr.end)) + ends : ends;
    if (!t.today && latest <= DAY_S) continue;
    kept.push(t);
    total += t.raw.length;
  }
  // Del calendario sólo hacen falta los servicios de esos viajes (ALSA tiene 35.000 y usa un tercio).
  const usedServices = new Set(kept.map((t) => t.serviceId));
  for (const id of calendar.keys()) if (!usedServices.has(id)) calendar.delete(id);
  for (const id of exceptions.keys()) if (!usedServices.has(id)) exceptions.delete(id);
  // Trazados (shapes.txt), sólo los de los viajes que se quedan y aligerados (buildShape).
  const wantedShapes = new Set(kept.map((t) => t.shapeId).filter(Boolean));
  // Cada trazado se lee en un array plano [seq, lon, lat, seq, lon, lat…]: un array por punto
  // ocuparía varias veces más mientras se carga (hay GTFS con 800.000 puntos).
  const shapePoints = new Map();
  for (const [shapeId, seq, ptLon, ptLat] of csvColumns(f['shapes.txt'], ['shape_id', 'shape_pt_sequence', 'shape_pt_lon', 'shape_pt_lat'])) {
    if (pace.due()) await pace.pause();
    if (!wantedShapes.has(shapeId)) continue;
    const lon = +ptLon;
    const lat = +ptLat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (!shapePoints.has(shapeId)) shapePoints.set(own(shapeId), []);
    shapePoints.get(shapeId).push(+seq, lon, lat);
  }
  const shapes = [];
  const shapeIndex = new Map();
  for (const [sid, raw] of shapePoints) {
    if (pace.due()) await pace.pause();
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
    if (pace.due()) await pace.pause();
    const n = t.raw.length / 4;
    // Casi siempre vienen ya en orden de secuencia: sólo se ordena si hace falta (orden estable).
    let sorted = true;
    for (let i = 1; i < n && sorted; i++) sorted = t.raw[i * 4] >= t.raw[(i - 1) * 4];
    const order = sorted ? null : Array.from({ length: n }, (_, i) => i).sort((a, b) => t.raw[a * 4] - t.raw[b * 4]);
    for (let i = 0; i < n; i++) {
      const src = (order ? order[i] : i) * 4;
      const dst = offset + i * 4;
      times[dst] = t.raw[src];
      times[dst + 1] = t.raw[src + 1];
      times[dst + 2] = t.raw[src + 2];
      times[dst + 3] = t.raw[src + 3];
    }
    compact.push({ id: t.id, serviceId: t.serviceId, route: t.route, label: t.label, freqs: t.freqs, at: offset, n,
      first: times[offset + 3], last: times[offset + (n - 1) * 4 + 2], shape: shapeIndex.get(t.shapeId) ?? -1 });
    offset += n * 4;
  }
  return { calendar, exceptions, stopList, times, trips: compact, shapes };
}

// ---------- Paso entre hilos ----------
// Copiar el horario tal cual de un hilo a otro (clonación estructurada) cuesta 250-300 ms en los que
// tienen miles de viajes (ALSA, TMB, AMB): V8 serializa cada objeto con los nombres de todas sus
// propiedades, y la mitad de ese trabajo, rehacerlos, cae en el hilo principal. Empaquetado en
// columnas (arrays de cadenas y arrays tipados, que se transfieren sin copiar) se rehace en pocos ms.

/** Horario → forma compacta para enviarlo a otro hilo ({ value, transfer }). */
export function packSchedule({ calendar, exceptions, stopList, times, trips, shapes }) {
  const routes = [];
  const routeIndex = new Map();
  const nt = trips.length;
  const tripInts = new Int32Array(nt * 6); // ruta, at, n, first, last, shape
  const freqAt = new Int32Array(nt + 1);
  const freqs = [];
  const ids = new Array(nt);
  const serviceIds = new Array(nt);
  const labels = new Array(nt);
  trips.forEach((t, i) => {
    if (!routeIndex.has(t.route)) routeIndex.set(t.route, routes.push(t.route) - 1);
    tripInts.set([routeIndex.get(t.route), t.at, t.n, t.first, t.last, t.shape], i * 6);
    ids[i] = t.id;
    serviceIds[i] = t.serviceId;
    labels[i] = t.label;
    for (const f of t.freqs) freqs.push(f.start, f.end, f.headway);
    freqAt[i + 1] = freqs.length;
  });
  const services = [...calendar.keys()];
  const calendarDays = new Uint8Array(services.length);
  services.forEach((id, i) => calendar.get(id).days?.forEach((on, d) => { if (on) calendarDays[i] |= 1 << d; }));
  const coords = new Float64Array(stopList.length * 2);
  stopList.forEach((st, i) => { coords[i * 2] = st.lat; coords[i * 2 + 1] = st.lon; });
  const value = {
    exceptions, times, shapes, routes,
    calendar: { services, start: services.map((id) => calendar.get(id).start), end: services.map((id) => calendar.get(id).end), days: calendarDays },
    stops: { ids: stopList.map((st) => st.stopId), names: stopList.map((st) => st.name), coords },
    trips: { ids, serviceIds, labels, ints: tripInts, freqAt, freqs: Float64Array.from(freqs) },
  };
  const transfer = new Set([times.buffer, calendarDays.buffer, coords.buffer, tripInts.buffer, freqAt.buffer, value.trips.freqs.buffer]);
  for (const sh of shapes) transfer.add(sh.coords.buffer).add(sh.dist.buffer);
  return { value, transfer: [...transfer] };
}

/** Forma compacta → el mismo horario que devuelve parseSchedule. */
export function unpackSchedule({ calendar: cal, exceptions, stops, times, trips: t, routes, shapes }) {
  const calendar = new Map();
  cal.services.forEach((id, i) => calendar.set(id, { start: cal.start[i], end: cal.end[i], days: Array.from({ length: 7 }, (_, d) => (cal.days[i] & (1 << d)) !== 0) }));
  const stopList = stops.ids.map((stopId, i) => ({ stopId, name: stops.names[i], lat: stops.coords[i * 2], lon: stops.coords[i * 2 + 1] }));
  const trips = t.ids.map((id, i) => {
    const freqs = [];
    for (let k = t.freqAt[i]; k < t.freqAt[i + 1]; k += 3) freqs.push({ start: t.freqs[k], end: t.freqs[k + 1], headway: t.freqs[k + 2] });
    const o = i * 6;
    return { id, serviceId: t.serviceIds[i], route: routes[t.ints[o]], label: t.labels[i], freqs, at: t.ints[o + 1], n: t.ints[o + 2],
      first: t.ints[o + 3], last: t.ints[o + 4], shape: t.ints[o + 5] };
  });
  return { calendar, exceptions, stopList, times, trips, shapes };
}
