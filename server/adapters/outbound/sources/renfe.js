// Renfe: posiciones y retrasos de Cercanías/Rodalies y de AV/Larga/Media Distancia, y avisos
// de servicio. Sólo se usan sus datos abiertos (CC BY 4.0, "Origen de los datos: Renfe
// Operadora"): el GTFS-RT de gtfsrt.renfe.com y sus GTFS de horarios para saber el producto,
// el origen y el destino de cada tren. Los endpoints internos de sus visores web no se usan:
// no tienen licencia de reutilización.
import { createPacer, csvColumns, csvColumnsStreamed, csvRows, openGtfs, own, zipLocalDate } from '../gtfs/gtfs-reader.js';
import { RENFE_FILES } from '../stations/renfe-station-catalog.js';
import { madridClock, madridDateTime, madridServiceDay, madridToday, num } from './parse.js';
import { distanceKm } from '../../../domain/geo.js';
import { gtfsTimeToSeconds, serviceRuns } from '../../../domain/schedule.js';
import { clockOf, tripStopList } from '../../../domain/trip-stops.js';
import {
  cancellationEvent, mergeSameTrain, missingTrainEvent, noticesAbout, tripChanges, withoutCancelledTrains,
} from '../../../domain/cancelaciones.js';
import { createSeenStore } from '../persistence/seen-store.js';
import { followOf, lineKey, numberedServiceKey } from '../../../domain/seguir.js';

const GTFSRT = 'https://gtfsrt.renfe.com';
// Una estación con andenes largos no pasa de unos cientos de metros: «parado» más lejos que esto de
// la estación que dice Renfe no es estar parado en ella. En Cercanías, la posición no es la del tren
// (2,2 km en un C1 de Madrid con la posición de T4 y «parado en Valdebebas»); en AV/LD/MD, el tren ya
// va de camino (un Media Distancia «parado en Ferrol» a 9,4 km, saliendo de Pontedeume): ver ldReading.
const FAR_FROM_STOP_KM = 1.5;
// Dos paradas del viaje a menos de esto son el mismo sitio (Santiago y Santiago-Turístico, 0 m).
const SAME_PLACE_KM = 0.5;
const ATTRIBUTION = 'Origen de los datos: Renfe Operadora (CC BY 4.0; datos modificados: normalizados, depurados y combinados con sus horarios)';
// Cercanías: lo que le queda se dibuja con el trazado de su viaje del horario de Renfe en el Punto de
// Acceso Nacional (ver domain/route-ahead.js) y, si ese trazado no llega a su destino, sobre la red de
// Adif (ver application/use-cases/query-situation.js).
const ATTRIBUTION_CERCANIAS = `${ATTRIBUTION} · trazado: Powered by MITRAMS (dato explotado)`
  + '; donde no llega a su destino, sobre la red de Adif, © Administrador de infraestructuras ferroviarias';
// AV/LD/MD: además, el recorrido y lo que le queda se dibujan sobre la red de Adif (ver domain/rail-match.js).
const ATTRIBUTION_LD = 'Origen de los datos: Renfe Operadora (CC BY 4.0; datos modificados: normalizados, depurados, '
  + 'combinados con sus horarios y dibujados sobre la red de Adif, © Administrador de infraestructuras ferroviarias)';
const TIMETABLE_TTL_MS = 24 * 3600_000;
// Renfe vuelve a publicar el GTFS de AV/LD/MD cada día y el id de viaje lleva la fecha de su periodo
// ("0515212026-10-31"): si el tiempo real ya usa los nuevos y la copia es de ayer, se descarga antes.
const LD_REFRESH_MS = 3600_000;
const INCIDENT_WORDS = /suspend|interrump|cortad|incidencia|avería|accidente/i;
// Trenes sin datos: uno que según su horario debería estar circulando y del que Renfe no publica nada.
// Sólo desde un rato después de su salida y hasta un poco antes de su llegada: en la salida, Renfe tarda
// en dar su posición; al final, puede haber llegado antes. Y sólo si la lectura de las posiciones es
// reciente (si no, todos parecerían sin datos).
const MISSING_AFTER_DEPARTURE_S = 10 * 60;
const MISSING_BEFORE_ARRIVAL_S = 5 * 60;
const POSITIONS_FRESH_MS = 2 * 60_000;
// Si faltan más de estos, lo que falla es el fichero de posiciones de Renfe, no unos trenes: no se marca ninguno.
const MISSING_MAX_SHARE = 0.7;
const CALENDAR_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
/** «40T0006C2» (núcleo 40, línea C2) → «40|C2»: la clave de una línea de Cercanías, la misma en sus viajes y en sus avisos. */
export const renfeLineKey = (routeId) => {
  const m = /^(\d{2})T\d{4}(.+)$/.exec(routeId ?? '');
  return m ? `${m[1]}|${m[2]}` : null;
};

// route_short_name del GTFS de AV/LD/MD → [nombre comercial, modo, ancho de vía si sólo va por uno]. Los
// AVE y Avlo sólo van por vía de ancho estándar y los regionales por la de ancho ibérico; Avant (en Galicia
// va por vía ibérica), Alvia (cambia de ancho) y los demás, por cualquiera.
const PRODUCTS = {
  AVE: ['AVE', 'av', 'standard'], 'AVE INT': ['AVE Internacional', 'av', 'standard'], AVLO: ['Avlo', 'av', 'standard'],
  AVANT: ['Avant', 'av'], 'AVANT EXP': ['Avant Exprés', 'av'],
  ALVIA: ['Alvia', 'ld'], INTERCITY: ['Intercity', 'ld'], EUROMED: ['Euromed', 'ld'], TRENCELTA: ['Trencelta', 'ld'],
  MD: ['Media Distancia', 'md', 'iberian'], REGIONAL: ['Regional', 'md', 'iberian'], 'REG.EXP.': ['Regional Exprés', 'md', 'iberian'],
  PROXIMDAD: ['Proximidad', 'md', 'iberian'],
};
const product = (short) => PRODUCTS[(short ?? '').toUpperCase()] ?? [short || 'Renfe', 'ld'];

const madridIso = (epochSec) => madridDateTime(epochSec * 1000);
/** Número de un tren de AV/LD/MD por su viaje: «0029112026-11-05» (y su variante «…2…») y los
 * especiales que añade el tiempo real («SPECIAL_9074720261105») → «00291», «90747». */
export const ldNumber = (tripId) => /^(\d{5})\d\d{4}-\d{2}-\d{2}$/.exec(tripId)?.[1] ?? /^SPECIAL_(\d{5})/.exec(tripId)?.[1] ?? tripId;
/** Número de un tren de Cercanías por su viaje: «1002V20109C3», «4008J31413C3» → «20109», «31413». */
export const cercaniasNumber = (tripId) => /^\d{4}[A-Z](\d{5})/.exec(tripId)?.[1] ?? null;

// Núcleos de Cercanías por el prefijo de sus route_id («10T0001C3» → 10, Madrid), comprobados en el
// routes.txt de su GTFS. Su nombre va en la clave de la línea («l-renfe-Madrid-C5»): hay C1 en varios, y así
// se lee y se puede buscar por ciudad.
export const RENFE_NUCLEOS = Object.freeze({
  10: 'Madrid', 20: 'Asturias', 30: 'Sevilla', 31: 'Cádiz', 32: 'Málaga', 40: 'Valencia', 41: 'Murcia/Alicante', 45: 'Cartagena',
  46: 'Ferrol', 47: 'León', 51: 'Catalunya', 60: 'Bilbao', 61: 'San Sebastián', 62: 'Santander', 70: 'Zaragoza',
});

/** El código de núcleo de una línea o un viaje de Cercanías: de renfeLineKey («40|C2») o del viaje («4013M…»). */
const nucleoCode = (key, tripId) => key?.split('|')[0] ?? /^(\d{2})\d{2}[A-Z]/.exec(tripId ?? '')?.[1] ?? null;

