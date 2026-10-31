// Renfe: posiciones y retrasos de Cercanías/Rodalies y de AV/Larga/Media Distancia, y avisos
// de servicio. Sólo se usan sus datos abiertos (CC BY 4.0, "Origen de los datos: Renfe
// Operadora"): el GTFS-RT de gtfsrt.renfe.com y sus GTFS de horarios para saber el producto,
// el origen y el destino de cada tren. Los endpoints internos de sus visores web no se usan:
// no tienen licencia de reutilización.
import { createPacer, csvColumns, csvRows, openGtfs, own } from '../gtfs/gtfs-reader.js';
import { RENFE_FILES } from '../stations/renfe-station-catalog.js';
import { num } from './parse.js';

const GTFSRT = 'https://gtfsrt.renfe.com';
const ATTRIBUTION = 'Origen de los datos: Renfe Operadora (CC BY 4.0; datos modificados: normalizados y combinados con sus horarios)';
const TIMETABLE_TTL_MS = 24 * 3600_000;
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
function createTimetables({ cache, stations, log }) {
  let ld = new Map();   // trip_id → { service, mode, origin, destination }
  let cerc = new Map(); // trip_id → { line, origin, destination }
  const loadedAt = { ld: 0, cerc: 0 };

  async function loadLd() {
    if (ld.size && Date.now() - loadedAt.ld < TIMETABLE_TTL_MS) return;
    loadedAt.ld = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      const f = await openGtfs(await cache.bytes(RENFE_FILES.largaDistancia, 'renfe-google_transit.zip', TIMETABLE_TTL_MS), ['routes.txt', 'trips.txt', 'stop_times.txt']);
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
      for (const t of csvRows(f['trips.txt'])) {
        if (pace.due()) await pace.pause();
        const [service, mode] = product(routes.get(t.route_id));
        const e = ends.get(t.trip_id);
        next.set(t.trip_id, { service, mode, origin: e ? stations.name(e[0][1]) : null, destination: e ? stations.name(e[1][1]) : null });
      }
      ld = next;
    } catch (err) {
      log.warn(`[renfe] horarios AV/LD/MD: ${err.message}`);
    }
  }

  async function loadCercanias() {
    if (cerc.size && Date.now() - loadedAt.cerc < TIMETABLE_TTL_MS) return;
    loadedAt.cerc = Date.now();
    try {
      // 16 MB: sólo se descomprimen rutas y viajes (el stop_times ocupa 290 MB).
      const f = await openGtfs(await cache.bytes(RENFE_FILES.cercanias, 'renfe-fomento_transit.zip', TIMETABLE_TTL_MS), ['routes.txt', 'trips.txt']);
      const routes = new Map();
      for (const r of csvRows(f['routes.txt'])) {
        // route_long_name: "Principe Pio                            -Aeropuerto-T4"
        const [origin, destination] = r.route_long_name.split(/\s+-/).map((s) => s.trim());
        routes.set(r.route_id, { line: r.route_short_name || null, origin: origin || null, destination: destination || null });
      }
      const next = new Map();
      const pace = createPacer(); // 250.000 viajes
      for (const [tripId, routeId] of csvColumns(f['trips.txt'], ['trip_id', 'route_id'])) {
        if (pace.due()) await pace.pause();
        const route = routes.get(routeId);
        if (route) next.set(own(tripId), route);
      }
      cerc = next;
    } catch (err) {
      log.warn(`[renfe] horarios de Cercanías: ${err.message}`);
    }
  }

  return { loadLd, loadCercanias, ld: (id) => ld.get(id), cercanias: (id) => cerc.get(id) };
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

  /** Campos comunes a partir de la posición GTFS-RT y su trip update. */
  function base(v, update) {
    const stopped = v.currentStatus === 'STOPPED_AT';
    // Algunas horas de los trip updates son de paradas ya pasadas: sólo vale si es futura.
    const eta = update?.arrivals.get(v.stopId);
    const futureEta = eta && eta * 1000 > Date.now() - 60_000 ? eta : null;
    return {
      lat: v.position.latitude,
      lon: v.position.longitude,
      delay: update?.delay === null || update?.delay === undefined ? null : Math.round(update.delay / 60),
      current: stopped ? stations.name(v.stopId) : null,
      next: stopped ? null : stations.name(v.stopId),
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
    license: ATTRIBUTION,
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
          mode: 'cercanias',
          operator: 'Renfe',
          service: 'Cercanías',
          line: line ?? route?.line ?? null,
          label: number ?? v.vehicle?.id ?? tripId,
          origin: route?.origin ?? null,
          destination: route?.destination ?? null,
          platform: platform ?? null,
          ...base(v, delays.get(tripId)),
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
    license: ATTRIBUTION,
    async fetch() {
      await timetables.loadLd();
      const [positions, updates] = await Promise.allSettled([http.json(this.url), http.json(`${GTFSRT}/trip_updates_LD.json`)]);
      if (positions.status === 'rejected') throw positions.reason;
      const delays = tripUpdates(updates.status === 'fulfilled' ? updates.value : null);
      const vehicles = [];
      const seen = new Set();
      for (const e of positions.value.entity ?? []) {
        const v = e.vehicle;
        if (!hasPosition(v)) continue;
        const tripId = v.trip.tripId; // "0019012026-10-30": número de tren + fecha
        const number = v.vehicle?.id || tripId.slice(0, 5);
        if (seen.has(number)) continue;
        seen.add(number);
        const trip = timetables.ld(tripId);
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
        title: `${network} ${route.line ?? ''} · tren ${number} cancelado`.replace(/\s+/g, ' '),
        description: `Renfe marca el tren como cancelado. Línea ${[route.origin, route.destination].filter(Boolean).join(' – ')}.`,
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
