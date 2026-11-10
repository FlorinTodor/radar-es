// Raíz de composición: el único sitio donde se eligen las implementaciones concretas
// de cada puerto y se conectan con los casos de uso y los adaptadores de entrada.
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { assertPort, PORT_MEMBERS } from './application/ports.js';
import { makeIngestSource } from './application/use-cases/ingest-source.js';
import { makeDetectAlerts } from './application/use-cases/detect-alerts.js';
import { makeQuerySituation } from './application/use-cases/query-situation.js';
import { makeServeTiles } from './application/use-cases/serve-tiles.js';
import { makeRefreshCatalogs } from './application/use-cases/refresh-catalogs.js';
import { makeLinesOnRail } from './application/use-cases/lines-on-rail.js';
import { makeKeepTracks } from './application/use-cases/keep-tracks.js';
import { makeRecordPunctuality } from './application/use-cases/record-punctuality.js';
import { makeDayInFigures } from './application/use-cases/day-in-figures.js';
import { makeFollowBot } from './application/use-cases/follow-bot.js';
import { createHttpClient } from './adapters/outbound/http/http-client.js';
import { createFileCache } from './adapters/outbound/http/file-cache.js';
import { createConsoleLogger } from './adapters/outbound/logging/console-logger.js';
import { withLogCounts } from './adapters/outbound/logging/counting-logger.js';
import { createPrometheusMetrics } from './adapters/outbound/metrics/prometheus-metrics.js';
import { createRenfeStationCatalog } from './adapters/outbound/stations/renfe-station-catalog.js';
import { createNetworkStationCatalog } from './adapters/outbound/stations/network-station-catalog.js';
import { createNapClient } from './adapters/outbound/nap/nap-client.js';
import { createGtfsNetworkCatalog } from './adapters/outbound/network/gtfs-network-catalog.js';
import { createAdifRailNetwork } from './adapters/outbound/network/adif-rail-network.js';
import { createIgnRailNetwork } from './adapters/outbound/network/ign-rail-network.js';
import { createInMemorySituation } from './adapters/outbound/persistence/in-memory-situation.js';
import { createJsonlHistory } from './adapters/outbound/persistence/jsonl-history.js';
import { createTrackStore } from './adapters/outbound/persistence/track-store.js';
import { createPunctualityStore } from './adapters/outbound/persistence/punctuality-store.js';
import { createDayStore } from './adapters/outbound/persistence/day-store.js';
import { createFollowStore } from './adapters/outbound/persistence/follow-store.js';
import { createFileLease } from './adapters/outbound/persistence/file-lease.js';
import { createTelegramApi } from './adapters/outbound/telegram/telegram-api.js';
import { createTelegramBot } from './adapters/inbound/telegram/telegram-bot.js';
import { createSources } from './adapters/outbound/sources/index.js';
import { startPolling } from './adapters/inbound/scheduler/polling-scheduler.js';
import { createHttpServer, sharedDomainFiles } from './adapters/inbound/http/http-server.js';
import { createMetricsServer } from './adapters/inbound/http/metrics-server.js';
import { createMcpHandler } from './adapters/inbound/mcp/mcp.js';
import pkg from '../package.json' with { type: 'json' };
import { createWmsTiles } from './adapters/outbound/tiles/wms-tiles.js';
import { createCartoCiudadGeocoder, GEOCODER_MEMBERS } from './adapters/outbound/geo/cartociudad-geocoder.js';
import { createCpuPool, parseThreads } from './adapters/outbound/workers/cpu-pool.js';

const config = loadConfig();
const clock = assertPort('Clock', { now: () => Date.now() }, PORT_MEMBERS.Clock);
// Métricas para la monitorización: peticiones, mensajes MCP, lecturas de fuentes y avisos del registro.
const metrics = assertPort('Metrics', createPrometheusMetrics({ version: pkg.version, now: clock.now }), PORT_MEMBERS.Metrics);
const log = assertPort('Logger', withLogCounts(createConsoleLogger(), metrics), PORT_MEMBERS.Logger);
const http = createHttpClient({ userAgent: config.userAgent });