/**
 * Lo que se puede seguir de un tren de Renfe (ver domain/seguir.js): su número, el mismo todos los días y en
 * los dos feeds (los regionales de Rodalies también van en el de AV/LD/MD), y su línea. En Cercanías, la
 * línea va con el nombre de su núcleo (RENFE_NUCLEOS); en AV/LD/MD, el producto (AVE, Avant…), que es lo que
 * el radar enseña como su línea.
 * @param {{ number?: string|null, line?: string|null, lineKey?: string|null, tripId?: string,
 *           nucleo?: (code: string) => string }} t
 *   lineKey: la de renfeLineKey; sin ella, el núcleo sale del viaje de Cercanías («4013M…» → 40). nucleo: el
 *   nombre de un código (por defecto, el de RENFE_NUCLEOS o, si no está, el propio código)
 */
export function renfeFollow({ number = null, line = null, lineKey: key = null, tripId = '', nucleo = (c) => RENFE_NUCLEOS[c] ?? c }) {
  const code = nucleoCode(key, tripId);
  return followOf(numberedServiceKey({ operator: 'Renfe', number }), lineKey({ operator: 'Renfe', scope: code ? nucleo(code) : null, line }));
}

/** Horarios oficiales de Renfe, cargados una vez al día y compartidos por las dos fuentes. */
export function createTimetables({ cache, stations, log }) {
  let ld = new Map();   // trip_id → { service, mode, gauge, origin, destination, stops, times }
  let ldByNumber = new Map(); // número de tren → lo mismo, del periodo vigente
  let cerc = new Map(); // trip_id → { line, origin, destination, shape, end, stops }
  let cercStops = new Map(); // stop_id → { name, at: [lon, lat] }, del stops.txt de Cercanías
  let cercKey = null; // huella del GTFS de Cercanías cargado (ver zipKey)
  let cercTimes = new Map(); // viaje → hora de sus paradas, de los pedidos por cercaniasTimes (null: no se sabe)
  let cercTimesKey = null; // de qué GTFS son
  const loadedAt = { ld: 0, cerc: 0 };
  // Las dos fuentes de Renfe piden los horarios a la vez al arrancar: mientras una carga está en
  // marcha, las demás llamadas esperan a esa misma en vez de leer otra vez el GTFS en paralelo.
  const loading = {};
  const once = (name, load) => (loading[name] ??= load().finally(() => { loading[name] = null; }));

  // Sólo se espera a la primera carga. Las siguientes (una vez al día) van en segundo plano y,
  // mientras tanto, se sigue usando el horario anterior: si no, los trenes se quedarían quietos.
  const firstOrBackground = (name, have, load) => {
    if (have() && Date.now() - loadedAt[name] < TIMETABLE_TTL_MS) return Promise.resolve();
    const run = once(name, load);
    return have() ? Promise.resolve() : run;
  };
  const loadLd = () => firstOrBackground('ld', () => ld.size > 0, () => loadLdNow(TIMETABLE_TTL_MS));
  const loadCercanias = () => firstOrBackground('cerc', () => cerc.size > 0, loadCercaniasNow);
  /** El tiempo real trae viajes que el horario guardado no tiene: se vuelve a leer, descargándolo si la
   * copia tiene más de una hora. Como mucho una vez por hora. Con otra lectura en marcha no se gasta el
   * turno de la hora: se pide en la siguiente lectura del tiempo real. */
  let ldRefreshedAt = 0;
  const refreshLd = () => {
    if (loading.ld || Date.now() - ldRefreshedAt < LD_REFRESH_MS) return;
    ldRefreshedAt = Date.now();
    once('ld', () => loadLdNow(LD_REFRESH_MS, true));
  };

  async function loadLdNow(maxAgeMs, force = false) {
    if (!force && ld.size && Date.now() - loadedAt.ld < TIMETABLE_TTL_MS) return;
    loadedAt.ld = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      const f = await openGtfs(await cache.bytes(RENFE_FILES.largaDistancia, 'renfe-google_transit.zip', maxAgeMs),
        ['routes.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt']);
      const routes = new Map([...csvRows(f['routes.txt'])].map((r) => [r.route_id, r.route_short_name]));
      const ends = new Map(); // trip_id → [primera parada, última parada, todas las paradas con su hora]
      const pace = createPacer();
      const columns = ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'];
      for (const [tripId, stopId, stopSequence, arrival, departure] of csvColumns(f['stop_times.txt'], columns)) {
        if (pace.due()) await pace.pause();
        const seq = +stopSequence;
        let e = ends.get(tripId);
        if (!e) ends.set(own(tripId), (e = [[Infinity], [-Infinity], []]));
        if (seq < e[0][0]) e[0] = [seq, own(stopId)];
        if (seq > e[1][0]) e[1] = [seq, own(stopId)];
        e[2].push([seq, stopId, gtfsTimeToSeconds(arrival), gtfsTimeToSeconds(departure)]);
      }
      const runsOn = await calendarDays(f, pace);
      const stopsOf = tripStopsPatterns();
      const next = new Map();
      const byNumber = new Map(); // número → [fecha de inicio del periodo, viaje]
      // El día de Madrid, no el de UTC: entre las 00:00 y la 01:00 (las 02:00 en verano) el de UTC aún
      // es ayer y, el día que empieza un periodo, se quedaría con el anterior.
      const today = madridToday();
      // El periodo vigente: el que empezó más tarde sin pasar de hoy; si todos son futuros, el más próximo.
      const current = (a, b) => ((a <= today) === (b <= today) ? (a <= today ? a > b : a < b) : a <= today);
      for (const t of csvRows(f['trips.txt'])) {
        if (pace.due()) await pace.pause();
        const [service, mode, gauge = null] = product(routes.get(t.route_id));
        const e = ends.get(t.trip_id);
        const stops = e ? stopsOf(e[2]) : null; // ordena las filas
        const number = t.trip_short_name || t.trip_id.slice(0, 5);
        const trip = {
          service, mode, gauge, number, origin: e ? stations.name(e[0][1]) : null, destination: e ? stations.name(e[1][1]) : null, stops,
          times: e ? stopTimes(e[2]) : null, runs: runsOn.get(t.service_id) ?? null,
        };
        next.set(t.trip_id, trip);
        const from = /\d{4}-\d{2}-\d{2}$/.exec(t.trip_id)?.[0] ?? '';
        const had = byNumber.get(number);
        if (!had || current(from, had[0])) byNumber.set(number, [from, trip]);
      }
      ld = next;
      ldByNumber = new Map([...byNumber].map(([number, [, trip]]) => [number, trip]));
    } catch (err) {
      log.warn(`[renfe] horarios AV/LD/MD: ${err.message}`);
    }
  }

  /**
   * Qué días circula cada servicio del horario de AV/LD/MD, de ayer a pasado mañana (se vuelve a leer cada
   * día): service_id → días («AAAAMMDD»). Sólo los que circulan alguno de esos días.
   */
  async function calendarDays(f, pace) {
    const days = [-1, 0, 1, 2].map((offset) => madridServiceDay(Date.now(), offset));
    const wanted = new Set(days.map((d) => d.ymd));
    const calendar = new Map();
    for (const c of csvRows(f['calendar.txt'] ?? new Uint8Array())) {
      if (pace.due()) await pace.pause();
      calendar.set(c.service_id, { start: c.start_date, end: c.end_date, days: CALENDAR_DAYS.map((d) => c[d] === '1') });
    }
    const exceptions = new Map();
    for (const [id, date, type] of csvColumns(f['calendar_dates.txt'] ?? new Uint8Array(), ['service_id', 'date', 'exception_type'])) {
      if (pace.due()) await pace.pause();
      if (!wanted.has(date)) continue;
      if (!exceptions.has(id)) exceptions.set(id, new Map());
      exceptions.get(id).set(date, +type);
    }
    const runsOn = new Map();
    for (const id of new Set([...calendar.keys(), ...exceptions.keys()])) {
      const runs = days.filter((d) => serviceRuns(calendar.get(id), exceptions.get(id), d.ymd, d.weekday)).map((d) => d.ymd);
      if (runs.length) runsOn.set(own(id), new Set(runs));
    }
    return runsOn;
  }

  /**
   * Viajes de AV/LD/MD que según su horario deberían estar circulando a `now` (hoy, o los de ayer que pasan
   * de medianoche), uno por número de tren, desde un rato después de su salida hasta un poco antes de su
   * llegada. `at`: la última parada por la que deberían haber pasado.
   * @returns {Array<{ trip: object, day: { ymd: string, iso: string }, at: number }>}
   */
  function ldRunningNow(now = Date.now()) {
    const out = new Map();
    for (const offset of [0, -1]) {
      const day = madridServiceDay(now, offset);
      const t = Math.floor((now - day.midnight) / 1000);
      for (const trip of ld.values()) {
        const times = trip.times;
        if (!trip.runs?.has(day.ymd) || !times || times.length < 2 || out.has(trip.number)) continue;
        const dep = times[0];
        const arr = times.at(-1);
        if (dep < 0 || arr < 0 || t < dep + MISSING_AFTER_DEPARTURE_S || t > arr - MISSING_BEFORE_ARRIVAL_S) continue;
        let at = 0;
        for (let i = 0; i < times.length; i++) if (times[i] >= 0 && times[i] <= t) at = i;
        out.set(trip.number, { trip, day, at });
      }
    }
    return [...out.values()];
  }

  async function loadCercaniasNow() {
    if (cerc.size && Date.now() - loadedAt.cerc < TIMETABLE_TTL_MS) return;
    loadedAt.cerc = Date.now();
    try {
      const zip = await cache.bytes(RENFE_FILES.cercanias, 'renfe-fomento_transit.zip', TIMETABLE_TTL_MS);
      const key = zipKey(zip);
      const f = await openGtfs(zip, ['routes.txt', 'trips.txt', 'stops.txt']);
      const routes = new Map();
      // route_type 3: autobuses de Renfe por carretera (la C2 de Murcia a Águilas, Caudiel-Puçol…), no trenes.
      for (const r of csvRows(f['routes.txt'])) {
        routes.set(r.route_id, { line: r.route_short_name || null, lineKey: renfeLineKey(r.route_id), bus: r.route_type === '3', ...routeEnds(r.route_long_name) });
      }
      const gtfsStops = new Map([...csvRows(f['stops.txt'])].map((s) => [s.stop_id, { name: s.stop_name, at: [+s.stop_lon, +s.stop_lat] }]));
      cercStops = gtfsStops; // un millar de paradas: sus nombres y dónde están, para las paradas de cada viaje
      const nameOf = (id) => stations.get(id)?.name ?? gtfsStops.get(id)?.name ?? null;
      const pace = createPacer();
      let stopsOf = new Map();
      try {
        stopsOf = await cachedTripStops(cache, zip, pace);
      } catch (err) {
        log.warn(`[renfe] paradas de los viajes de Cercanías: ${err.message}; sólo el nombre de la línea`);
      }
      // Origen, destino y final del recorrido salen de las paradas de cada viaje. Ni el nombre de la
      // línea («Benacazon - Jardines de Hercules») dice en qué sentido va, ni los trazados de Renfe:
      // medido con el movimiento real, la mitad van al revés que sus viajes (la C2 de Valencia).
      // Un objeto por línea, trazado y paradas, compartido por sus viajes: 140.000 caben en unos cientos.
      const shared = new Map();
      const next = new Map();
      for (const [tripId, routeId, shapeId] of csvColumns(f['trips.txt'], ['trip_id', 'route_id', 'shape_id'])) { // 140.000 viajes
        if (pace.due()) await pace.pause();
        const route = routes.get(routeId);
        if (!route) continue;
        const stops = stopsOf.get(tripId);
        const key = `${routeId}|${shapeId ?? ''}|${stops?.id ?? ''}`;
        let trip = shared.get(key);
        if (!trip) {
          const [first, last] = [stops?.[0], stops?.at(-1)];
          trip = {
            line: route.line,
            lineKey: route.lineKey,
            ...(route.bus ? { bus: true } : {}),
            origin: (first && nameOf(first)) || route.origin,
            destination: (last && nameOf(last)) || route.destination,
            shape: shapeId ? own(shapeId) : null,
            end: (last && gtfsStops.get(last)?.at) || null, // donde acaba: hasta ahí se dibuja lo que le queda
            stops: stops ?? null,
          };
          shared.set(own(key), trip);
        }
        next.set(own(tripId), trip);
      }
      cerc = next;
      cercKey = key;
    } catch (err) {
      log.warn(`[renfe] horarios de Cercanías: ${err.message}`);
    }
  }

  /**
   * Hora de cada parada de unos viajes de Cercanías en su horario (como stopTimes), para los que Renfe
   * cancela o a los que suprime paradas. Se lee de disco sólo la primera vez que se pide cada viaje; los
   * que dejan de pedirse se olvidan.
   * @param {string[]} tripIds @returns {Promise<Map<string, Int32Array|null>>}
   */
  async function cercaniasTimes(tripIds) {
    if (cercTimesKey !== cercKey) {
      cercTimes = new Map();
      cercTimesKey = cercKey;
    }
    const missing = tripIds.filter((id) => !cercTimes.has(id));
    if (missing.length) {
      const found = await savedCercaniasTimes(cache, cercKey, missing).catch((err) => {
        log.warn(`[renfe] horas de los viajes de Cercanías: ${err.message}`);
        return new Map();
      });
      for (const id of missing) cercTimes.set(id, found.get(id) ?? null);
    }
    const wanted = new Set(tripIds);
    for (const id of cercTimes.keys()) if (!wanted.has(id)) cercTimes.delete(id);
    return new Map(tripIds.map((id) => [id, cercTimes.get(id) ?? null]));
  }

  return {
    loadLd,
    loadCercanias,
    refreshLd,
    ld: (id, number) => ld.get(id) ?? ldByNumber.get(number),
    ldRunningNow,
    ldExact: (id) => ld.has(id),
    cercanias: (id) => cerc.get(id),
    cercaniasStop: (id) => cercStops.get(id),
    cercaniasTimes,
  };
}

