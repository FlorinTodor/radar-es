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
import { createHttpClient } from './adapters/outbound/http/http-client.js';
import { createFileCache } from './adapters/outbound/http/file-cache.js';
import { createConsoleLogger } from './adapters/outbound/logging/console-logger.js';
import { createRenfeStationCatalog } from './adapters/outbound/stations/renfe-station-catalog.js';
import { createNetworkStationCatalog } from './adapters/outbound/stations/network-station-catalog.js';
import { createNapClient } from './adapters/outbound/nap/nap-client.js';
import { createGtfsNetworkCatalog } from './adapters/outbound/network/gtfs-network-catalog.js';
import { createAdifRailNetwork } from './adapters/outbound/network/adif-rail-network.js';
import { createInMemorySituation } from './adapters/outbound/persistence/in-memory-situation.js';
import { createJsonlHistory } from './adapters/outbound/persistence/jsonl-history.js';
import { createSources } from './adapters/outbound/sources/index.js';
import { startPolling } from './adapters/inbound/scheduler/polling-scheduler.js';
import { createHttpServer } from './adapters/inbound/http/http-server.js';
import { createWmsTiles } from './adapters/outbound/tiles/wms-tiles.js';
import { createCartoCiudadGeocoder, GEOCODER_MEMBERS } from './adapters/outbound/geo/cartociudad-geocoder.js';
import { createCpuPool, parseThreads } from './adapters/outbound/workers/cpu-pool.js';

const config = loadConfig();
const log = assertPort('Logger', createConsoleLogger(), PORT_MEMBERS.Logger);
const clock = assertPort('Clock', { now: () => Date.now() }, PORT_MEMBERS.Clock);
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
const network = assertPort('NetworkCatalog', createGtfsNetworkCatalog({ nap, cache, cacheDir, log, pool }), PORT_MEMBERS.NetworkCatalog);
const railNetwork = assertPort('RailNetwork', createAdifRailNetwork({ cache, log }), PORT_MEMBERS.RailNetwork);
const situation = assertPort('SituationRepository', createInMemorySituation(), PORT_MEMBERS.SituationRepository);
const history = assertPort('History', createJsonlHistory({ dir: new URL('history/', config.dataDir), log }), PORT_MEMBERS.History);
const tiles = assertPort('TileProvider', createWmsTiles({ http, dir: fileURLToPath(new URL('tiles/', config.dataDir)), log }), PORT_MEMBERS.TileProvider);

// Sitúa los municipios que citan los avisos del 112 (no traen coordenadas). No es un puerto de la
// aplicación (ningún caso de uso lo usa): sólo se lo pasan las fuentes de avisos oficiales.
const geocoder = assertPort('Geocoder', createCartoCiudadGeocoder({ http, log }), GEOCODER_MEMBERS);

const sources = createSources({ http, cache, stations, nap, log, env: config.env, pool, xmlPool, geocoder })
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
const ingestSource = makeIngestSource({ sources: enabledSources, situation, clock, log });
const detectAlerts = makeDetectAlerts({ situation, stations, history, clock });
const query = makeQuerySituation({ situation, stations, networkStations, network, clock, sources, railNetwork });
const serveTiles = makeServeTiles({ tiles });
const refreshCatalogs = makeRefreshCatalogs({ stations, networkStations, network, railNetwork, log });

// --- Adaptadores de entrada ------------------------------------------------
await refreshCatalogs(); // espera a las estaciones; los trazados y la red ferroviaria siguen cargándose detrás

const feeds = enabledSources.map(({ id, interval }) => ({ id, interval }));
const scheduler = startPolling({ feeds, ingestSource, detectAlerts, refreshCatalogs, log });

const server = createHttpServer({
  query,
  log,
  about: config.about,
  serveTiles,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, ''),
  vendorDirs: { '/vendor/maplibre/': fileURLToPath(new URL('../node_modules/maplibre-gl/dist/', import.meta.url)).replace(/\/$/, '') },
});

server.listen(config.port, config.host, () => {
  log.info(`Radar España escuchando en http://${config.host}:${config.port} · ${enabledSources.length}/${sources.length} fuentes activas`
    + ` · ${pool.threads() || 'sin'} hilo(s) de cálculo`);
});

function shutdown() {
  log.info('Cerrando…');
  scheduler.stop();
  pool.close();
  if (xmlPool !== pool) xmlPool.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// Una promesa rechazada que nadie recoge (un fallo en algún adaptador) se apunta y el servidor
// sigue: por defecto Node cerraría el proceso, y volver a arrancar son minutos sin datos.
process.on('unhandledRejection', (err) => log.error(`[sin recoger] ${err?.stack ?? err}`));
