// Adaptador de entrada HTTP: API REST, stream SSE en tiempo real y ficheros estáticos.
// Sólo habla con los casos de uso (query) y el bus de eventos; no conoce las fuentes.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createConnectionLimiter } from './connection-limiter.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.webp': 'image/webp',
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
  // Todas las respuestas JSON se calculan, comprimen y firman (ETag) como mucho una vez cada `ttl`,
  // así que pedirlas mil veces cuesta lo mismo que pedirlas una. Sin esto, /api/lines (1 MB)
  // saturaba un núcleo con unas 20 peticiones por segundo. `key` separa las variantes por parámetros.
  // - Directo (/api/live*, /api/health): iguales para todo el mundo; Cloudflare los guarda unos
  //   segundos (regla de caché) y, si el servidor cae, sirve la última copia hasta 15 min
  //   (stale-if-error). El navegador avisa de su antigüedad con el `generatedAt` de /api/live.
  // - `stableEtag`: la firma no cuenta `generatedAt`, para que el navegador reciba un 304 vacío si
  //   las incidencias, los autobuses o el estado no han cambiado. /api/live no la usa: su
  //   `generatedAt` es justo lo que dice si el servidor se está actualizando.
  const routes = {
    '/api/live': { fn: () => query.live(), ttl: 5_000, cache: liveCache(10) },
    '/api/live/events': { fn: () => query.liveEvents(), ttl: 15_000, cache: liveCache(30), stableEtag: true },
    '/api/live/buses': { fn: () => query.liveBuses(), ttl: 8_000, cache: liveCache(15), stableEtag: true },
    '/api/health': { fn: () => query.health(), ttl: 15_000, cache: liveCache(30), stableEtag: true },
    // Catálogos: cambian unas pocas veces al día.
    '/api/stations': { fn: () => query.stations(), ttl: 600_000, cache: CATALOG_CACHE },
    '/api/lines': { fn: () => query.lines(), ttl: 600_000, cache: CATALOG_CACHE },
    '/api/trails': { fn: (p) => query.trails(trailMinutes(p)), key: trailMinutes, ttl: 15_000, cache: REVALIDATE },
    '/api/snapshot': { fn: () => query.snapshot(), ttl: 5_000, cache: REVALIDATE },
    '/api/vehicles': { fn: (p) => query.vehicles(vehicleFilter(p)), key: (p) => JSON.stringify(vehicleFilter(p)), ttl: 5_000, cache: REVALIDATE },
    '/api/events': { fn: (p) => query.events({ category: p.get('category') ?? undefined }), key: (p) => p.get('category') ?? '', ttl: 15_000, cache: REVALIDATE },
    '/api/alerts': { fn: () => ({ active: query.alerts(), resolved: query.resolvedAlerts() }), ttl: 5_000, cache: REVALIDATE },
    '/api/kpis': { fn: () => query.kpis(), ttl: 5_000, cache: REVALIDATE },
    '/api/metrics': { fn: () => query.metrics(), ttl: 5_000, cache: REVALIDATE },
    '/api/about': { fn: () => about, ttl: 60_000, cache: REVALIDATE },
  };
  const memo = createJsonMemo();

  const security = Object.entries(securityHeaders(about));
  const streams = createConnectionLimiter();
  // Dominio canónico (PUBLIC_URL): www.<dominio> redirige a él para que los buscadores no vean dos
  // webs iguales. Sólo esa variante: localhost, la IP y el chequeo de salud siguen igual.
  const canonical = about.publicUrl ? new URL(about.publicUrl) : null;
  const server = createServer(async (req, res) => {
    for (const [name, value] of security) res.setHeader(name, value);
    try {
      const url = new URL(req.url, 'http://localhost');
      if (canonical && req.headers.host?.toLowerCase() === `www.${canonical.host}`) {
        return redirect(res, `${canonical.origin}${url.pathname}${url.search}`);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Método no permitido' });
      // La API y las teselas no son páginas: fuera de los resultados de búsqueda.
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/tiles/')) res.setHeader('X-Robots-Tag', 'noindex');

      if (routes[url.pathname]) return sendRoute(req, res, url.pathname, url.searchParams);
      if (url.pathname.startsWith('/tiles/')) return sendTile(res, url.pathname);
      if (url.pathname === '/api/burnt-areas') return sendBurntAreas(res, url.searchParams.get('bbox'));
      // El directo antiguo (SSE) se mantiene para las pestañas que se abrieron antes del cambio.
      if (url.pathname === '/api/stream') return stream(req, res, url.searchParams.get('buses') === '1');
      if (url.pathname.startsWith('/api/tracks/')) {
        const track = query.track(decodeURIComponent(url.pathname.slice('/api/tracks/'.length)));
        return track ? sendJson(req, res, 200, track) : send(res, 404, { error: 'Vehículo sin historial' });
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Ruta no encontrada' });

      for (const [prefix, dir] of Object.entries(vendorDirs)) {
        if (url.pathname.startsWith(prefix)) return serveFile(req, res, dir, url.pathname.slice(prefix.length), VENDOR_CACHE);
      }
      // Páginas con URL limpia y una sola dirección por página: /legal sirve legal.html, y /legal.html,
      // /legal/ e /index.html redirigen a /legal y a /.
      const clean = cleanPagePath(url.pathname);
      if (clean !== url.pathname) return redirect(res, `${clean}${url.search}`);
      const isPage = !extname(url.pathname);
      // /404 no es una página propia: sirve la de error con su estado 404.
      const file = url.pathname === '/' ? 'index.html' : isPage && url.pathname !== '/404' ? `${url.pathname}.html` : url.pathname;
      return serveFile(req, res, publicDir, file, OWN_CACHE, isPage ? join(publicDir, '404.html') : null);
    } catch (err) {
      log.error(`[http] ${err.stack ?? err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Error interno' });
      else res.end();
    }
  });

  function sendRoute(req, res, path, params) {
    const route = routes[path];
    const key = route.key ? `${path}?${route.key(params)}` : path;
    const { json, gz, etag } = memo(key, route.ttl, () => route.fn(params), route);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': route.cache, ETag: etag, Vary: 'Accept-Encoding' };
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

const REVALIDATE = 'no-cache'; // el navegador guarda la copia y pregunta con el ETag (304 si no cambió)
const CATALOG_CACHE = 'public, max-age=600, s-maxage=3600';
/** Directo: Cloudflare lo guarda `edge` s y, si el servidor no responde, sirve la última copia 15 min. */
const liveCache = (edge) => `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 3}, stale-if-error=900`;
/** Minutos de estela pedidos (1-45; 15 por defecto). Entero, para que no haya infinitas variantes. */
const trailMinutes = (p) => Math.max(1, Math.min(Math.round(Number(p.get('min'))) || 15, 45));
const vehicleFilter = (p) => ({
  mode: p.get('mode') ?? undefined,
  source: p.get('source') ?? undefined,
  minDelay: p.has('minDelay') ? Number(p.get('minDelay')) : undefined,
});

/**
 * Memo de respuestas JSON ya serializadas, comprimidas y firmadas: `get(clave, ttl, calcular)`
 * sólo vuelve a calcular cuando la copia tiene más de `ttl` ms. Como quien llama elige los
 * parámetros (y con ellos las claves), guarda como mucho `max` variantes: al pasar del tope se
 * descarta la más antigua. Con `stableEtag`, la firma no cuenta el campo `generatedAt`.
 */
export function createJsonMemo({ max = 200, now = Date.now } = {}) {
  const entries = new Map();
  return function get(key, ttl, compute, { stableEtag = false } = {}) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < ttl) return hit;
    const body = compute();
    const json = Buffer.from(JSON.stringify(body));
    const signed = stableEtag && body?.generatedAt !== undefined ? JSON.stringify({ ...body, generatedAt: undefined }) : json;
    const entry = { at: now(), json, gz: gzipSync(json), etag: `"${createHash('sha1').update(signed).digest('base64url').slice(0, 20)}"` };
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > max) entries.delete(entries.keys().next().value);
    return entry;
  };
}

/** Redirección permanente (301). Se guarda un día: la dirección canónica no cambia. */
function redirect(res, location) {
  res.writeHead(301, { Location: location, 'Cache-Control': 'public, max-age=86400' });
  res.end();
}

/**
 * Dirección única de cada página: sin ".html", sin barra final e /index.html → /.
 * Los ficheros con otra extensión (CSS, JS, imágenes, robots.txt…) no se tocan.
 * Las barras repetidas se juntan: así la redirección nunca puede empezar por "//" (otra web).
 * @param {string} pathname
 */
export function cleanPagePath(pathname) {
  let path = pathname.replace(/\/{2,}/g, '/');
  const trim = () => { if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1); };
  trim();
  if (path.endsWith('.html')) path = path.slice(0, -'.html'.length);
  trim(); // «/foo/.html» → «/foo/» → «/foo», en una sola redirección
  if (path === '/index' || path === '') path = '/';
  return path;
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

/** @param {string|null} [notFoundPage]  Página HTML que se sirve con 404 si el fichero no existe. */
async function serveFile(req, res, root, pathname, cacheControl, notFoundPage = null) {
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
    if (!notFoundPage) return send(res, 404, { error: 'No encontrado' });
    try {
      const info = await stat(notFoundPage);
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      createReadStream(notFoundPage).pipe(res);
    } catch {
      send(res, 404, { error: 'No encontrado' });
    }
  }
}