/**
 * «Chamartín - Clara Campoamor             -Aranjuez»: Renfe da origen y destino en dos columnas de 40
 * caracteres separadas por «-». Partir por el guion no vale: también lo llevan algunos nombres.
 * Recortado y partido por un solo espacio antes del guion (los demás se van con el trim): con /\s+-/,
 * un tramo largo de espacios sin guion detrás era cuadrático.
 */
export function routeEnds(longName) {
  const text = String(longName ?? '').slice(0, 200);
  const [origin, destination] = text[40] === '-' ? [text.slice(0, 40), text.slice(41)] : text.split(/\s-/);
  return { origin: origin?.trim() || null, destination: destination?.trim() || null };
}

// v9: la misma pasada guarda también la hora de cada viaje (TIMES_CACHE).
const STOPS_CACHE = 'renfe-cercanias-paradas.v9';
// La hora de cada viaje de Cercanías en el horario, aparte: no se tiene en memoria (140.000 viajes) y sólo
// se lee para los que Renfe cancela o a los que suprime paradas (ver cercaniasTimes).
const TIMES_CACHE = 'renfe-cercanias-horas.v1';
/** Huella del GTFS de Cercanías: sus cachés valen mientras Renfe no publique otro. */
const zipKey = (zip) => `${zip.byteLength}|${zipLocalDate(zip)}`;

