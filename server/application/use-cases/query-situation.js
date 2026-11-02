// Casos de uso de consulta: lo que los adaptadores de entrada (la API HTTP) pueden preguntar.
import { sortAlerts } from '../../domain/alerts/lifecycle.js';
import { headingOf } from '../../domain/tracking.js';
import { headingOfPath, pathThroughStops } from '../../domain/route-ahead.js';
import { gaugeFactors, matchToRail, routeAhead } from '../../domain/rail-match.js';
import { round5 } from '../../domain/geo.js';
import { inForce } from '../../domain/model.js';
import { withCurrentCuts } from '../../domain/emergencias.js';
import { GRID_METRICS } from '../../domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../domain/alerts/thresholds.js';

// Cálculos por tren que se guardan (recorrido por la vía, ~30 KB cada uno; lo que le queda): el mapa
// pide los del tren seleccionado cada 15 s, /api/live la flecha de cada Cercanías, y sólo cambian
// cuando el tren da una posición nueva. Caben todos los trenes de cada memo a la vez, con margen: si
// fueran menos que los que se miran, cada cálculo nuevo echaría otro y el memo se vaciaría en bucle.
const TRAIN_MEMO_MAX = 1_000;
const SWEEP_MIN = 64; // por debajo de esto no se barre: es poca memoria

/**
 * Cálculos por tren guardados mientras no cambien `key` ni la red: `get(id, net, key, compute)`. Sin
 * memoria de más: cuando el memo dobla lo que tenía tras el último barrido, salen los trenes que ya no
 * tienen recorrido (`live`) y, si aun así son muchos, los calculados hace más. Barrer en cada cálculo
 * nuevo costaba recorrer el memo entero cientos de veces por lectura (la flecha de cada Cercanías).
 */
function makeTrainMemo(live) {
  const memo = new Map(); // id → { key, value }, del calculado hace más al más reciente
  let memoNet = null;
  let sweepAt = SWEEP_MIN;
  return (id, net, key, compute) => {
    if (net !== memoNet) { // red o trazados nuevos (al recargarlos): lo calculado con los anteriores no vale
      memo.clear();
      memoNet = net;
    }
    const hit = memo.get(id);
    if (hit?.key === key) return hit.value;
    const value = compute();
    memo.delete(id);
    if (memo.size >= sweepAt) {
      const tracks = live();
      for (const old of memo.keys()) if (!tracks.has(old)) memo.delete(old);
      for (const old of memo.keys()) if (memo.size >= TRAIN_MEMO_MAX) memo.delete(old); else break;
      sweepAt = Math.min(TRAIN_MEMO_MAX, Math.max(SWEEP_MIN, memo.size * 2));
    }
    memo.set(id, { key, value });
    return value;
  };
}

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           network: import('../ports.js').NetworkCatalogPort, clock: import('../ports.js').ClockPort,
 *           sources?: import('../ports.js').DataSourcePort[], networkStations?: import('../ports.js').StationCatalogPort,
 *           railNetwork?: import('../ports.js').RailNetworkPort, thresholds?: typeof DEFAULT_THRESHOLDS }} deps
 *   networkStations: estaciones de metro, tranvía y las demás redes que no son de Renfe.
 *   railNetwork: sin él, los recorridos de todas las fuentes se unen con rectas.
 *   thresholds: los de las alertas; los avisos de corte de luz usan los de la demanda de las islas.
 */
