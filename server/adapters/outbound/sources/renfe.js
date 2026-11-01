// Renfe: posiciones y retrasos de Cercanías/Rodalies y de AV/Larga/Media Distancia, y avisos
// de servicio. Sólo se usan sus datos abiertos (CC BY 4.0, "Origen de los datos: Renfe
// Operadora"): el GTFS-RT de gtfsrt.renfe.com y sus GTFS de horarios para saber el producto,
// el origen y el destino de cada tren. Los endpoints internos de sus visores web no se usan:
// no tienen licencia de reutilización.
import { createPacer, csvColumns, csvColumnsStreamed, csvRows, openGtfs, own } from '../gtfs/gtfs-reader.js';
import { RENFE_FILES } from '../stations/renfe-station-catalog.js';
import { num } from './parse.js';

const GTFSRT = 'https://gtfsrt.renfe.com';
const ATTRIBUTION = 'Origen de los datos: Renfe Operadora (CC BY 4.0; datos modificados: normalizados, depurados y combinados con sus horarios)';
const TIMETABLE_TTL_MS = 24 * 3600_000;
// Renfe vuelve a publicar el GTFS de AV/LD/MD cada día y el id de viaje lleva la fecha de su periodo
// ("0515212026-10-31"): si el tiempo real ya usa los nuevos y la copia es de ayer, se descarga antes.
const LD_REFRESH_MS = 3600_000;
const INCIDENT_WORDS = /suspend|interrump|cortad|incidencia|avería|accidente/i;

// route_short_name del GTFS de AV/LD/MD → [nombre comercial, modo].
const PRODUCTS = {
  AVE: ['AVE', 'av'], 'AVE INT': ['AVE Internacional', 'av'], AVLO: ['Avlo', 'av'], AVANT: ['Avant', 'av'], 'AVANT EXP': ['Avant Exprés', 'av'],
  ALVIA: ['Alvia', 'ld'], INTERCITY: ['Intercity', 'ld'], EUROMED: ['Euromed', 'ld'], TRENCELTA: ['Trencelta', 'ld'],
  MD: ['Media Distancia', 'md'], REGIONAL: ['Regional', 'md'], 'REG.EXP.': ['Regional Exprés', 'md'], PROXIMDAD: ['Proximidad', 'md'],
};
const product = (short) => PRODUCTS[(short ?? '').toUpperCase()] ?? [short || 'Renfe', 'ld'];

const madridIso = (epochSec) => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(epochSec * 1000).replace(' ', 'T');