/**
 * Las paradas de cada viaje, guardadas en disco con la huella del GTFS del que salen: leer el
 * stop_times cuesta minutos en el servidor al arrancar (compite con la carga de todos los demás
 * horarios), y sólo cambia cuando Renfe publica un horario nuevo. Sin caché (tests), se calculan.
 * En la misma pasada se guarda la hora de cada viaje (TIMES_CACHE).
 */
async function cachedTripStops(cache, zip, pace) {
  const key = zipKey(zip);
  const saved = await cache.readValue?.(STOPS_CACHE);
  if (saved?.key === key) {
    const patterns = saved.patterns.map((stops, id) => Object.assign(stops, { id }));
    const byTrip = new Map();
    for (let i = 0; i < saved.trips.length; i += 2) byTrip.set(saved.trips[i], patterns[saved.trips[i + 1]]);
    return byTrip;
  }
  const { byTrip, times } = await tripStops(zip, pace);
  const patterns = [];
  const trips = [];
  for (const [tripId, stops] of byTrip) {
    patterns[stops.id] ??= [...stops];
    trips.push(tripId, stops.id);
  }
  await cache.writeValue?.(TIMES_CACHE, { key, ...times });
  await cache.writeValue?.(STOPS_CACHE, { key, patterns, trips });
  return byTrip;
}

/**
 * Hora de cada parada de unos viajes de Cercanías en el horario (segundos del día de servicio, como en
 * stopTimes; -1 donde no la trae), de lo guardado en TIMES_CACHE para el GTFS con huella `key`.
 * @returns {Promise<Map<string, Int32Array>>}  sólo los que se encuentran
 */
async function savedCercaniasTimes(cache, key, tripIds) {
  const out = new Map();
  const saved = key ? await cache.readValue?.(TIMES_CACHE) : null;
  if (saved?.key !== key || !Array.isArray(saved.trips)) return out;
  const wanted = new Set(tripIds);
  for (let i = 0; i < saved.trips.length && out.size < wanted.size; i++) {
    if (!wanted.has(saved.trips[i])) continue;
    const profile = saved.profiles[saved.profile[i]];
    const dep = saved.dep[i];
    if (!profile || dep < 0) continue;
    out.set(saved.trips[i], Int32Array.from(profile, (offset) => (offset >= 0 ? dep + offset : -1)));
  }
  return out;
}

/**
 * Paradas de un viaje de AV/LD/MD, en orden, a partir de sus filas [stop_sequence, stop_id]: los ~8.500
 * viajes repiten unos pocos cientos de recorridos y cada uno se guarda una vez (con copia propia de los
 * códigos, sin retener el texto entero del stop_times).
 */
function tripStopsPatterns() {
  const patterns = new Map();
  return (rows) => {
    const ids = rows.sort((a, b) => a[0] - b[0]).map((r) => r[1]);
    const key = ids.join('>');
    if (!patterns.has(key)) patterns.set(own(key), ids.map(own));
    return patterns.get(key);
  };
}

/**
 * Hora de cada parada de un viaje de AV/LD/MD en el horario (segundos del día de servicio; la de salida
 * en la primera, la de llegada en las demás), de sus filas ya ordenadas [stop_sequence, stop_id, llegada,
 * salida]; -1 donde no la trae. null si el horario no trae horas.
 */
function stopTimes(rows) {
  const times = Int32Array.from(rows, (r, i) => (i === 0 ? r[3] ?? r[2] : r[2] ?? r[3]) ?? -1);
  return times.some((t) => t >= 0) ? times : null;
}

/**
 * Paradas de cada viaje, en orden, leyendo el stop_times (290 MB en Cercanías) por trozos. Los
 * 138.000 viajes repiten unas 640 secuencias: cada una se guarda una vez, con su número en `id`.
 * Un viaje cuyas filas no vienen seguidas (el GTFS no lo exige, aunque Renfe lo hace) se descarta.
 * También la hora de cada viaje: la de salida y su «perfil» (lo que tarda hasta cada parada), que
 * comparten los viajes de una misma línea y recorrido; así caben todos en poco más de un megabyte.
 * @returns {Promise<{ byTrip: Map<string, string[] & { id: number }>,
 *   times: { trips: string[], dep: Int32Array, profile: Int32Array, profiles: Int32Array[] } }>}
 */
async function tripStops(zip, pace) {
  const byTrip = new Map();
  const patterns = new Map();
  const broken = new Set();
  const profiles = new Map(); // «0,300,540…» → número de perfil
  const tripIds = [];
  const deps = [];
  const profileOf = [];
  let trip = null;
  let rows = [];
  const close = () => {
    if (trip === null) return;
    if (byTrip.has(trip)) broken.add(trip);
    rows.sort((a, b) => a[0] - b[0]);
    const key = rows.map((r) => r[1]).join('>');
    let stops = patterns.get(key);
    if (!stops) {
      stops = Object.assign(rows.map((r) => own(r[1])), { id: patterns.size });
      patterns.set(key, stops);
    }
    const tripKey = own(trip);
    byTrip.set(tripKey, stops);
    // Como en stopTimes: la de salida en la primera parada y la de llegada en las demás.
    const times = rows.map((r, i) => gtfsTimeToSeconds(i === 0 ? r[3] || r[2] : r[2] || r[3]) ?? -1);
    const dep = times[0];
    const offsets = times.map((t) => (t >= 0 && dep >= 0 ? t - dep : -1)).join(',');
    let profile = profiles.get(offsets);
    if (profile === undefined) profiles.set(offsets, (profile = profiles.size));
    tripIds.push(tripKey);
    deps.push(dep);
    profileOf.push(profile);
  };
  const columns = ['trip_id', 'stop_id', 'stop_sequence', 'arrival_time', 'departure_time'];
  for await (const [tripId, stopId, seq, arrival, departure] of csvColumnsStreamed(zip, 'stop_times.txt', columns)) {
    if (pace.due()) await pace.pause();
    if (tripId !== trip) {
      close();
      trip = tripId;
      rows = [];
    }
    rows.push([+seq, stopId, arrival, departure]);
  }
  close();
  for (const t of broken) byTrip.delete(t);
  const keep = tripIds.map((t, i) => (broken.has(t) ? -1 : i)).filter((i) => i >= 0);
  return {
    byTrip,
    times: {
      trips: keep.map((i) => tripIds[i]),
      dep: Int32Array.from(keep, (i) => deps[i]),
      profile: Int32Array.from(keep, (i) => profileOf[i]),
      profiles: [...profiles.keys()].map((offsets) => Int32Array.from(offsets.split(','), Number)),
    },
  };
}

/**
 * Posición de stopId en las paradas del viaje: la primera desde `after` (por la que iba en la lectura
 * anterior). Una línea circular repite su estación de origen al final (Santa Justa en el C4 de Sevilla) y
 * Renfe no da por qué parada del viaje va (sin currentStopSequence): sin recordarlo, al volver a ella el
 * tren estaría otra vez al principio. -1 si no está.
 */
export function stopIndex(stops, stopId, after = 0) {
  if (!stops) return -1;
  const i = stops.indexOf(stopId, after);
  return i >= 0 ? i : stops.indexOf(stopId);
}

/**
 * Próxima parada de un tren de Cercanías. En el GTFS-RT de Cercanías, IN_TRANSIT_TO no trae la
 * estación a la que va, sino la que acaba de dejar (medido: 29 de 29 por detrás del tren); con
 * INCOMING_AT sí es a la que llega. La siguiente sale de las paradas del viaje (null si no se sabe).
 */
export function cercaniasNext(status, stopId, stops, after = 0) {
  if (status !== 'IN_TRANSIT_TO') return stopId ?? null;
  const i = stopIndex(stops, stopId, after);
  return i >= 0 ? stops[i + 1] ?? null : null;
}

/**
 * Paradas que le quedan a un tren de Cercanías (códigos, en orden). En camino (IN_TRANSIT_TO), stopId es
 * la última que ha dejado; parado, en la que está; llegando (INCOMING_AT), a la que llega, que le queda.
 * null si stopId no está en su viaje o ya no le queda ninguna.
 */