// --- Adaptadores de salida -------------------------------------------------
// Hilos para el trabajo de CPU (horarios GTFS, trazados, XML de la DGT): desactivados salvo que
// WORKER_THREADS diga cuántos (ver parseThreads: falta medir su pico de memoria en el peor caso).
const pool = createCpuPool({ threads: parseThreads(config.env.WORKER_THREADS), log });
// El XML de la DGT (unos 4 MB cada 5 min) tardaba más de 2 s en el hilo principal y paraba la web
// mientras tanto: sin hilos de cálculo, va a uno propio, pequeño (no carga horarios).
const xmlPool = pool.threads() ? pool : createCpuPool({ threads: 1, heapMb: 192, log });
const cacheDir = new URL('cache/', config.dataDir);
const cache = createFileCache({ http, dir: cacheDir, log });
const nap = createNapClient({ cache, apiKey: config.env.NAP_API_KEY });
const stations = assertPort('StationCatalog', createRenfeStationCatalog({ cache, cacheDir, log }), PORT_MEMBERS.StationCatalog);
// Estaciones de metro, tranvía y las demás redes: aparte, para que las alertas y Rodalies sólo vean las de Renfe.
const networkStations = assertPort('StationCatalog(redes)', createNetworkStationCatalog({ nap, cache, cacheDir, log, renfe: stations }), PORT_MEMBERS.StationCatalog);
const railNetwork = assertPort('RailNetwork', createAdifRailNetwork({ cache, log }), PORT_MEMBERS.RailNetwork);
// Vías de toda España, con metro, tranvía y funicular (IGN): los trazados que los operadores publican
// casi sólo con sus estaciones, o no publican, se llevan por ellas (líneas del mapa y posiciones estimadas).
const railGeometry = assertPort('RailNetwork(IGN)', createIgnRailNetwork({ http, cache, log }), PORT_MEMBERS.RailNetwork);
const network = assertPort('NetworkCatalog',
  makeLinesOnRail({ network: createGtfsNetworkCatalog({ nap, cache, cacheDir, log, pool }), railGeometry }), PORT_MEMBERS.NetworkCatalog);
const situation = assertPort('SituationRepository', createInMemorySituation(), PORT_MEMBERS.SituationRepository);
const history = assertPort('History', createJsonlHistory({ dir: new URL('history/', config.dataDir), log }), PORT_MEMBERS.History);
const trackStore = assertPort('TrackStore', createTrackStore({ cache }), PORT_MEMBERS.TrackStore);
const punctualityStore = assertPort('PunctualityStore', createPunctualityStore({ dir: cacheDir, log }), PORT_MEMBERS.PunctualityStore);
// El mismo histórico se lee para el día en cifras (KPI y alertas de días pasados); su registro de cada día, aparte.
const historyReader = assertPort('HistoryReader', history, PORT_MEMBERS.HistoryReader);
const dayStore = assertPort('DayStore', createDayStore({ dir: new URL('dias/', config.dataDir), log }), PORT_MEMBERS.DayStore);
const tiles = assertPort('TileProvider', createWmsTiles({ http, dir: fileURLToPath(new URL('tiles/', config.dataDir)), log }), PORT_MEMBERS.TileProvider);

// Sitúa los municipios que citan los avisos del 112 (no traen coordenadas). No es un puerto de la
// aplicación (ningún caso de uso lo usa): sólo se lo pasan las fuentes de avisos oficiales.
const geocoder = assertPort('Geocoder', createCartoCiudadGeocoder({ http, log }), GEOCODER_MEMBERS);

const sources = createSources({ http, cache, stations, nap, log, env: config.env, pool, xmlPool, geocoder, railGeometry })
  .map((s) => assertPort(`DataSource(${s.id})`, s, PORT_MEMBERS.DataSource));

