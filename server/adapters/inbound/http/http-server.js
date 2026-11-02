// Adaptador de entrada HTTP: API REST, teselas y ficheros estáticos. La web consulta el directo
// (/api/live) cada pocos segundos. Sólo habla con casos de uso (query, serveTiles): no conoce los
// puertos de salida ni las fuentes.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

/**
 * @param {{ query: ReturnType<typeof import('../../../application/use-cases/query-situation.js').makeQuerySituation>,
 *           serveTiles?: ReturnType<typeof import('../../../application/use-cases/serve-tiles.js').makeServeTiles>,
 *           log: import('../../../application/ports.js').LoggerPort,
 *           publicDir: string, vendorDirs: Record<string, string>, about?: object, now?: () => number }} deps
 *   now: reloj de los memos y de los presupuestos de cálculo (los tests lo fijan: no pueden depender de
 *   lo rápida que sea la máquina).
 */
export function createHttpServer({ query, serveTiles, log, publicDir, vendorDirs, about = {}, now = Date.now }) {
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
    // Vacíos mientras el servidor los carga al arrancar: entonces no se guardan (ver isEmpty).
    '/api/stations': { fn: () => query.stations(), ttl: 600_000, cache: CATALOG_CACHE, isEmpty: (b) => !b?.length },
    '/api/lines': { fn: () => query.lines(), ttl: 600_000, cache: CATALOG_CACHE, isEmpty: (b) => !b?.features?.length },
    '/api/trails': { fn: (p) => query.trails(trailMinutes(p)), key: trailMinutes, ttl: 15_000, cache: REVALIDATE },
    '/api/snapshot': { fn: () => query.snapshot(), ttl: 5_000, cache: REVALIDATE },
    '/api/vehicles': { fn: (p) => query.vehicles(vehicleFilter(p)), key: (p) => JSON.stringify(vehicleFilter(p)), ttl: 5_000, cache: REVALIDATE },
    '/api/events': { fn: (p) => query.events({ category: idParam(p, 'category') }), key: (p) => idParam(p, 'category') ?? '', ttl: 15_000, cache: REVALIDATE },
    '/api/alerts': { fn: () => ({ active: query.alerts(), resolved: query.resolvedAlerts() }), ttl: 5_000, cache: REVALIDATE },
    '/api/kpis': { fn: () => query.kpis(), ttl: 5_000, cache: REVALIDATE },
    '/api/metrics': { fn: () => query.metrics(), ttl: 5_000, cache: REVALIDATE },
    '/api/about': { fn: () => about, ttl: 60_000, cache: REVALIDATE },
    // De dónde sale cada trazado, con su fecha de actualización (la piden su licencia; la enseñan
    // /legal y la pestaña Fuentes). Aparte de /api/lines, que pesa 1 MB. Mientras falte alguna fecha
    // cuenta como vacía: ni el navegador ni Cloudflare la guardan una hora sin ella.
    '/api/lines/sources': { fn: () => query.lineSources(), ttl: 600_000, cache: CATALOG_CACHE, isEmpty: (b) => !b?.length || b.some((s) => s.updated === null) },
  };
  const memo = createJsonMemo({ now });
  // Las rutas con parámetros tienen memo y presupuesto propios: quien pide variantes sin fin no
  // expulsa del memo a /api/lines ni a /api/live, y no puede forzar más de unos pocos cálculos
  // por segundo (sin esto, /api/vehicles?minDelay=<cada vez otro> costaba ~36 ms de CPU por
  // petición: un núcleo saturado con 28 peticiones por segundo).
  const memoParams = createJsonMemo({ max: 100, now });
  const budgets = new Map(Object.keys(routes).filter((path) => routes[path].key).map((path) => [path, createBudget({ now })]));
  // Recorrido y lo que le queda de cada vehículo (/api/tracks/<id>, /api/ahead/<id>). Cada uno puede
  // costar un cálculo por la vía o por las paradas, y hay cientos de vehículos: memo propio, que guarda
  // todos los que se miran a la vez, y un presupuesto que sólo se gasta al calcular. Quien pide otra vez
  // el mismo vehículo antes de TRAIN_TTL_MS recibe la copia, sin gastar nada.
  const memoTrains = createJsonMemo({ max: TRAIN_MEMO_MAX, now });
  const trainBudget = createBudget({ perSecond: TRAIN_BUDGET.perSecond, burst: TRAIN_BUDGET.burst, now });

  const security = Object.entries(securityHeaders(about));
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
      // `return await`: sin el await, un fallo de las funciones asíncronas se saltaría este try y,
      // sin nadie que lo recoja, Node cerraría el proceso entero.
      if (url.pathname.startsWith('/tiles/')) return await sendTile(res, url.pathname);
      if (url.pathname === '/api/burnt-areas') return await sendBurntAreas(res, url.searchParams.get('bbox'));
      // Ficha completa de una estación: una búsqueda en memoria, sin cálculo que acotar.
      if (url.pathname.startsWith('/api/stations/')) {
        // Renfe: 5 cifras. Otras redes: la red y el código de su GTFS («fgc:PC», «tmb:P.6660111»).
        const code = decodeOrNull(url.pathname.slice('/api/stations/'.length));
        const station = code && (/^\d{5}$/.test(code) || /^[a-z]+:[\w.:-]{1,64}$/.test(code)) ? query.station(code) : null;
        return station ? sendJson(req, res, 200, station, CATALOG_CACHE) : send(res, 404, { error: 'Estación no encontrada' });
      }
      if (url.pathname.startsWith('/api/ahead/')) {
        const id = decodeOrNull(url.pathname.slice('/api/ahead/'.length));
        if (id === null) return send(res, 400, { error: 'Ruta inválida' });
        return sendTrain(req, res, `ahead:${id}`, () => query.ahead(id) ?? null, 'Sin recorrido previsto');
      }
      if (url.pathname.startsWith('/api/tracks/')) {
        const id = decodeOrNull(url.pathname.slice('/api/tracks/'.length));
        if (id === null) return send(res, 400, { error: 'Ruta inválida' });
        return sendTrain(req, res, `track:${id}`, () => query.track(id) ?? null, 'Vehículo sin historial');
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Ruta no encontrada' });

      for (const [prefix, dir] of Object.entries(vendorDirs)) {
        if (url.pathname.startsWith(prefix)) return await serveFile(req, res, dir, url.pathname.slice(prefix.length), VENDOR_CACHE);
      }
      // Páginas con URL limpia y una sola dirección por página: /legal sirve legal.html, y /legal.html,
      // /legal/ e /index.html redirigen a /legal y a /.
      const clean = cleanPagePath(url.pathname);
      if (clean !== url.pathname) return redirect(res, `${clean}${url.search}`);
      const isPage = !extname(url.pathname);
      // /404 no es una página propia: sirve la de error con su estado 404.
      const file = url.pathname === '/' ? 'index.html' : isPage && url.pathname !== '/404' ? `${url.pathname}.html` : url.pathname;
      return await serveFile(req, res, publicDir, file, OWN_CACHE, isPage ? join(publicDir, '404.html') : null);
    } catch (err) {
      log.error(`[http] ${err.stack ?? err.message}`);
      if (!res.headersSent) send(res, 500, { error: 'Error interno' });
      else res.end();
    }
  });

  function sendRoute(req, res, path, params) {
    const route = routes[path];
    let entry;
    if (!route.key) entry = memo(path, route.ttl, () => route.fn(params), route);
    else {
      const compute = () => {
        if (!budgets.get(path).take()) throw new Busy();
        return route.fn(params);
      };
      try {
        entry = memoParams(`${path}?${route.key(params)}`, route.ttl, compute, route);
      } catch (err) {
        if (!(err instanceof Busy)) throw err;
        res.setHeader('Retry-After', '2');
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 503, { error: 'Demasiadas consultas distintas a la vez; prueba dentro de un momento' });
      }
    }
    const { json, gz, etag, empty } = entry;
    // Un catálogo vacío (aún cargando) no lo guardan ni el navegador ni Cloudflare: si no, quien
    // entrase en los primeros segundos tras una subida dejaría a todos sin líneas durante una hora.
    const cache = empty ? 'no-store' : route.cache;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    res.writeHead(200, { ...headers, ...(zipped && { 'Content-Encoding': 'gzip' }), 'Content-Length': (zipped ? gz : json).length });
    res.end(req.method === 'HEAD' ? undefined : zipped ? gz : json);
  }

  /**
   * Recorrido o lo que le queda de un vehículo, desde su memo (ver memoTrains). Si hay que calcularlo y
   * se ha gastado el presupuesto, 503 con Retry-After: el mapa vuelve a pedirlo solo. Sin datos, 404.
   */
  function sendTrain(req, res, key, compute, missing) {
    let entry;
    try {
      entry = memoTrains(key, TRAIN_TTL_MS, () => {
        if (!trainBudget.take()) throw new Busy();
        const body = compute();
        // Un id que no es de ningún vehículo no cuesta nada: pedir ids inventados no gasta el presupuesto.
        if (body === null) trainBudget.refund();
        return body;
      }, { isEmpty: (body) => body === null });
    } catch (err) {
      if (!(err instanceof Busy)) throw err;
      res.setHeader('Retry-After', '2');
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 503, { error: 'Demasiados recorridos a la vez; prueba dentro de un momento' });
    }
    if (entry.empty) return send(res, 404, { error: missing });
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': TRAIN_CACHE, ETag: entry.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === entry.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    const zipped = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    res.writeHead(200, { ...headers, ...(zipped && { 'Content-Encoding': 'gzip' }), 'Content-Length': (zipped ? entry.gz : entry.json).length });
    res.end(req.method === 'HEAD' ? undefined : zipped ? entry.gz : entry.json);
  }

  /** /tiles/<capa>/<z>/<x>/<y>.png → tesela de IGN o EFFIS (con copia en disco). */
  async function sendTile(res, path) {
    const m = /^\/tiles\/([a-z-]+)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.png$/.exec(path);
    // El caso de uso decide qué teselas se sirven (sólo España y hasta el zoom de cada capa).
    const tile = m && serveTiles ? await serveTiles.tile(m[1], +m[2], +m[3], +m[4]) : null;
    if (!tile) return send(res, 404, { error: 'Tesela no válida' });
    if (!tile.png) {
      res.setHeader('Cache-Control', 'no-store'); // Cloudflare puede seguir sirviendo su copia (stale-if-error)
      return send(res, 502, { error: 'Servicio de teselas no disponible' });
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': tile.png.length, 'Cache-Control': tile.cacheControl });
    res.end(tile.png);
  }

  // Cada caja de áreas quemadas que no está en la caché de Cloudflare es una consulta a EFFIS: como
  // mucho unas pocas por segundo, para no cargarles y que una ráfaga no deje esperando a las demás.
  const burntBudget = createBudget({ perSecond: 2, burst: 10, now });

  /** Áreas quemadas en una caja lon/lat pequeña (lo que hay bajo un clic en el mapa). */
  async function sendBurntAreas(res, bboxParam) {
    if (!burntBudget.take()) {
      res.setHeader('Retry-After', '5');
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 429, { error: 'Demasiadas consultas de áreas quemadas; prueba en unos segundos' });
    }
    let geojson;
    try {
      geojson = serveTiles ? await serveTiles.burntAreas((bboxParam ?? '').split(',').map(Number)) : null;
    } catch {
      return send(res, 502, { error: 'EFFIS no responde' });
    }
    if (!geojson) return send(res, 400, { error: 'Caja no válida' });
    res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=1800');
    return send(res, 200, geojson);
  }

  return server;
}