/** Horarios oficiales de Renfe, cargados una vez al día y compartidos por las dos fuentes. */
export function createTimetables({ cache, stations, log }) {
  let ld = new Map();   // trip_id → { service, mode, origin, destination }
  let ldByNumber = new Map(); // número de tren → lo mismo, del periodo vigente
  let cerc = new Map(); // trip_id → { line, origin, destination, shape, end, stops }
  const loadedAt = { ld: 0, cerc: 0 };
  // Las dos fuentes de Renfe piden los horarios a la vez al arrancar: mientras una carga está en
  // marcha, las demás llamadas esperan a esa misma en vez de leer otra vez el GTFS en paralelo.
  const loading = {};
  const once = (name, load) => (loading[name] ??= load().finally(() => { loading[name] = null; }));

  const loadLd = () => once('ld', () => loadLdNow(TIMETABLE_TTL_MS));
  const loadCercanias = () => once('cerc', loadCercaniasNow);
  /** El tiempo real trae viajes que el horario guardado no tiene: se vuelve a leer, descargándolo si la
   * copia tiene más de una hora. Como mucho una vez por hora. */
  let ldRefreshedAt = 0;
  const refreshLd = () => {
    if (Date.now() - ldRefreshedAt < LD_REFRESH_MS) return;
    ldRefreshedAt = Date.now();
    once('ld', () => loadLdNow(LD_REFRESH_MS, true));
  };

  async function loadLdNow(maxAgeMs, force = false) {
    if (!force && ld.size && Date.now() - loadedAt.ld < TIMETABLE_TTL_MS) return;
    loadedAt.ld = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      const f = await openGtfs(await cache.bytes(RENFE_FILES.largaDistancia, 'renfe-google_transit.zip', maxAgeMs), ['routes.txt', 'trips.txt', 'stop_times.txt']);
      const routes = new Map([...csvRows(f['routes.txt'])].map((r) => [r.route_id, r.route_short_name]));
      const ends = new Map(); // trip_id → [primera parada, última parada]
      const pace = createPacer();
      for (const [tripId, stopId, stopSequence] of csvColumns(f['stop_times.txt'], ['trip_id', 'stop_id', 'stop_sequence'])) {
        if (pace.due()) await pace.pause();
        const seq = +stopSequence;
        let e = ends.get(tripId);
        if (!e) ends.set(own(tripId), (e = [[Infinity], [-Infinity]]));
        if (seq < e[0][0]) e[0] = [seq, own(stopId)];
        if (seq > e[1][0]) e[1] = [seq, own(stopId)];
      }
      const next = new Map();
      const byNumber = new Map(); // número → [fecha de inicio del periodo, viaje]
      const today = new Date().toISOString().slice(0, 10);
      // El periodo vigente: el que empezó más tarde sin pasar de hoy; si todos son futuros, el más próximo.
      const current = (a, b) => ((a <= today) === (b <= today) ? (a <= today ? a > b : a < b) : a <= today);
      for (const t of csvRows(f['trips.txt'])) {
        if (pace.due()) await pace.pause();
        const [service, mode] = product(routes.get(t.route_id));
        const e = ends.get(t.trip_id);
        const trip = { service, mode, origin: e ? stations.name(e[0][1]) : null, destination: e ? stations.name(e[1][1]) : null };
        next.set(t.trip_id, trip);
        const number = t.trip_short_name || t.trip_id.slice(0, 5);
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

  async function loadCercaniasNow() {
    if (cerc.size && Date.now() - loadedAt.cerc < TIMETABLE_TTL_MS) return;
    loadedAt.cerc = Date.now();
    try {
      const zip = await cache.bytes(RENFE_FILES.cercanias, 'renfe-fomento_transit.zip', TIMETABLE_TTL_MS);
      const f = await openGtfs(zip, ['routes.txt', 'trips.txt', 'stops.txt']);
      const routes = new Map();
      // route_type 3: autobuses de Renfe por carretera (la C2 de Murcia a Águilas, Caudiel-Puçol…), no trenes.
      for (const r of csvRows(f['routes.txt'])) routes.set(r.route_id, { line: r.route_short_name || null, bus: r.route_type === '3', ...routeEnds(r.route_long_name) });
      const gtfsStops = new Map([...csvRows(f['stops.txt'])].map((s) => [s.stop_id, { name: s.stop_name, at: [+s.stop_lon, +s.stop_lat] }]));
      const nameOf = (id) => stations.get(id)?.name ?? gtfsStops.get(id)?.name ?? null;
      const pace = createPacer();
      let stopsOf = new Map();
      try {
        stopsOf = await tripStops(zip, pace);
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
    } catch (err) {
      log.warn(`[renfe] horarios de Cercanías: ${err.message}`);
    }
  }

  return {
    loadLd,
    loadCercanias,
    refreshLd,
    ld: (id, number) => ld.get(id) ?? ldByNumber.get(number),
    ldExact: (id) => ld.has(id),
    cercanias: (id) => cerc.get(id),
  };
}

/**
 * «Chamartín - Clara Campoamor             -Aranjuez»: Renfe da origen y destino en dos columnas de 40
 * caracteres separadas por «-». Partir por el guion no vale: también lo llevan algunos nombres.
 */
export function routeEnds(longName) {
  const text = String(longName ?? '');
  const [origin, destination] = text[40] === '-' ? [text.slice(0, 40), text.slice(41)] : text.split(/\s+-/);
  return { origin: origin?.trim() || null, destination: destination?.trim() || null };
}

/**
 * Paradas de cada viaje, en orden, leyendo el stop_times (290 MB en Cercanías) por trozos. Los
 * 138.000 viajes repiten unas 640 secuencias: cada una se guarda una vez, con su número en `id`.
 * Un viaje cuyas filas no vienen seguidas (el GTFS no lo exige, aunque Renfe lo hace) se descarta.
 * @returns {Promise<Map<string, string[] & { id: number }>>}
 */
async function tripStops(zip, pace) {
  const byTrip = new Map();
  const patterns = new Map();
  const broken = new Set();
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
    byTrip.set(own(trip), stops);
  };
  for await (const [tripId, stopId, seq] of csvColumnsStreamed(zip, 'stop_times.txt', ['trip_id', 'stop_id', 'stop_sequence'])) {
    if (pace.due()) await pace.pause();
    if (tripId !== trip) {
      close();
      trip = tripId;
      rows = [];
    }
    rows.push([+seq, stopId]);
  }
  close();
  for (const t of broken) byTrip.delete(t);
  return byTrip;
}

/**
 * Próxima parada de un tren de Cercanías. En el GTFS-RT de Cercanías, IN_TRANSIT_TO no trae la
 * estación a la que va, sino la que acaba de dejar (medido: 29 de 29 por detrás del tren); con
 * INCOMING_AT sí es a la que llega. La siguiente sale de las paradas del viaje (null si no se sabe).
 */
export function cercaniasNext(status, stopId, stops) {
  if (status !== 'IN_TRANSIT_TO') return stopId ?? null;
  const i = stops?.indexOf(stopId) ?? -1;
  return i >= 0 ? stops[i + 1] ?? null : null;
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
 * @param {{ http: import('../http/http-client.js').HttpClient, cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           stations: import('../../../application/ports.js').StationCatalogPort, log: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').DataSourcePort[]}
 */
export function createRenfeSources({ http, cache, stations, log }) {
  const timetables = createTimetables({ cache, stations, log });

  /** Campos comunes a partir de la posición GTFS-RT y su trip update. `nextId`: la próxima parada, si
   * no es la de stopId (Cercanías en camino: stopId es entonces la última estación, la que acaba de dejar). */
  function base(v, update, nextId = v.stopId) {
    const stopped = v.currentStatus === 'STOPPED_AT';
    // Algunas horas de los trip updates son de paradas ya pasadas: sólo vale si es futura.
    const eta = update?.arrivals.get(nextId);
    const futureEta = eta && eta * 1000 > Date.now() - 60_000 ? eta : null;
    return {
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

  const cercanias = {
    id: 'renfe-cercanias',
    name: 'Renfe Cercanías / Rodalies (GTFS-RT)',
    kind: 'vehicles',
    interval: 20_000,
    url: `${GTFSRT}/vehicle_positions.json`,
    page: 'https://data.renfe.com/dataset/ubicacion-vehiculos',
    license: ATTRIBUTION,
    // CC BY 4.0 permite modificar indicándolo: a veces repite posiciones viejas o da saltos imposibles.
    cleanPositions: true,
    async fetch() {
      await timetables.loadCercanias();
      const [positions, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates.json`)]);
      if (positions.status === 'rejected') throw positions.reason;
      const delays = tripUpdates(updates.status === 'fulfilled' ? updates.value : null);
      const vehicles = [];
      for (const e of positions.value.entity ?? []) {
        const v = e.vehicle;
        if (!hasPosition(v)) continue;
        const tripId = v.trip.tripId;
        // Etiqueta "C5-23737-PLATF.(5)": línea, número de tren y vía de la estación de stopId
        // (en la que está parado o a la que llega). Renfe no publica por qué vía va en el trayecto.
        const [, line, number, platform] = /^([A-Za-z]+\d*[a-z]?)-(\d+)(?:-PLATF\.\((\w+)\))?/.exec(v.vehicle?.label ?? '') ?? [];
        const route = timetables.cercanias(tripId);
        vehicles.push({
          id: `renfe-c:${tripId}`,
          // Un autobús de Renfe no es un tren: va con los autobuses y no cuenta en los retrasos ni en las alertas de tren.
          mode: route?.bus ? 'bus' : 'cercanias',
          operator: 'Renfe',
          service: route?.bus ? 'Autobús de Renfe' : 'Cercanías',
          line: line ?? route?.line ?? null,
          label: number ?? v.vehicle?.id ?? tripId,
          origin: route?.origin ?? null,
          destination: route?.destination ?? null,
          // La vía es la de stopId: con IN_TRANSIT_TO, la de la estación que acaba de dejar.
          platform: v.currentStatus === 'IN_TRANSIT_TO' ? null : platform ?? null,
          shape: route?.shape ?? null,
          end: route?.end ?? null,
          ...base(v, delays.get(tripId), cercaniasNext(v.currentStatus, v.stopId, route?.stops)),
        });
      }
      return { vehicles, sourceTime: freshest(positions.value, updates.status === 'fulfilled' ? updates.value : null) };
    },
  };

  const largaDistancia = {
    id: 'renfe-ld',
    name: 'Renfe Alta Velocidad, Larga y Media Distancia (GTFS-RT)',
    kind: 'vehicles',
    interval: 20_000,
    url: `${GTFSRT}/vehicle_positions_LD.json`,
    page: 'https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md',
    license: ATTRIBUTION,
    cleanPositions: true,
    async fetch() {
      await timetables.loadLd();
      const [positions, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates_LD.json`)]);
      if (positions.status === 'rejected') throw positions.reason;
      const delays = tripUpdates(updates.status === 'fulfilled' ? updates.value : null);
      const vehicles = [];
      const seen = new Set();
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
        vehicles.push({
          id: `renfe-ld:${number}`,
          mode: trip?.mode ?? 'ld',
          operator: 'Renfe',
          service: trip?.service ?? 'Renfe',
          line: trip?.service ?? null,
          label: number,
          origin: trip?.origin ?? null,
          destination: trip?.destination ?? null,
          ...base(v, delays.get(tripId)),
        });
      }
      // Mientras tanto vale el mismo número de tren del horario guardado; pero si muchos no están, es de ayer.
      if (unknown > vehicles.length / 4) timetables.refreshLd();
      return { vehicles, sourceTime: freshest(positions.value, updates.status === 'fulfilled' ? updates.value : null) };
    },
  };

  /** Trenes de Cercanías/Rodalies que el GTFS-RT marca como cancelados (sin posición: sólo la línea). */
  function cancellations(feed) {
    const events = [];
    for (const e of feed?.entity ?? []) {
      const trip = e.tripUpdate?.trip;
      if (trip?.scheduleRelationship !== 'CANCELED' || !trip.tripId) continue;
      const route = timetables.cercanias(trip.tripId);
      if (!route) continue; // viaje que no está en el horario vigente
      const number = /^\d+V(\d+)/.exec(trip.tripId)?.[1] ?? trip.tripId; // "1002V20109C3" → 20109
      const network = /^R/i.test(route.line ?? '') ? 'Rodalies' : 'Cercanías';
      events.push({
        id: `renfe-cancelado:${trip.tripId}`,
        category: 'ferroviario',
        type: 'cancelacion',
        severity: 'alta',
        title: `${network} ${route.line ?? ''} · ${route.bus ? 'autobús' : 'tren'} ${number} cancelado`.replace(/\s+/g, ' '),
        description: `Renfe marca el ${route.bus ? 'autobús' : 'tren'} como cancelado. Línea ${[route.origin, route.destination].filter(Boolean).join(' – ')}.`,
        lat: null,
        lon: null,
        start: null,
      });
    }
    return events;
  }

  const avisos = {
    id: 'renfe-avisos',
    name: 'Renfe avisos de servicio y trenes de Cercanías cancelados (GTFS-RT)',
    kind: 'events',
    interval: 120_000,
    url: `${GTFSRT}/alerts.json`,
    page: 'https://data.renfe.com/dataset/incidencias-avisos',
    license: ATTRIBUTION,
    async fetch() {
      await timetables.loadCercanias();
      const [alerts, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates.json`)]);
      if (alerts.status === 'rejected' && updates.status === 'rejected') throw alerts.reason;
      const d = alerts.status === 'fulfilled' ? alerts.value : null;
      const now = Date.now() / 1000;
      const events = updates.status === 'fulfilled' ? cancellations(updates.value) : [];
      for (const e of d?.entity ?? []) {
        const a = e.alert;
        if (!a) continue;
        const periods = a.activePeriod ?? [];
        const active = !periods.length || periods.some((p) => (!p.start || +p.start <= now) && (!p.end || +p.end >= now));
        if (!active) continue;
        const translations = a.descriptionText?.translation ?? a.headerText?.translation ?? [];
        const description = ((translations.find((t) => !t.language || t.language.startsWith('es')) ?? translations[0])?.text ?? '').trim();
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
      return { events, sourceTime: freshest(d, updates.status === 'fulfilled' ? updates.value : null) };
    },
  };

  return [cercanias, largaDistancia, avisos];
}
