// Raíz de composición: el único sitio donde se eligen las implementaciones concretas
// de cada puerto y se conectan con los casos de uso y los adaptadores de entrada.
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { assertPort, PORT_MEMBERS } from './application/ports.js';
import { makeIngestSource } from './application/use-cases/ingest-source.js';
import { makeDetectAlerts } from './application/use-cases/detect-alerts.js';
import { makeQuerySituation } from './application/use-cases/query-situation.js';
import { createHttpClient } from './adapters/outbound/http/http-client.js';
import { createFileCache } from './adapters/outbound/http/file-cache.js';
import { createConsoleLogger } from './adapters/outbound/logging/console-logger.js';
import { createRenfeStationCatalog } from './adapters/outbound/stations/renfe-station-catalog.js';
import { createNapClient } from './adapters/outbound/nap/nap-client.js';
import { createGtfsNetworkCatalog } from './adapters/outbound/network/gtfs-network-catalog.js';
import { createInMemorySituation } from './adapters/outbound/persistence/in-memory-situation.js';
import { createJsonlHistory } from './adapters/outbound/persistence/jsonl-history.js';
import { createInProcessEventBus } from './adapters/outbound/events/in-process-event-bus.js';
import { createSources } from './adapters/outbound/sources/index.js';
import { startPolling } from './adapters/inbound/scheduler/polling-scheduler.js';
import { createHttpServer } from './adapters/inbound/http/http-server.js';

const config = loadConfig();
const log = createConsoleLogger();
const clock = { now: () => Date.now() };
const http = createHttpClient({ userAgent: config.userAgent });

// --- Adaptadores de salida -------------------------------------------------
const cacheDir = new URL('cache/', config.dataDir);
const cache = createFileCache({ http, dir: cacheDir, log });
const nap = createNapClient({ cache, apiKey: config.env.NAP_API_KEY });
const stations = assertPort('StationCatalog', createRenfeStationCatalog({ cache, cacheDir, log }), PORT_MEMBERS.StationCatalog);
const network = assertPort('NetworkCatalog', createGtfsNetworkCatalog({ nap, cacheDir, log }), PORT_MEMBERS.NetworkCatalog);
const situation = assertPort('SituationRepository', createInMemorySituation(), PORT_MEMBERS.SituationRepository);
const history = assertPort('History', createJsonlHistory({ dir: new URL('history/', config.dataDir), log }), PORT_MEMBERS.History);
const bus = assertPort('EventPublisher', createInProcessEventBus(), PORT_MEMBERS.EventPublisher);

const sources = createSources({ http, cache, stations, nap, log, env: config.env })
  .map((s) => assertPort(`DataSource(${s.id})`, s, PORT_MEMBERS.DataSource));

const enabledSources = [];
for (const s of sources) {
  const missing = (s.requires ?? []).filter((k) => !config.env[k]);
  situation.registerSource(s, { enabled: !missing.length, reason: missing.length ? `Falta ${missing.join(', ')} en .env` : null });
  if (missing.length) log.warn(`[${s.id}] desactivada: falta ${missing.join(', ')}`);
  else enabledSources.push(s);
}

// --- Casos de uso ----------------------------------------------------------
const ingestSource = makeIngestSource({ situation, publisher: bus, clock, log });
const detectAlerts = makeDetectAlerts({ situation, stations, history, publisher: bus, clock });
const query = makeQuerySituation({ situation, stations, network });

// --- Adaptadores de entrada ------------------------------------------------
await stations.load();
// Los trazados tardan en construirse la primera vez (~40 MB de GTFS): no bloquean el arranque.
const loadNetwork = () => network.load().catch((err) => log.warn(`[líneas] ${err.message}`));
loadNetwork();
const refreshStations = setInterval(() => {
  stations.load();
  loadNetwork();
}, 6 * 3600_000);

const scheduler = startPolling({ sources: enabledSources, ingestSource, detectAlerts, log });

const server = createHttpServer({
  query,
  bus,
  log,
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)).replace(/\/$/, ''),
  vendorDirs: { '/vendor/maplibre/': fileURLToPath(new URL('../node_modules/maplibre-gl/dist/', import.meta.url)).replace(/\/$/, '') },
});

server.listen(config.port, config.host, () => {
  log.info(`Radar ES escuchando en http://${config.host}:${config.port} · ${enabledSources.length}/${sources.length} fuentes activas`);
});

function shutdown() {
  log.info('Cerrando…');
  scheduler.stop();
  clearInterval(refreshStations);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