const REVALIDATE = 'no-cache'; // el navegador guarda la copia y pregunta con el ETag (304 si no cambió)
// Recorrido y lo que le queda de un vehículo: cambian con cada posición (cada 20-30 s). Se reutilizan
// unos segundos en el servidor, en Cloudflare y en el navegador, para que muchos mirando el mismo tren
// no cuesten más que uno.
const TRAIN_TTL_MS = 10_000;
const TRAIN_CACHE = 'public, max-age=5, s-maxage=15';
const TRAIN_MEMO_MAX = 2_000; // más que todos los vehículos que puede haber a la vez con recorrido
const TRAIN_BUDGET = { perSecond: 4, burst: 20 };
const CATALOG_CACHE = 'public, max-age=600, s-maxage=3600';
/** Directo: Cloudflare lo guarda `edge` s y, si el servidor no responde, sirve la última copia 15 min. */
const liveCache = (edge) => `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 3}, stale-if-error=900`;
/** Minutos de estela pedidos (1-45; 15 por defecto). Entero, para que no haya infinitas variantes. */
const trailMinutes = (p) => Math.max(1, Math.min(Math.round(Number(p.get('min'))) || 15, 45));
/**
 * Filtros de /api/vehicles y /api/events, acotados para que no haya infinitas variantes caras:
 * el retraso mínimo, entero entre -1 (todos) y 1440 minutos; los identificadores (tipo, fuente,
 * categoría), con la forma de los nuestros. Uno con otra forma no coincidiría con nada: se cambia
 * por «-», que tampoco, y así todos los raros comparten variante.
 */
