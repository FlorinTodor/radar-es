// Adaptador de entrada HTTP: API REST, stream SSE en tiempo real y ficheros estáticos.
// Sólo habla con los casos de uso (query) y el bus de eventos; no conoce las fuentes.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createConnectionLimiter } from './connection-limiter.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2',
};

const SSE_HEARTBEAT_MS = 25_000;
// El estado de las fuentes (decenas, con sus licencias) cambia con cada lectura: se agrupa y se envía
// como mucho cada 15 s por conexión, en vez de en cada actualización.
const SSE_HEALTH_EVERY_MS = 15_000;

/**
 * @param {{ query: ReturnType<typeof import('../../../application/use-cases/query-situation.js').makeQuerySituation>,
 *           bus: import('../../../application/ports.js').EventPublisherPort, log: import('../../../application/ports.js').LoggerPort,
 *           publicDir: string, vendorDirs: Record<string, string>, about?: object,
 *           tiles?: import('../../../application/ports.js').TileProviderPort }} deps
 */
export function createHttpServer({ query, bus, log, publicDir, vendorDirs, about = {}, tiles }) {
  const routes = {
    '/api/snapshot': () => query.snapshot(),
    '/api/vehicles': (p) => query.vehicles({
      mode: p.get('mode') ?? undefined,
      source: p.get('source') ?? undefined,
      minDelay: p.has('minDelay') ? Number(p.get('minDelay')) : undefined,
    }),
    '/api/events': (p) => query.events({ category: p.get('category') ?? undefined }),
    '/api/alerts': () => ({ active: query.alerts(), resolved: query.resolvedAlerts() }),
    '/api/kpis': () => query.kpis(),
    '/api/metrics': () => query.metrics(),
    '/api/stations': () => query.stations(),
    '/api/lines': () => query.lines(),
    '/api/trails': (p) => query.trails(Math.min(Number(p.get('min')) || 15, 45)),
    '/api/about': () => about,
  };

  // Directo: JSON iguales para todo el mundo, que Cloudflare guarda `edge` segundos (regla de caché
  // en /api/live* y /api/health). Aquí se calculan y comprimen una vez cada `ttl`, así que el
  // servidor trabaja lo mismo con 100 personas que con 100.000. Si el servidor cae, Cloudflare
  // sigue sirviendo la última copia hasta 15 min (stale-if-error) y el navegador avisa de su edad.
  const live = {
    '/api/live': { fn: () => query.live(), ttl: 5_000, edge: 10 },
    '/api/live/events': { fn: () => query.liveEvents(), ttl: 15_000, edge: 30 },
    '/api/live/buses': { fn: () => query.liveBuses(), ttl: 8_000, edge: 15 },
    '/api/health': { fn: () => query.health(), ttl: 15_000, edge: 30 },
  };
  const memo = new Map();
  const liveBody = (path) => {
    const hit = memo.get(path);
    if (hit && Date.now() - hit.at < live[path].ttl) return hit;
    const json = Buffer.from(JSON.stringify(live[path].fn()));
    const body = { at: Date.now(), json, gz: gzipSync(json), etag: `"${createHash('sha1').update(json).digest('base64url').slice(0, 20)}"` };
    memo.set(path, body);
    return body;
  };

  const security = Object.entries(securityHeaders(about));
  const streams = createConnectionLimiter();
  const server = createServer(async (req, res) => {
    for (const [name, value] of security) res.setHeader(name, value);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método no permitido' });

      if (live[url.pathname]) return sendLive(req, res, url.pathname);
      if (url.pathname.startsWith('/tiles/')) return sendTile(res, url.pathname);
      if (url.pathname === '/api/burnt-areas') return sendBurntAreas(res, url.searchParams.get('bbox'));
      // El directo antiguo (SSE) se mantiene para las pestañas que se abrieron antes del cambio.
      if (url.pathname === '/api/stream') return stream(req, res, url.searchParams.get('buses') === '1');
      if (routes[url.pathname]) return sendJson(req, res, 200, routes[url.pathname](url.searchParams));
      if (url.pathname.startsWith('/api/tracks/')) {
        const track = query.track(decodeURIComponent(url.pathname.slice('/api/tracks/'.length)));
        return track ? sendJson(req, res, 200, track) : send(res, 404, { error: 'Vehículo sin historial' });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Ruta no encontrada' });

      for (const [prefix, dir] of Object.entries(vendorDirs)) {
        if (url.pathname.startsWith(prefix)) return serveFile(req, res, dir, url.pathname.slice(prefix.length), VENDOR_CACHE);
      }
      return serveFile(req, res, publicDir, url.pathname === '/' ? 'index.html' : url.pathname, OWN_CACHE);
    } catch (err) {
      log.error(`[http] ${err.stack ?? err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Error interno' });
      else res.end();
    }
  });

  function sendLive(req, res, path) {
    const { json, gz, etag } = liveBody(path);
    const { edge } = live[path];
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 3}, stale-if-error=900`,
      ETag: etag,
      Vary: 'Accept-Encoding',
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    res.writeHead(200, { ...headers, ...(zipped && { 'Content-Encoding': 'gzip' }), 'Content-Length': (zipped ? gz : json).length });
    res.end(req.method === 'HEAD' ? undefined : zipped ? gz : json);
  }

  /** /tiles/<capa>/<z>/<x>/<y>.png → tesela de IGN o EFFIS (con copia en disco). */
  async function sendTile(res, path) {
    const m = /^\/tiles\/([a-z-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(path);
    const [layer, z, x, y] = m ? [m[1], +m[2], +m[3], +m[4]] : [];
    if (!m || !tiles?.layers.includes(layer) || z > 19 || x >= 2 ** z || y >= 2 ** z) return send(res, 404, { error: 'Tesela no válida' });
    const png = await tiles.tile(layer, z, x, y);
    if (!png) {
      res.setHeader('Cache-Control', 'no-store'); // Cloudflare puede seguir sirviendo su copia (stale-if-error)
      return send(res, 502, { error: 'Servicio de teselas no disponible' });
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': tiles.cacheControl(layer) });
    res.end(png);
  }

  /** Áreas quemadas en una caja lon/lat pequeña (lo que hay bajo un clic en el mapa). */
  async function sendBurntAreas(res, bboxParam) {
    const bbox = (bboxParam ?? '').split(',').map(Number);
    const valid = bbox.length === 4 && bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1]
      && bbox[2] - bbox[0] < 0.5 && bbox[3] - bbox[1] < 0.5;
    if (!valid || !tiles) return send(res, 400, { error: 'Caja no válida' });
    try {
      const geojson = await tiles.burntAreas(bbox);
      res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=1800');
      return send(res, 200, geojson);
    } catch {
      return send(res, 502, { error: 'EFFIS no responde' });
    }
  }

  /** @param {boolean} buses  El cliente tiene activada la capa de autobuses. */
  function stream(req, res, buses) {
    // Detrás del túnel todas las conexiones vienen de cloudflared (127.0.0.1); la IP real la pone
    // Cloudflare. Es fiable porque el puerto sólo escucha en local y no se puede llegar saltándose el túnel.
    const release = streams.acquire(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress);
    if (!release) {
      res.setHeader('Retry-After', '30');
      return send(res, 429, { error: 'Demasiadas conexiones en directo; prueba dentro de un momento' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit('snapshot', query.snapshot({ buses }));

    let healthTimer = null;
    const emitHealthSoon = () => {
      healthTimer ??= setTimeout(() => {
        healthTimer = null;
        emit('health', query.health());
      }, SSE_HEALTH_EVERY_MS);
    };
    const unsubscribe = [
      bus.subscribe('source.updated', ({ id }) => {
        const payload = query.sourcePayload(id, { buses });
        if (payload) emit('source', payload);
        emitHealthSoon();
      }),
      bus.subscribe('source.failed', emitHealthSoon),
      bus.subscribe('alerts.updated', ({ alerts, kpis }) => emit('alerts', { alerts, kpis, resolved: query.resolvedAlerts().slice(0, 30) })),
    ];
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(healthTimer);
      unsubscribe.forEach((off) => off());
      release();
    });
  }

  return server;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendJson(req, res, status, body) {
  const json = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (json.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(gzipSync(json));
  }
  res.writeHead(status, headers);
  res.end(json);
}

/**
 * Cabeceras de seguridad de todas las respuestas. La CSP enumera lo único que la página carga de
 * fuera: teselas y fuentes de OpenFreeMap (las de IGN y EFFIS ya salen de /tiles) y, si está configurado, el
 * contador de GoatCounter. Ningún script en línea; los estilos en línea sí (la leyenda los usa).
 * Sin upgrade-insecure-requests para no romper el servidor local por http.
 * @param {{ goatcounter?: string | null }} about
 */
export function securityHeaders({ goatcounter } = {}) {
  const counter = goatcounter ? ` ${new URL(goatcounter).origin}` : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${goatcounter ? ' https://gc.zgo.at' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${counter}`,
    `connect-src 'self' https://tiles.openfreemap.org${counter}`,
    "worker-src 'self' blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'Strict-Transport-Security': 'max-age=15552000; includeSubDomains', // 180 días; los navegadores la ignoran por http
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

// Nuestros ficheros cambian con cada despliegue: el navegador debe preguntar siempre, y el ETag
// hace que la respuesta sea un 304 vacío si no han cambiado. Las librerías (MapLibre, ~1 MB)
// sólo cambian al actualizarlas, así que pueden guardarse un día.
const OWN_CACHE = 'no-cache';
const VENDOR_CACHE = 'public, max-age=86400';

/** ETag débil a partir de tamaño y fecha: cambia en cuanto el fichero cambia. */
export function fileEtag(info) {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

async function serveFile(req, res, root, pathname, cacheControl) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return send(res, 400, { error: 'Ruta inválida' });
  }
  const file = resolve(root, rel);
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'Prohibido' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('no es un fichero');
    const etag = fileEtag(info);
    const headers = { 'Cache-Control': cacheControl, ETag: etag, 'Last-Modified': info.mtime.toUTCString() };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, { error: 'No encontrado' });
  }
}