export function makeQuerySituation({ situation, stations, networkStations, network, clock, sources = [], railNetwork, thresholds = DEFAULT_THRESHOLDS }) {
  const withPaths = sources.filter((s) => typeof s.path === 'function');
  // Los sucesos en vigor: un aviso oficial que ya pasó de su vigencia no se muestra aunque su fuente
  // esté caída y el repositorio guarde su última lectura; y un corte de luz que ya no lo es (al día, o
  // en una isla cuya demanda eléctrica ya es normal) se muestra como el plan que es.
  const currentEvents = () => {
    const now = clock.now();
    const grid = situation.metrics()[GRID_METRICS.aislados]?.systems;
    return withCurrentCuts(situation.events().filter((e) => inForce(e, now)), { now, grid, thresholds });
  };
  // Fuentes que dicen las paradas que le quedan a cada tren (Cercanías de Renfe): lo que le queda se
  // dibuja por el trazado de su viaje, pero sólo entre esas paradas (ver domain/route-ahead.js).
  const withStops = new Map(sources.filter((s) => typeof s.stopsAhead === 'function').map((s) => [s.id, s]));
  let shapesOf = null; // colección de líneas → «red|shape_id» → coordenadas
  let shapes = new Map();
  const shapeCoords = (net, id) => {
    const lines = network.lines();
    if (lines !== shapesOf) {
      shapesOf = lines;
      shapes = new Map();
      for (const f of lines?.features ?? []) for (const sid of f.properties?.shapes ?? []) shapes.set(`${f.properties.network}|${sid}`, f.geometry?.coordinates);
    }
    return shapes.get(`${net}|${id}`);
  };
  // Se recalcula cuando cambian la posición o las paradas, o se recargan los trazados; los trenes que
  // ya no tienen recorrido (viajes acabados) salen del memo al guardar otro.
  const stopsMemo = makeTrainMemo(() => situation.tracks());
  const headingMemo = makeTrainMemo(() => situation.tracks());
  /** Lo que le queda por las paradas que le quedan; con `upTo`, sólo hasta esa parada (para la flecha). */
  const stopsPath = (v, memo = stopsMemo, upTo = Infinity) => {
    const s = withStops.get(v.source);
    const all = s && v.shape ? s.stopsAhead(v.id) : null;
    if (!all) return null;
    const stops = all.length > upTo ? all.slice(0, upTo) : all;
    const key = `${v.lon},${v.lat},${stops.length},${stops[0]}`;
    return memo(v.id, network.lines(), key, () => {
      const coords = shapeCoords(s.shapeNetwork, v.shape);
      return coords ? pathThroughStops(coords, [v.lon, v.lat], stops) : null;
    });
  };
  // La flecha de cada Cercanías en /api/live sólo mira los primeros metros de lo que le queda: basta
  // con llegar a sus próximas paradas, no a su destino (en cada lectura de Renfe se calcula para cada
  // tren que se ha movido; hasta el destino, el trabajo de /api/live se multiplicaba por veinte).
  const HEADING_STOPS = 3;
  const stopsHeading = (v) => headingOfPath(stopsPath(v, headingMemo, HEADING_STOPS));
  const railSources = sources.filter((s) => s.onRailNetwork);
  const railPrefixes = railSources.map((s) => `${s.id}:`);
  const onRails = (id) => railPrefixes.some((prefix) => id.startsWith(prefix));
  const withTrips = railSources.filter((s) => typeof s.railTrip === 'function');
  /** Viaje de un tren de la red general ({ gauge, stops }); null si no se sabe; undefined si no es de ninguna. */
  const railTripOf = (id) => {
    for (const s of withTrips) {
      const trip = s.railTrip(id);
      if (trip !== undefined) return trip;
    }
    return undefined;
  };
  const trackMemo = makeTrainMemo(() => situation.tracks());
  const aheadMemo = makeTrainMemo(() => situation.tracks());

  /**
   * Recorrido de un tren por la vía, como lista de { lon, lat } (lo mismo que dibuja el mapa con las
   * posiciones crudas: donde faltan datos se parte igual). null si no hay red cargada.
   */
  const railTrack = (id, track) => {
    const net = railNetwork?.network();
    if (!net || track.length < 2) return null;
    // Cambia al llegar una posición nueva o al salir de la ventana de 45 min la más antigua.
    const key = `${track.length}:${track[0].t}:${track.at(-1).t}`;
    // Entre dos posiciones lejanas, mejor la vía de su ancho que una paralela del otro.
    const factors = gaugeFactors(railTripOf(id)?.gauge);
    return trackMemo(id, net, key, () => matchToRail(net, track, { factors }).flat().map(([lon, lat]) => ({ lon: round5(lon), lat: round5(lat) })));
  };

  /**
   * Lo que le queda a un tren de la red general, por la vía: desde su última posición, pasando por las
   * paradas que le quedan. null si no hay red, el tren no está en ella o no hay un camino razonable.
   */
  const railAhead = (id, trip) => {
    const net = railNetwork?.network();
    const at = situation.tracks().get(id)?.at(-1);
    const stops = trip?.stops;
    if (!net || !at || !stops?.length) return null;
    const key = `${at.lon},${at.lat}|${stops.length}|${stops[0]}`;
    const factors = gaugeFactors(trip.gauge);
    return aheadMemo(id, net, key, () => routeAhead(net, [at.lon, at.lat], stops, { factors })?.map(([lon, lat]) => [round5(lon), round5(lat)]) ?? null);
  };
  const alerts = () => sortAlerts(situation.activeAlerts().values());
  // Los autobuses (miles en hora punta) sólo se envían a quien tiene activada su capa.
  const busFilter = (buses) => (buses ? (list) => list : (list) => list.filter((v) => v.mode !== 'bus'));
  // Pero cuántos hay de cada tipo se envía siempre: el panel de capas lo muestra con la capa apagada.
  const countByMode = (list, into = {}) => {
    for (const v of list) into[v.mode] = (into[v.mode] ?? 0) + 1;
    return into;
  };

  // Cada vehículo del directo lleva hacia dónde va, sacado de su historial: el mapa lo dibuja con una flecha.
  const withHeading = (list) => {
    const tracks = situation.tracks();
    return list.map((v) => {
      if (Number.isFinite(v.heading)) return v; // la fuente sabe por dónde va (su recorrido): mejor que el rastro
      // Por su vía hacia su próxima parada: mejor que el rastro (Renfe va a veces adelante y atrás).
      const along = withStops.has(v.source) ? stopsHeading(v) : null;
      if (along !== null) return { ...v, heading: along };
      const heading = headingOf(tracks.get(v.id));
      return heading === null ? v : { ...v, heading };
    });
  };

  return {
    vehicles({ mode, source, minDelay } = {}) {
      return situation.vehicles().filter((v) =>
        (!mode || v.mode === mode) && (!source || v.source === source) && (minDelay === undefined || (v.delay ?? -1) >= minDelay));
    },
    events({ category } = {}) {
      return currentEvents().filter((e) => !category || e.category === category);
    },
    alerts,
    resolvedAlerts: () => situation.resolvedAlerts(),
    health: () => situation.health(),
    metrics: () => situation.metrics(),
    kpis: () => ({ current: situation.kpis(), history: situation.kpiHistory() }),
    // La lista la descarga cada visita al abrir el mapa: sólo lo que hace falta para pintarlas y
    // buscarlas. La ficha completa de una estación, con sus fotos y enlaces, va aparte (station).
    // Las de otras redes llevan además su red y su modo (metro, tranvía…), para filtrarlas y pintarlas.
    stations: () => [...stations.all(), ...(networkStations?.all() ?? [])].map(({ code, name, place, province, lat, lon, cercanias, metricGauge, accessible, network: net, networkId, mode }) => (
      { code, name, place, province, lat, lon, cercanias, metricGauge, accessible, ...(networkId ? { network: net, networkId, mode } : {}) })),
    station: (code) => stations.get(code) ?? networkStations?.get(code) ?? null,
    lines: () => network.lines(),
    lineSources: () => network.sources(),
    /**
     * Recorrido reciente de un vehículo. Los de posición estimada usan su trazado (las posiciones de
     * cada lectura, unidas con rectas, cruzarían manzanas); los que no tienen trazado, ninguno. Los
     * trenes de la red ferroviaria general (AVE, Larga y Media Distancia), por la vía entre posición y
     * posición; el resto, sus posiciones tal cual.
     */
    track(id) {
      for (const s of withPaths) {
        const path = s.path(id);
        if (path !== undefined) return path ? path.map(([lon, lat]) => ({ lon, lat })) : [];
      }
      const track = situation.tracks().get(id) ?? null;
      return (track && onRails(id) && railTrack(id, track)) || track;
    },
    /**
     * Lo que le queda a un vehículo hasta el final de su viaje, por su vía: los de posición estimada,
     * con su horario; los de la red general (AVE, Larga y Media Distancia), por los tramos de Adif hasta
     * su destino; los de Cercanías, por el trazado de su viaje pasando por sus paradas. null si no se sabe.
     */
    ahead(id) {
      for (const s of withPaths) {
        const path = s.ahead?.(id);
        if (path !== undefined) return path && path.length > 1 ? path : null;
      }
      const trip = railTripOf(id);
      if (trip !== undefined) return railAhead(id, trip);
      // Sólo si una fuente sabe sus paradas (una búsqueda en su Map) se busca el vehículo: la lista de
      // vehículos se monta entera en cada consulta (miles, con los autobuses), y un id inventado no
      // debe costar eso (ni gasta el presupuesto de /api/ahead, porque no da nada).
      if (![...withStops.values()].some((s) => s.stopsAhead(id))) return null;
      const v = situation.vehicles().find((x) => x.id === id);
      const path = v ? stopsPath(v) : null;
      return path && path.length > 1 ? path.map(([lon, lat]) => [round5(lon), round5(lat)]) : null;
    },

    /** Estelas de todos los trenes (sin autobuses) en los últimos `minutes` minutos, como GeoJSON. */
    trails(minutes = 15) {
      const since = clock.now() - minutes * 60_000;
      const modes = new Map(situation.vehicles().map((v) => [v.id, v.mode]));
      const features = [];
      for (const [id, track] of situation.tracks()) {
        const mode = modes.get(id);
        if (!mode || mode === 'bus') continue;
        const points = track.filter((p, i) => p.t >= since || i === track.length - 1);
        if (points.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: points.map((p) => [round5(p.lon), round5(p.lat)]) },
          properties: { id, mode },
        });
      }
      return { type: 'FeatureCollection', features };
    },

    // ---------- Directo por consulta periódica (lo que Cloudflare guarda unos segundos) ----------
    // Separado por ritmo de cambio y tamaño: las posiciones cambian cada pocos segundos; las
    // incidencias (más de mil, de tráfico sobre todo) cada minuto; los autobuses son miles y sólo
    // los pide quien activa su capa.

    /** Posiciones (sin autobuses), recuento por fuente y tipo, alertas e indicadores. */
    live() {
      const vehicles = situation.vehicles();
      const counts = {};
      for (const v of vehicles) countByMode([v], counts[v.source] ??= {});
      return {
        generatedAt: clock.now(),
        vehicles: withHeading(busFilter(false)(vehicles)),
        counts,
        metrics: situation.metrics(),
        alerts: alerts(),
        resolved: situation.resolvedAlerts().slice(0, 30),
        kpis: situation.kpis(),
      };
    },
    liveEvents: () => ({ generatedAt: clock.now(), events: currentEvents() }),
    liveBuses: () => ({ generatedAt: clock.now(), vehicles: withHeading(situation.vehicles().filter((v) => v.mode === 'bus')) }),

    snapshot({ buses = true } = {}) {
      const vehicles = situation.vehicles();
      const counts = {}; // fuente → { modo: número }
      for (const v of vehicles) countByMode([v], counts[v.source] ??= {});
      return {
        generatedAt: clock.now(),
        vehicles: busFilter(buses)(vehicles),
        counts,
        events: currentEvents(),
        metrics: situation.metrics(),
        alerts: alerts(),
        resolved: situation.resolvedAlerts().slice(0, 30),
        health: situation.health(),
        kpis: { current: situation.kpis(), history: situation.kpiHistory() },
      };
    },
  };
}