export const vehicleFilter = (p) => ({
  mode: idParam(p, 'mode'),
  source: idParam(p, 'source'),
  minDelay: p.has('minDelay') && Number.isFinite(Number(p.get('minDelay')))
    ? Math.max(-1, Math.min(Math.round(Number(p.get('minDelay'))), 1440)) : undefined,
});
const idParam = (p, name) => {
  const value = p.get(name);
  if (value === null || value === '') return undefined;
  return /^[a-z0-9-]{1,40}$/.test(value) ? value : '-';
};

/** Lo lanza el cálculo de una variante nueva cuando se ha gastado el presupuesto: 503. */
class Busy extends Error {}

/**
 * Presupuesto de cálculos (cubo de fichas): `perSecond` de media y ráfagas de hasta `burst`.
 * `take()` gasta una ficha y dice si había; `refund()` devuelve la última si al final no hubo cálculo.
 */
export function createBudget({ perSecond = 5, burst = 10, now = Date.now } = {}) {
  let tokens = burst;
  let last = now();
  return {
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
      last = t;
      if (tokens < 1) return false;
      tokens--;
      return true;
    },
    refund() {
      tokens = Math.min(burst, tokens + 1);
    },
  };
}

/**
 * Memo de respuestas JSON ya serializadas, comprimidas y firmadas: `get(clave, ttl, calcular)`
 * sólo vuelve a calcular cuando la copia tiene más de `ttl` ms. Como quien llama elige los
 * parámetros (y con ellos las claves), guarda como mucho `max` variantes: al pasar del tope se
 * descarta la más antigua. Con `stableEtag`, la firma no cuenta el campo `generatedAt`.
 */