export function stopsLeft(status, stopId, stops, after = 0) {
  const i = stopIndex(stops, stopId, after);
  if (i < 0) return null;
  const rest = stops.slice(status === 'IN_TRANSIT_TO' || status === 'STOPPED_AT' ? i + 1 : i);
  return rest.length ? rest : null;
}

/** tripId → { delay (s), arrivals: stopId → epoch s } a partir de un feed de trip updates. */
function tripUpdates(feed) {
  const out = new Map();
  for (const e of feed?.entity ?? []) {
    const tu = e.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    const stus = tu.stopTimeUpdate ?? [];
    const first = stus.find((s) => s.arrival?.delay !== undefined || s.departure?.delay !== undefined);
    const arrivals = new Map(stus.filter((s) => s.arrival?.time).map((s) => [s.stopId, +s.arrival.time]));
    out.set(tu.trip.tripId, { delay: num(tu.delay ?? first?.arrival?.delay ?? first?.departure?.delay), arrivals });
  }
  return out;
}

/**
 * Primera parada del viaje por la que no ha pasado un tren de Cercanías (índice; -1 si stopId no está en
 * su viaje). Como en stopsLeft: en camino (IN_TRANSIT_TO), stopId es la última que ha dejado; parado, en
 * la que está (aún no la ha pasado); llegando (INCOMING_AT), a la que llega.
 */