const enabledSources = [];
for (const s of sources) {
  const missing = (s.requires ?? []).filter((k) => !config.env[k]);
  // Una fuente en pausa (`paused`, con su motivo) se registra y se cita, pero no se lee.
  situation.registerSource(s, { enabled: !missing.length && !s.paused, reason: s.paused ?? (missing.length ? `Falta ${missing.join(', ')} en .env` : null) });
  if (s.paused) log.info(`[${s.id}] en pausa: ${s.paused}`);
  else if (missing.length) log.warn(`[${s.id}] desactivada: falta ${missing.join(', ')}`);
  else enabledSources.push(s);
}

// --- Casos de uso ----------------------------------------------------------
const ingestSource = makeIngestSource({ sources: enabledSources, situation, clock, log, metrics });
const detectAlerts = makeDetectAlerts({ situation, stations, history, clock, log });
const recordPunctuality = makeRecordPunctuality({ situation, store: punctualityStore, clock, log });
const query = makeQuerySituation({ situation, stations, networkStations, network, clock, sources, railNetwork, punctuality: recordPunctuality });
const serveTiles = makeServeTiles({ tiles });
const refreshCatalogs = makeRefreshCatalogs({ stations, networkStations, network, railNetwork, railGeometry, log });
const keepTracks = makeKeepTracks({ situation, store: trackStore, clock, log });
const dayInFigures = makeDayInFigures({ situation, history: historyReader, store: dayStore, clock, log });

// --- Adaptadores de entrada ------------------------------------------------
await refreshCatalogs(); // espera a las estaciones; los trazados y la red ferroviaria siguen cargándose detrás
// Justo antes de la primera lectura: en un relevo, el servidor anterior sigue en marcha y guardando
// su copia cada minuto, así que la estela de cada tren sigue sin hueco (o casi).
await keepTracks.restore().catch((err) => log.warn(`[estelas] no se pudo recuperar el historial: ${err.message}`));
await recordPunctuality.restore().catch((err) => log.warn(`[puntualidad] no se pudo recuperar: ${err.message}`));
// El registro de hoy del día en cifras: un reinicio no empieza el día de cero.
await dayInFigures.restore().catch((err) => log.warn(`[día en cifras] no se pudo recuperar el día: ${err.message}`));

const feeds = enabledSources.map(({ id, interval }) => ({ id, interval }));
// Trabajos periódicos: la puntualidad (sus lecturas cada minuto y una copia cada cuarto de hora, y al apagar:
// lo que se pierde si el servidor se cae sin apagarse es, como mucho, ese cuarto de hora) y el día en cifras
// (suma el minuto; guarda su registro cada 5 minutos).
const tasks = [
  { name: 'puntualidad', every: 60_000, run: recordPunctuality.tick },
  { name: 'puntualidad', every: 15 * 60_000, run: recordPunctuality.save },
  { name: 'día en cifras', every: 60_000, run: dayInFigures.tick },
];
const scheduler = startPolling({ feeds, ingestSource, detectAlerts, refreshCatalogs, saveTracks: keepTracks.save, tasks, log });