export function createJsonMemo({ max = 200, now = Date.now, emptyTtl = 2_000 } = {}) {
  const entries = new Map();
  return function get(key, ttl, compute, { stableEtag = false, isEmpty } = {}) {
    const hit = entries.get(key);
    if (hit && now() - hit.at < (hit.empty ? emptyTtl : ttl)) return hit;
    const body = compute();
    const json = Buffer.from(JSON.stringify(body));
    const signed = stableEtag && body?.generatedAt !== undefined ? JSON.stringify({ ...body, generatedAt: undefined }) : json;
    const entry = {
      at: now(), json, gz: gzipSync(json), etag: `"${createHash('sha1').update(signed).digest('base64url').slice(0, 20)}"`,
      empty: Boolean(isEmpty?.(body)),
    };
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

/** decodeURIComponent sin excepciones: null si la ruta trae un %-escape roto (p. ej. «%E0%A4%A»). */
function decodeOrNull(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendJson(req, res, status, body, cache = 'no-store') {
  const json = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache };
  if (json.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(gzipSync(json));
  }
  res.writeHead(status, headers);
  res.end(json);
}

/**
 * Cabeceras de seguridad de todas las respuestas. La CSP enumera lo único que la página carga de
 * fuera: teselas y fuentes de OpenFreeMap (las de IGN y EFFIS ya salen de /tiles), las fotos de las
 * estaciones (Wikimedia Commons) y, si está configurado, el contador de GoatCounter. Ningún script en línea; los estilos en línea sí (la leyenda los usa).
 * Sin upgrade-insecure-requests para no romper el servidor local por http.
 * @param {{ goatcounter?: string | null }} about
 */
export function securityHeaders({ goatcounter } = {}) {
  const counter = goatcounter ? ` ${new URL(goatcounter).origin}` : '';
  const csp = [
    "default-src 'self'",
    `script-src 'self'${goatcounter ? ' https://gc.zgo.at' : ''}`,
    "style-src 'self' 'unsafe-inline'",
    // Las fotos de las estaciones vienen de Wikimedia Commons, con su autor y licencia al lado.
    `img-src 'self' data: blob: https://upload.wikimedia.org https://thumb.wikimedia.org${counter}`,
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

/**
 * Envía un fichero ya anunciado en las cabeceras. Con `.pipe()`, un error al leerlo (fichero que
 * desaparece, sin permiso, demasiados abiertos) no lo recogía nadie y cerraba el proceso; así
 * sólo se corta esa respuesta.
 */
function sendStream(res, file) {
  pipeline(createReadStream(file), res, (err) => {
    if (err && !res.destroyed) res.destroy(err);
  });
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
    sendStream(res, file);
  } catch {
    if (!notFoundPage) return send(res, 404, { error: 'No encontrado' });
    try {
      const info = await stat(notFoundPage);
      res.writeHead(404, { 'Content-Type': MIME['.html'], 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
      sendStream(res, notFoundPage);
    } catch {
      send(res, 404, { error: 'No encontrado' });
    }
  }
}