export function cercaniasFrom(status, stopId, stops, after = 0) {
  const i = stopIndex(stops, stopId, after);
  if (i < 0) return -1;
  return status === 'IN_TRANSIT_TO' ? i + 1 : i;
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           stations: import('../../../application/ports.js').StationCatalogPort, log: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').DataSourcePort[]}
 */
export function createRenfeSources({ http, cache, stations, log }) {
  const timetables = createTimetables({ cache, stations, log });
  // Un núcleo nuevo que no está en RENFE_NUCLEOS sigue funcionando con su código; se avisa una vez para añadirlo.
  const unknownNucleos = new Set();
  const nucleo = (code) => {
    const name = RENFE_NUCLEOS[code];
    if (!name && !unknownNucleos.has(code)) {
      unknownNucleos.add(code);
      log?.warn(`[renfe] núcleo de Cercanías ${code} sin nombre en RENFE_NUCLEOS: sus líneas se siguen con el código`);
    }
    return name ?? code;
  };

  /**
   * Paradas del viaje de un tren (ver domain/trip-stops.js) a partir de sus códigos de estación: nombre
   * y posición del catálogo de estaciones de Renfe (o, en Cercanías, de su GTFS), la hora del horario si
   * se sabe y la prevista que da el tiempo real (sólo si es futura) o, si no, la del horario más su retraso.
   * @param {{ codes: string[], times?: Int32Array|null, from: number, here?: boolean, arrivals?: Map<string, number>|null, delay?: number|null }} trip
   *   here: está parado en la parada `from`
   * @param {(code: string) => { name: string, at: number[] } | undefined} [fallback]
   */
  function renfeTripStops({ codes, times = null, from, here = false, arrivals = null, delay = null }, fallback) {
    const soon = Date.now() - 60_000;
    return tripStopList(codes.map((code, i) => {
      const st = stations.get(code);
      const other = st ? null : fallback?.(code);
      const eta = arrivals?.get(code);
      return {
        name: st?.name ?? other?.name ?? stations.name(code),
        at: st ? [st.lon, st.lat] : other?.at ?? null,
        time: times && times[i] >= 0 ? times[i] : null,
        eta: eta && eta * 1000 > soon ? madridIso(eta).slice(11, 16) : null,
      };
    }), from, { delaySec: delay, here });
  }

  /** Campos comunes a partir de la posición GTFS-RT y su trip update. `nextId`: la próxima parada, si
   * no es la de stopId (Cercanías en camino: stopId es entonces la última estación, la que acaba de dejar). */
  function base(v, update, nextId = v.stopId) {
    const stopped = v.currentStatus === 'STOPPED_AT';
    // Algunas horas de los trip updates son de paradas ya pasadas: sólo vale si es futura.
    const eta = update?.arrivals.get(nextId);
    const futureEta = eta && eta * 1000 > Date.now() - 60_000 ? eta : null;
    // Parado en una estación lejos de la posición que da: la posición no está al día o es de relleno
    // (Cercanías; en AV/LD/MD es que ya va de camino y llega aquí como tal: ver ldReading).
    const stop = stopped ? stations.get(v.stopId) : null;
    const far = stop ? distanceKm(v.position.latitude, v.position.longitude, stop.lat, stop.lon) : 0;
    return {
      ...(far > FAR_FROM_STOP_KM ? { farFromStop: Math.round(far * 10) / 10 } : {}),
      lat: v.position.latitude,
      lon: v.position.longitude,
      delay: update?.delay === null || update?.delay === undefined ? null : Math.round(update.delay / 60),
      current: stopped || nextId !== v.stopId ? stations.name(v.stopId) : null,
      next: stopped || !nextId ? null : stations.name(nextId),
      nextEta: !stopped && futureEta ? madridIso(futureEta) : null,
      area: stations.get(v.stopId)?.place ?? null,
      fixTime: v.timestamp ? +v.timestamp * 1000 : null,
      stopped,
    };
  }

  const hasPosition = (v) => Number.isFinite(v?.position?.latitude) && Number.isFinite(v?.position?.longitude) && v?.trip?.tripId;

  // La cabecera de vehicle_positions_LD llega con una hora de retraso (las posiciones son
  // actuales: coinciden con las del visor): se toma la más reciente de los dos feeds.
  const freshest = (...feeds) => {
    const ts = Math.max(...feeds.map((f) => num(f?.header?.timestamp) ?? 0));
    return ts ? ts * 1000 : null;
  };

  // Números de los trenes de AV/LD/MD con posición en la última lectura y cuándo fue.
  let ldPublished = null;

  // Paradas que le quedan a cada tren de Cercanías (códigos, en orden), de la última lectura: con ellas
  // se dibuja lo que le queda sin salirse de su viaje (ver domain/route-ahead.js).
  let remaining = new Map();
  // Paradas del viaje de cada tren de Cercanías (las de su horario), desde cuál le quedan y los retrasos
  // de su trip update, de la última lectura: para su ficha (tripStops).
  let cercTrips = new Map();
  // viaje → posición en sus paradas de la última stopId leída (ver stopIndex), de los de la última lectura
  let cercProgress = new Map();

  const cercanias = {
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías / Rodalies (GTFS-RT)',
    kind: 'vehicles',
    interval: 20_000,
    url: `${GTFSRT}/vehicle_positions.json`,
    page: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
    license: ATTRIBUTION_CERCANIAS,
    // CC BY 4.0 permite modificar indicándolo: a veces repite posiciones viejas o da saltos imposibles.
    cleanPositions: true,
    // Red de /api/lines cuyos trazados (shape_id) usan sus viajes.
    shapeNetwork: 'Cercanías Renfe',
    /** Paradas de su viaje, sin hora (el horario de Cercanías no se guarda: son 140.000 viajes) salvo
     * la prevista que dé su trip update. null si no se saben; undefined si no es de esta fuente. */
    tripStops(vehicleId) {
      const trip = cercTrips.get(vehicleId);
      if (!trip) return vehicleId.startsWith('renfe-c:') ? null : undefined;
      return renfeTripStops(trip, timetables.cercaniasStop);
    },
    /** Coordenadas ([lon, lat]) de las paradas que le quedan a un tren, en orden; null si no se saben. */
    stopsAhead(vehicleId) {
      const codes = remaining.get(vehicleId);
      if (!codes) return null;
      const at = codes.map((c) => stations.get(c)).filter((st) => Number.isFinite(st?.lat) && Number.isFinite(st?.lon)).map((st) => [st.lon, st.lat]);
      return at.length ? at : null;
    },
    async fetch() {
      await timetables.loadCercanias();
      const [positions, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates.json`)]);
      if (positions.status === 'rejected') throw positions.reason;
      const delays = tripUpdates(updates.status === 'fulfilled' ? updates.value : null);
      const vehicles = [];
      const left = new Map();
      const trips = new Map();
      const progress = new Map();
      for (const e of positions.value.entity ?? []) {
        const v = e.vehicle;
        if (!hasPosition(v)) continue;
        const tripId = v.trip.tripId;
        // Etiqueta "C5-23737-PLATF.(5)": línea, número de tren y vía de la estación de stopId
        // (en la que está parado o a la que llega). Renfe no publica por qué vía va en el trayecto.
        const [, line, number, platform] = /^([A-Za-z]+\d*[a-z]?)-(\d+)(?:-PLATF\.\((\w+)\))?/.exec(v.vehicle?.label ?? '') ?? [];
        const route = timetables.cercanias(tripId);
        const after = cercProgress.get(tripId) ?? 0;
        const at = stopIndex(route?.stops, v.stopId, after);
        if (at >= 0) progress.set(tripId, at);
        const ahead = stopsLeft(v.currentStatus, v.stopId, route?.stops, after);
        if (ahead && route?.shape && !route.bus) left.set(`renfe-c:${tripId}`, ahead);
        if (route?.stops?.length > 1) {
          const update = delays.get(tripId);
          trips.set(`renfe-c:${tripId}`, {
            codes: route.stops, from: cercaniasFrom(v.currentStatus, v.stopId, route.stops, after), here: v.currentStatus === 'STOPPED_AT', arrivals: update?.arrivals ?? null,
          });
        }
        vehicles.push({
          id: `renfe-c:${tripId}`,
          // Un autobús de Renfe no es un tren: va con los autobuses y no cuenta en los retrasos ni en las alertas de tren.
          mode: route?.bus ? 'bus' : 'cercanias',
          operator: 'Renfe',
          // Como en sus cancelaciones: las líneas R son Rodalies (Catalunya).
          service: route?.bus ? 'Autobús de Renfe' : /^R/i.test(line ?? route?.line ?? '') ? 'Rodalies' : 'Cercanías',
          line: line ?? route?.line ?? null,
          label: number ?? v.vehicle?.id ?? tripId,
          follow: renfeFollow({ number: number ?? cercaniasNumber(tripId), line: line ?? route?.line ?? null, lineKey: route?.lineKey, tripId, nucleo }),
          origin: route?.origin ?? null,
          destination: route?.destination ?? null,
          // La vía es la de stopId: con IN_TRANSIT_TO, la de la estación que acaba de dejar.
          platform: v.currentStatus === 'IN_TRANSIT_TO' ? null : platform ?? null,
          shape: route?.shape ?? null,
          end: route?.end ?? null,
          // Lo que le queda lo calcula el servidor con sus paradas (/api/ahead/<id>).
          ...(left.has(`renfe-c:${tripId}`) ? { ahead: true } : {}),
          ...(trips.has(`renfe-c:${tripId}`) ? { stops: true } : {}), // sus paradas: /api/stops
          ...base(v, delays.get(tripId), cercaniasNext(v.currentStatus, v.stopId, route?.stops, after)),
        });
      }
      remaining = left;
      cercTrips = trips;
      cercProgress = progress;
      return { vehicles, sourceTime: freshest(positions.value, updates.status === 'fulfilled' ? updates.value : null) };
    },
  };

  /**
   * En el feed de AV/LD/MD, «STOPPED_AT» no siempre es «parado»: al salir de una estación da durante
   * minutos la siguiente como «parado en», con el tren ya en marcha y a kilómetros de ella (mañana del
   * 2-nov: un tercio de sus lecturas). Lejos de la estación, el tren va de camino: hacia ella si está
   * entre la parada anterior y ella; si ya la ha dejado atrás (entre ella y la siguiente), es la última
   * estación y la próxima es la siguiente. La posición sí es buena: cae sobre la vía y se mueve.
   * «IN_TRANSIT_TO» es hacia la parada que da (67 de 68 trenes medidos el 4-nov), salvo cuando es una de
   * las paradas ficticias del horario en el mismo sitio que una estación: el Avant A Coruña → Ourense iba
   * «hacia Santiago-Turístico» (la misma posición que Santiago) a 59 km pasado Santiago. Igual que con
   * «parado en»: si está claramente entre ella y la siguiente, ya la ha dejado atrás. Las paradas en el
   * mismo sitio que ella cuentan como ella.
   * @returns {{ reading: object, nextId: string, from: number }} la lectura como «en camino» si hace
   *   falta, la próxima parada y desde qué parada del viaje (índice) le queda el recorrido (-1: no se sabe)
   */
  function ldReading(v, stops) {
    const k = stops?.indexOf(v.stopId) ?? -1;
    const stop = v.currentStatus === 'STOPPED_AT' || v.currentStatus === 'IN_TRANSIT_TO' ? stations.get(v.stopId) : null;
    const { latitude: lat, longitude: lon } = v.position;
    if (!stop || distanceKm(lat, lon, stop.lat, stop.lon) <= FAR_FROM_STOP_KM) return { reading: v, nextId: v.stopId, from: k };
    const moving = { ...v, currentStatus: 'IN_TRANSIT_TO' };
    const samePlace = (st) => st && distanceKm(st.lat, st.lon, stop.lat, stop.lon) <= SAME_PLACE_KM;
    // La parada con coordenadas más cercana en el viaje, hacia atrás (-1) o hacia delante (+1), que no
    // esté en el mismo sitio que esta.
    const near = (i, step) => {
      for (; i >= 0 && i < stops.length; i += step) {
        const st = stations.get(stops[i]);
        if (st && !samePlace(st)) return { i, st };
      }
      return null;
    };
    const onLeg = (a, b) => a && b && distanceKm(a.st.lat, a.st.lon, lat, lon) + distanceKm(lat, lon, b.st.lat, b.st.lon)
      <= 1.25 * distanceKm(a.st.lat, a.st.lon, b.st.lat, b.st.lon) + 2;
    if (k >= 0) {
      const here = { i: k, st: stop };
      const after = near(k + 1, 1);
      // Y ya más cerca de la siguiente que ella: sin eso, en un tramo largo, el tren que aún llega a ella
      // también parecería entre ella y la siguiente.
      const past = after && distanceKm(lat, lon, after.st.lat, after.st.lon) < distanceKm(stop.lat, stop.lon, after.st.lat, after.st.lon);
      if (!onLeg(near(k - 1, -1), here) && onLeg(here, after) && past) {
        let next = k + 1; // las del mismo sitio también han quedado atrás
        while (next < after.i && samePlace(stations.get(stops[next]))) next++;
        return { reading: moving, nextId: stops[next], from: next };
      }
    }
    return { reading: moving, nextId: v.stopId, from: k };
  }

  // id del tren → { gauge, left: códigos de las paradas que le quedan, y para su ficha: codes (todas las de
  // su viaje), times (su hora en el horario), from (desde cuál le quedan), arrivals y delay (su trip update) }
  // (última lectura)
  let railTrips = new Map();
  const largaDistancia = {
    id: 'renfe-ld',
    name: 'Renfe Alta Velocidad, Larga y Media Distancia (GTFS-RT)',
    kind: 'vehicles',
    interval: 20_000,
    url: `${GTFSRT}/vehicle_positions_LD.json`,
    page: 'https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md',
    license: ATTRIBUTION_LD,
    cleanPositions: true,
    onRailNetwork: true, // sus posiciones caen sobre los tramos de Adif: el recorrido se dibuja por la vía
    /**
     * Ancho de vía por el que va un tren (null: cualquiera) y paradas que le quedan, en orden y como
     * [lon, lat]: desde su próxima parada (stopId, la estación en la que está si está parado) hasta su
     * destino (null si no se saben). null si no se sabe su viaje; undefined si no es de esta fuente.
     */
    railTrip(vehicleId) {
      const trip = railTrips.get(vehicleId);
      if (!trip) return vehicleId.startsWith('renfe-ld:') ? null : undefined;
      const stops = trip.left?.map((code) => stations.get(code)).filter(Boolean).map((st) => [st.lon, st.lat]) ?? null;
      return { gauge: trip.gauge, stops };
    },
    /** Paradas de su viaje con la hora del horario y la prevista. null si no se sabe su viaje; undefined
     * si no es de esta fuente. */
    tripStops(vehicleId) {
      const trip = railTrips.get(vehicleId);
      if (!trip) return vehicleId.startsWith('renfe-ld:') ? null : undefined;
      return trip.codes?.length > 1 ? renfeTripStops(trip) : null;
    },
    async fetch() {
      await timetables.loadLd();
      const [positions, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates_LD.json`)]);
      if (positions.status === 'rejected') throw positions.reason;
      const delays = tripUpdates(updates.status === 'fulfilled' ? updates.value : null);
      const vehicles = [];
      const seen = new Set();
      const trips = new Map();
      let unknown = 0;
      for (const e of positions.value.entity ?? []) {
        const v = e.vehicle;
        if (!hasPosition(v)) continue;
        const tripId = v.trip.tripId; // "0019012026-10-30": número de tren + fecha
        const number = v.vehicle?.id || tripId.slice(0, 5);
        if (seen.has(number)) continue;
        seen.add(number);
        if (!timetables.ldExact(tripId)) unknown++;
        const trip = timetables.ld(tripId, number);
        const { reading, nextId, from } = ldReading(v, trip?.stops);
        const rest = from >= 0 ? trip.stops.slice(from) : [];
        const update = delays.get(tripId);
        if (trip) {
          trips.set(`renfe-ld:${number}`, {
            gauge: trip.gauge, left: rest.length ? rest : null,
            codes: trip.stops, times: trip.times, from, here: reading.currentStatus === 'STOPPED_AT', arrivals: update?.arrivals ?? null, delay: update?.delay ?? null,
          });
        }
        vehicles.push({
          id: `renfe-ld:${number}`,
          mode: trip?.mode ?? 'ld',
          operator: 'Renfe',
          service: trip?.service ?? 'Renfe',
          line: trip?.service ?? null,
          label: number,
          follow: renfeFollow({ number, line: trip?.service ?? null }),
          origin: trip?.origin ?? null,
          destination: trip?.destination ?? null,
          ...(rest.length ? { ahead: true } : {}), // lo que le queda, por la vía: /api/ahead
          ...(trip?.stops?.length > 1 ? { stops: true } : {}), // sus paradas, con su hora: /api/stops
          ...base(reading, update, nextId),
        });
      }
      railTrips = trips;
      // Qué trenes publica Renfe ahora (por su número y por el de su viaje): los demás que deberían estar
      // circulando son «sin datos» (fuente de avisos).
      ldPublished = { numbers: new Set([...seen, ...(positions.value.entity ?? []).map((e) => ldNumber(e.vehicle?.trip?.tripId ?? ''))]), at: Date.now() };
      // Mientras tanto vale el mismo número de tren del horario guardado; pero si muchos no están, es de ayer.
      if (unknown > vehicles.length / 4) timetables.refreshLd();
      return { vehicles, sourceTime: freshest(positions.value, updates.status === 'fulfilled' ? updates.value : null) };
    },
  };

  // Cancelaciones y paradas suprimidas: desde cuándo las ve el radar (Renfe no dice cuándo las publica).
  const seenStore = createSeenStore({ cache, name: 'renfe-cancelaciones-vistas.v1' });
  // Las de la última lectura buena de cada feed y su hora: si uno falla, se siguen mostrando (hasta una
  // hora después de leerlas: ver domain/cancelaciones.js) y no se olvida desde cuándo se ven.
  const lastCancellations = { cercanias: { list: [], at: 0 }, ld: { list: [], at: 0 } };

  /**
   * Paradas de un viaje (códigos) con su nombre, su posición y su hora del horario, y las que Renfe suprime.
   * @param {string[]} codes @param {Int32Array|null} times @param {Set<string>} skipped
   * @param {(code: string) => { name: string, at: number[] } | undefined} [fallback]
   */
  function cancelledStops(codes, times, skipped, fallback) {
    const withTimes = times?.length === codes.length ? times : null;
    return codes.map((code, i) => {
      const st = stations.get(code);
      const placed = Number.isFinite(st?.lat) && Number.isFinite(st?.lon);
      const other = placed ? null : fallback?.(code);
      return {
        name: st?.name ?? other?.name ?? stations.name(code) ?? code,
        code,
        at: placed ? [st.lon, st.lat] : other?.at ?? null,
        time: withTimes && withTimes[i] >= 0 ? withTimes[i] : null,
        skipped: skipped.has(code),
      };
    });
  }
  /** Lo común a las cancelaciones de un viaje de Renfe a partir de lo que dice su tiempo real. */
  function renfeCancellation(c, codes, times, fallback) {
    const skipped = new Set(c.skipped.map((s) => s.stopId).filter(Boolean));
    return {
      cancelled: c.cancelled,
      running: c.running,
      date: c.startDate,
      stops: codes?.length ? cancelledStops(codes, times, skipped, fallback) : null,
      skippedNames: [...skipped].filter((code) => !codes?.includes(code)).map((code) => stations.name(code) ?? fallback?.(code)?.name ?? code),
      operator: 'Renfe',
      publisher: 'Renfe',
      credit: ATTRIBUTION,
    };
  }

  /** Trenes de Cercanías/Rodalies (y autobuses de Renfe) cancelados o con paradas suprimidas. */
  async function cercaniasCancellations(feed) {
    // Los que no están en el horario vigente no se muestran: no se sabría ni su línea.
    const changes = [...tripChanges(feed)].filter(([tripId]) => timetables.cercanias(tripId));
    const times = await timetables.cercaniasTimes(changes.map(([tripId]) => tripId));
    return changes.map(([tripId, c]) => {
      const route = timetables.cercanias(tripId);
      const number = cercaniasNumber(tripId);
      const network = route.bus ? 'Autobús de Renfe' : /^R/i.test(route.line ?? '') ? 'Rodalies' : 'Cercanías';
      return {
        id: `renfe-cancelado:${tripId}`,
        ...renfeCancellation(c, route.stops, times.get(tripId), timetables.cercaniasStop),
        who: [network, route.line, number].filter(Boolean).join(' '),
        mode: route.bus ? 'bus' : 'cercanias',
        service: network,
        line: route.line ?? null,
        lineKey: route.lineKey ?? null,
        number,
        follow: renfeFollow({ number, line: route.line ?? null, lineKey: route.lineKey, tripId, nucleo }),
        origin: route.origin ?? null,
        destination: route.destination ?? null,
        feed: 'GTFS-RT de Cercanías y Rodalies',
        feedUrl: `${GTFSRT}/trip_updates.json`,
      };
    });
  }

  /** Trenes de AV/LD/MD cancelados o con paradas suprimidas: uno por número (cada tren va en dos viajes). */
  function ldCancellations(feed) {
    return [...tripChanges(feed, ldNumber)].map(([number, c]) => {
      const trip = c.tripIds.map((tripId) => timetables.ld(tripId, number)).find(Boolean) ?? null;
      return {
        id: `renfe-cancelado:ld:${number}`,
        ...renfeCancellation(c, trip?.stops ?? null, trip?.times ?? null),
        who: `${trip?.service ?? 'Tren'} ${number}`,
        mode: trip?.mode ?? 'ld',
        service: trip?.service ?? null,
        line: null,
        number,
        follow: renfeFollow({ number, line: trip?.service ?? null }),
        origin: trip?.origin ?? null,
        destination: trip?.destination ?? null,
        feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia',
        feedUrl: `${GTFSRT}/trip_updates_LD.json`,
      };
    });
  }

  // Avisos de servicio de la última lectura buena: los que nombran un tren cancelado (o su línea) se citan
  // en su ficha (ver domain/cancelaciones.js, noticesAbout).
  let lastNotices = [];
  const noticesFor = (c) => {
    if (!lastNotices.length) return {};
    const first = c.stops?.[0];
    return noticesAbout({ number: c.number, departure: clockOf(first?.time ?? null), origin: first?.name ?? c.origin, line: c.lineKey ?? null }, lastNotices);
  };

  /**
   * Trenes de AV/LD/MD que según su horario deberían estar circulando y de los que Renfe no publica nada:
   * ni su posición (la última lectura de renfe-ld, si es reciente), ni una actualización de su viaje
   * (`tuFeed`), ni su cancelación. Si faltan casi todos, lo que falla es el fichero de posiciones: ninguno.
   */
  let missingWarned = false;
  function missingTrains(tuFeed, now) {
    if (!ldPublished?.numbers.size || now - ldPublished.at > POSITIONS_FRESH_MS) return [];
    const published = new Set(ldPublished.numbers);
    for (const e of tuFeed?.entity ?? []) {
      const id = e?.tripUpdate?.trip?.tripId;
      if (id) published.add(ldNumber(id));
    }
    const running = timetables.ldRunningNow(now);
    const missing = running.filter(({ trip }) => !published.has(trip.number));
    if (running.length && missing.length > running.length * MISSING_MAX_SHARE) {
      if (!missingWarned) log.warn(`[renfe-avisos] faltan ${missing.length} de ${running.length} trenes de AV/LD/MD en el tiempo real de Renfe: no se marca ninguno como sin datos`);
      missingWarned = true;
      return [];
    }
    missingWarned = false;
    return missing.map(({ trip, day, at }) => ({
      id: `renfe-sin-datos:${trip.number}`,
      who: `${trip.service} ${trip.number}`,
      operator: 'Renfe',
      mode: trip.mode,
      service: trip.service,
      number: trip.number,
      follow: renfeFollow({ number: trip.number, line: trip.service }),
      stops: cancelledStops(trip.stops, trip.times, new Set()),
      at,
      date: day.iso,
      publisher: 'Renfe',
      feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia (posiciones y actualizaciones de viaje)',
      feedUrl: `${GTFSRT}/vehicle_positions_LD.json`,
      credit: ATTRIBUTION,
    }));
  }

  const avisos = {
    id: 'renfe-avisos',
    name: 'Renfe avisos de servicio, trenes cancelados, paradas suprimidas y trenes sin datos (GTFS-RT)',
    kind: 'events',
    interval: 120_000,
    url: `${GTFSRT}/alerts.json`,
    page: 'https://data.renfe.com/dataset/incidencias-avisos',
    license: ATTRIBUTION,
    async fetch() {
      await Promise.all([timetables.loadCercanias(), timetables.loadLd()]);
      const [alerts, updates, updatesLd] = await Promise.allSettled([
        http.json(this.url), http.json(`${GTFSRT}/trip_updates.json`), http.json(`${GTFSRT}/trip_updates_LD.json`),
      ]);
      if ([alerts, updates, updatesLd].every((r) => r.status === 'rejected')) throw alerts.reason;
      const d = alerts.status === 'fulfilled' ? alerts.value : null;
      const readAt = Date.now();
      const now = readAt / 1000;
      if (d) lastNotices = renfeNotices(d, now);
      if (updates.status === 'fulfilled') lastCancellations.cercanias = { list: await cercaniasCancellations(updates.value), at: readAt };
      if (updatesLd.status === 'fulfilled') lastCancellations.ld = { list: ldCancellations(updatesLd.value), at: readAt };
      const found = [lastCancellations.cercanias, lastCancellations.ld].flatMap(({ list, at }) => list.map((c) => ({ c, at })));
      const missing = updatesLd.status === 'fulfilled' ? missingTrains(updatesLd.value, readAt) : [];
      const since = await seenStore.stamp([...found.map(({ c }) => c.id), ...missing.map((m) => m.id)]);
      const cancellations = found.map(({ c, at }) => cancellationEvent({ ...c, ...noticesFor(c), ...since(c.id) }, at));
      // Las que Renfe ha dejado de publicar hoy siguen hasta medianoche, como retiradas.
      const withdrawn = await seenStore.withdrawn(cancellations, { clock: madridClock(readAt), endOfDay: madridServiceDay(readAt, 1).midnight });
      // Un mismo tren en los dos feeds (los regionales de Rodalies), una vez; y si está cancelado, no es «sin datos».
      const trains = mergeSameTrain([...cancellations, ...withdrawn]);
      const events = [...trains, ...withoutCancelledTrains(missing.map((m) => missingTrainEvent({ ...m, ...since(m.id) }, readAt)), trains)];
      for (const e of d?.entity ?? []) {
        const a = e.alert;
        if (!a || !activeAlert(a, now)) continue;
        const periods = a.activePeriod ?? [];
        const description = alertText(a);
        // Si el aviso referencia una estación, lo ubicamos en el mapa.
        const stop = (a.informedEntity ?? []).map((ie) => stations.get(ie.stopId)).find(Boolean);
        const lines = [...new Set((a.informedEntity ?? []).map((ie) => ie.routeId?.match(/C\d+[a-z]?|R\d+[A-Z]?|RT?\d+/)?.[0]).filter(Boolean))];
        events.push({
          id: `renfe-aviso:${e.id}`,
          category: 'ferroviario',
          type: 'aviso',
          severity: INCIDENT_WORDS.test(description) ? 'alta' : 'media',
          title: lines.length ? `Aviso Renfe · ${lines.join(', ')}` : 'Aviso Renfe',
          description,
          lat: stop?.lat ?? null,
          lon: stop?.lon ?? null,
          start: periods[0]?.start ? +periods[0].start * 1000 : null,
          end: periods[0]?.end ? +periods[0].end * 1000 : null,
        });
      }
      const fresh = (r) => (r.status === 'fulfilled' ? r.value : null);
      return { events, sourceTime: freshest(d, fresh(updates), fresh(updatesLd)) };
    },
  };

  return [cercanias, largaDistancia, avisos];
}