// Bot de Telegram «Sigue tu tren» (docs/telegram.md): sin TELEGRAM_BOT_TOKEN en .env, desactivado.
let telegramBot = null;
// Cuánto se usa, para las métricas (con sus totales, que se guardan con lo demás del bot y no vuelven a 0 al
// arrancar): sólo del servidor que atiende el bot; en un relevo, el otro no dice nada.
let botUsage = () => null;
if (!config.telegram) {
  log.warn('[telegram] bot desactivado: falta TELEGRAM_BOT_TOKEN');
} else {
  if (!config.telegram.username) log.warn('[telegram] falta TELEGRAM_BOT_USERNAME: el bot funciona, pero la web no enseña el botón «Avísame por Telegram»');
  const botDir = new URL('bot/', config.dataDir);
  // La atribución de cada aviso: la licencia de su fuente (la del operador, si la fuente agrupa a varios).
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const creditOf = (id, operator) => sourceById.get(id)?.operatorLicenses?.[operator] ?? sourceById.get(id)?.license ?? null;
  const followBot = makeFollowBot({
    read: {
      vehicles: () => query.vehicles(), events: () => query.events(), station: (code) => query.station(code),
      // Para «Mi trayecto»: las paradas del viaje de cada vehículo y el catálogo de estaciones.
      stops: (id) => query.stops(id), stations: () => query.stations(),
    },
    store: assertPort('FollowStore', createFollowStore({ dir: botDir, log }), PORT_MEMBERS.FollowStore),
    clock,
    creditOf,
    webUrl: config.telegram.webUrl,
    log,
  });
  telegramBot = createTelegramBot({
    api: assertPort('ChatChannel', createTelegramApi({ http, token: config.telegram.token }), PORT_MEMBERS.ChatChannel),
    bot: followBot,
    lease: assertPort('Lease', createFileLease({ dir: botDir }), PORT_MEMBERS.Lease),
    log,
  });
  telegramBot.start();
  botUsage = () => (telegramBot.active ? followBot.usage() : null);
}

const server = createHttpServer({
  query,
  log,
  about: config.about,
  serveTiles,
  days: dayInFigures,
  // Servidor MCP en POST /mcp: los asistentes de IA consultan el directo con herramientas.
  mcp: createMcpHandler({ query, about: config.about, version: pkg.version, now: clock.now }),
  metrics,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, ''),
  vendorDirs: { '/vendor/maplibre/': fileURLToPath(new URL('../node_modules/maplibre-gl/dist/', import.meta.url)).replace(/\/$/, '') },
  // Las claves, el registro de tipos y el estado de lo que se sigue: el navegador usa los mismos módulos.
  sharedFiles: sharedDomainFiles(fileURLToPath(new URL('./domain/', import.meta.url))),
});

server.listen(config.port, config.host, () => {
  log.info(`Radar España escuchando en http://${config.host}:${config.port} · ${enabledSources.length}/${sources.length} fuentes activas`
    + ` · ${pool.threads() || 'sin'} hilo(s) de cálculo`);
});

// Métricas en un puerto aparte, que no pasa por nginx ni por el túnel (sólo si METRICS_PORT lo dice).
const metricsServer = config.metricsPort
  ? createMetricsServer({ render: () => metrics.render({ sources: query.health(), bot: botUsage(), now: clock.now() }), log })
  : null;
metricsServer?.listen(config.metricsPort, config.metricsHost, () => {
  log.info(`Métricas en http://${config.metricsHost}:${config.metricsPort}/metrics`);
});

function shutdown() {
  log.info('Cerrando…');
  scheduler.stop();
  // El bot guarda lo suyo y suelta su turno, para que lo coja enseguida el servidor que releva a éste.
  const botStopped = telegramBot?.stop().catch((err) => log.warn(`[telegram] ${err.message}`));
  metricsServer?.close();
  metrics.close();
  pool.close();
  if (xmlPool !== pool) xmlPool.close();
  // Lo último que se guarda: el historial de posiciones, la puntualidad y el día en cifras, para que el
  // siguiente arranque los siga; y el bot suelta su turno.
  Promise.allSettled([keepTracks.save(), recordPunctuality.save(), dayInFigures.save(), botStopped])
    .then((results) => results.filter((r) => r.status === 'rejected').forEach((r) => log.warn(`[al cerrar] ${r.reason?.message ?? r.reason}`)))
    .finally(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Una promesa rechazada que nadie recoge (un fallo en algún adaptador) se apunta y el servidor
// sigue: por defecto Node cerraría el proceso, y volver a arrancar son minutos sin datos.
process.on('unhandledRejection', (err) => log.error(`[sin recoger] ${err?.stack ?? err}`));