/** ¿Está en vigor el aviso a `nowSec` (epoch s)? Sin periodos, siempre. */
const activeAlert = (a, nowSec) => {
  const periods = a.activePeriod ?? [];
  return !periods.length || periods.some((p) => (!p.start || +p.start <= nowSec) && (!p.end || +p.end >= nowSec));
};
/** El texto de un aviso, en castellano si lo trae. */
const alertText = (a) => {
  const translations = a.descriptionText?.translation ?? a.headerText?.translation ?? [];
  return ((translations.find((t) => !t.language || t.language.startsWith('es')) ?? translations[0])?.text ?? '').trim();
};

/**
 * Los avisos de servicio en vigor de Renfe, con las líneas de Cercanías a las que se refieren (ver
 * renfeLineKey): para citarlos en las cancelaciones de las que hablan.
 * @returns {import('../../../domain/cancelaciones.js').Notice[]}
 */
export function renfeNotices(feed, nowSec) {
  const out = [];
  for (const e of feed?.entity ?? []) {
    const a = e?.alert;
    if (!a || !activeAlert(a, nowSec)) continue;
    const text = alertText(a);
    if (!text) continue;
    const url = (a.url?.translation ?? [])[0]?.text?.trim() || null;
    out.push({ id: String(e.id), text, url, lines: [...new Set((a.informedEntity ?? []).map((ie) => renfeLineKey(ie.routeId)).filter(Boolean))] });
  }
  return out;
}
