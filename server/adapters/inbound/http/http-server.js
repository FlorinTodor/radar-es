// Adaptador de entrada HTTP: API REST, teselas y ficheros estáticos. La web consulta el directo
// (/api/live) cada pocos segundos. Sólo habla con casos de uso (query, serveTiles) y, para saber si
// lo que se pide tiene sentido, con las reglas puras del dominio: no conoce los puertos de salida ni las fuentes.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { extname, join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { isStationCode } from '../../../domain/model.js';
import { followKind } from '../../../domain/seguir.js';
import { McpBusy, PROTOCOL_VERSIONS, RPC, idOf, isModernVersion, versionOf } from '../mcp/mcp.js';

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
 *           publicDir: string, vendorDirs: Record<string, string>, about?: object, now?: () => number,
 *           mcp?: ReturnType<typeof import('../mcp/mcp.js').createMcpHandler>,
 *           metrics?: Pick<import('../../../application/ports.js').MetricsPort, 'request'|'mcp'> }} deps
 *   now: reloj de los memos y de los presupuestos de cálculo (los tests lo fijan: no pueden depender de
 *   lo rápida que sea la máquina).
 *   mcp: quien atiende los mensajes del servidor MCP en POST /mcp; sin él, /mcp no existe.
 *   metrics: cuenta cada petición (por ruta, sin parámetros) y cada mensaje MCP, para la monitorización.
 */
export function createHttpServer({ query, serveTiles, log, publicDir, vendorDirs, about = {}, now = Date.now, mcp, metrics = NO_METRICS }) {
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
    // Los tipos de vehículo (domain/modos.js): cambian sólo con un despliegue.
    '/api/modes': { fn: () => query.modes(), ttl: 600_000, cache: CATALOG_CACHE },
    // Unas líneas provisionales (se están rehaciendo por la vía) se tratan como un catálogo vacío: no se guardan.
    '/api/lines': { fn: () => query.lines(), ttl: 600_000, cache: CATALOG_CACHE, isEmpty: (b) => !b?.features?.length || b.provisional === true },
    // Tres variantes (15, 30 y 45 min): van al memo general, sin presupuesto, como una ruta sin parámetros.
    '/api/trails': { fn: (p) => query.trails(trailMinutes(p)), key: trailMinutes, few: true, ttl: 15_000, cache: REVALIDATE },
    '/api/snapshot': { fn: () => query.snapshot(), ttl: 5_000, cache: REVALIDATE },
    '/api/vehicles': { fn: (p) => query.vehicles(vehicleFilter(p)), key: (p) => JSON.stringify(vehicleFilter(p)), ttl: 5_000, cache: REVALIDATE },
    '/api/events': { fn: (p) => query.events({ category: idParam(p, 'category') }), key: (p) => idParam(p, 'category') ?? '', ttl: 15_000, cache: REVALIDATE },
    '/api/alerts': { fn: () => ({ active: query.alerts(), resolved: query.resolvedAlerts() }), ttl: 5_000, cache: REVALIDATE },
    '/api/kpis': { fn: () => query.kpis(), ttl: 5_000, cache: REVALIDATE },
    '/api/metrics': { fn: () => query.metrics(), ttl: 5_000, cache: REVALIDATE },
    '/api/about': { fn: () => about, ttl: 60_000, cache: REVALIDATE },
    // De dónde sale cada trazado, con su fecha de actualización (la piden su licencia; la enseñan
    // /legal y la pestaña Fuentes). Aparte de /api/lines, que pesa 1 MB. Mientras falte alguna fecha
    // cuenta como vacía: ni el navegador ni Cloudflare la guardan una hora sin ella. Tampoco mientras
    // las líneas sean provisionales: aún no dice qué redes van por la vía del IGN (ni la cita).
    '/api/lines/sources': {
      fn: () => query.lineSources(), ttl: 600_000, cache: CATALOG_CACHE,
      isEmpty: (b) => !b?.length || b.some((s) => s.updated === null) || query.lines?.()?.provisional === true,
    },
  };
  const memo = createJsonMemo({ now });
  // Las rutas con parámetros tienen memo y presupuesto propios: quien pide variantes sin fin no
  // expulsa del memo a /api/lines ni a /api/live, y no puede forzar más de unos pocos cálculos
  // por segundo (sin esto, /api/vehicles?minDelay=<cada vez otro> costaba ~36 ms de CPU por
  // petición: un núcleo saturado con 28 peticiones por segundo).
  // Una variante de /api/vehicles pesa unos 3 MB entre JSON y gzip: con el tope de bytes, por muchas
  // que se pidan nunca ocupan más de PARAMS_MEMO_BYTES (el montón de Node es de unos 500 MB).
  const memoParams = createJsonMemo({ max: 100, maxBytes: PARAMS_MEMO_BYTES, now });
  const budgets = new Map(Object.keys(routes).filter((path) => routes[path].key && !routes[path].few).map((path) => [path, createBudget({ now })]));
  // Recorrido y lo que le queda de cada vehículo (/api/tracks/<id>, /api/ahead/<id>). Cada uno puede
  // costar un cálculo por la vía o por las paradas, y hay cientos de vehículos: memo propio, que guarda
  // todos los que se miran a la vez, y un presupuesto que sólo se gasta al calcular. Quien pide otra vez
  // el mismo vehículo antes de TRAIN_TTL_MS recibe la copia, sin gastar nada.
  const memoTrains = createJsonMemo({ max: TRAIN_MEMO_MAX, maxBytes: TRAIN_MEMO_BYTES, now });
  const trainBudget = createBudget({ perSecond: TRAIN_BUDGET.perSecond, burst: TRAIN_BUDGET.burst, now });
  // Las paradas de cada viaje (/api/stops/<id>) son una búsqueda y una lista corta, no un cálculo por la
  // vía: memo y presupuesto aparte, para que ni gasten el de los recorridos ni echen sus copias del memo.
  const stopsTrains = {
    memo: createJsonMemo({ max: TRAIN_MEMO_MAX, maxBytes: STOPS_MEMO_BYTES, now }),
    budget: createBudget({ perSecond: STOPS_BUDGET.perSecond, burst: STOPS_BUDGET.burst, now }),
  };
  // Cada mensaje MCP es un POST, que Cloudflare no guarda: todos llegan al servidor y algunas
  // herramientas recorren todos los vehículos. Presupuesto propio, para que no le quiten sitio al mapa;
  // sólo lo gasta lo que hay que calcular (el adaptador MCP guarda unos segundos cada respuesta).
  const mcpBudget = createBudget({ perSecond: MCP_BUDGET.perSecond, burst: MCP_BUDGET.burst, now });
  // Y otro por cliente, para que uno solo no gaste el de todos. Se guardan los de los últimos
  // MCP_CLIENTS_MAX clientes: si alguien llena la lista con direcciones nuevas, sigue el de todos.
  const mcpClients = new Map();
  const clientBudget = (ip) => {
    const budget = mcpClients.get(ip) ?? createBudget({ perSecond: MCP_CLIENT_BUDGET.perSecond, burst: MCP_CLIENT_BUDGET.burst, now });
    mcpClients.delete(ip);
    mcpClients.set(ip, budget);
    if (mcpClients.size > MCP_CLIENTS_MAX) mcpClients.delete(mcpClients.keys().next().value);
    return budget;
  };

  const security = Object.entries(securityHeaders(about));
  // El aviso legal lleva el titular y el contacto (de .env) en el propio HTML: la LSSI pide que estén
  // siempre a la vista, también sin JavaScript. Las demás páginas se sirven tal cual.
  const fillAbout = aboutFiller(about);
  // Dominio canónico (PUBLIC_URL): www.<dominio> redirige a él para que los buscadores no vean dos
  // webs iguales. Sólo esa variante: localhost, la IP y el chequeo de salud siguen igual.
  const canonical = about.publicUrl ? new URL(about.publicUrl) : null;
  const vendorPrefixes = Object.keys(vendorDirs ?? {});
  const server = createServer(async (req, res) => {
    for (const [name, value] of security) res.setHeader(name, value);
    // Para la monitorización: ruta (sin lo que se ha pedido), código y tiempo hasta acabar de enviar.
    // Si quien pide se va antes, cuenta como 499, como en nginx.
    const started = performance.now();
    const www = Boolean(canonical) && req.headers.host?.toLowerCase() === `www.${canonical.host}`;
    const route = routeLabel(req.url, { routes, vendorPrefixes, www });
    res.once('close', () => metrics.request({
      route, method: req.method, status: res.writableFinished ? res.statusCode : 499, seconds: (performance.now() - started) / 1000,
    }));
    try {
      const url = new URL(req.url, 'http://localhost');
      if (www) {
        // Un POST (el servidor MCP) con 301 se repetiría como GET: 308 conserva el método y el cuerpo.
        const keepsMethod = req.method !== 'GET' && req.method !== 'HEAD';
        return redirect(res, `${canonical.origin}${url.pathname}${url.search}`, keepsMethod ? 308 : 301);
      }
      // El servidor MCP es lo único que acepta POST.
      if (url.pathname === '/mcp' && mcp) return await sendMcp(req, res);
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
        const code = decodeOrNull(url.pathname.slice('/api/stations/'.length));
        const station = isStationCode(code) ? query.station(code) : null;
        return station ? sendJson(req, res, 200, station, CATALOG_CACHE) : send(res, 404, { error: 'Estación no encontrada' });
      }
      // Puntualidad de un servicio o de una línea (su clave de domain/seguir.js): una búsqueda en memoria,
      // sin cálculo que acotar. Cambia cada minuto.
      if (url.pathname.startsWith('/api/puntualidad/')) {
        const key = decodeOrNull(url.pathname.slice('/api/puntualidad/'.length));
        const kind = followKind(key);
        if (kind !== 'servicio' && kind !== 'linea') return send(res, 400, { error: 'Clave de servicio o de línea inválida' });
        const report = query.punctuality?.(key) ?? null;
        return report ? sendJson(req, res, 200, report, PUNCTUALITY_CACHE) : send(res, 404, { error: 'Sin datos de puntualidad' });
      }
      if (url.pathname.startsWith('/api/ahead/')) {
        const id = decodeOrNull(url.pathname.slice('/api/ahead/'.length));
        if (id === null || id.length > MAX_VEHICLE_ID) return send(res, 400, { error: 'Ruta inválida' });
        return sendTrain(req, res, `ahead:${id}`, () => query.ahead(id) ?? null, 'Sin recorrido previsto');
      }
      // Paradas del viaje de un vehículo (de dónde viene, por dónde pasa y adónde va).
      if (url.pathname.startsWith('/api/stops/')) {
        const id = decodeOrNull(url.pathname.slice('/api/stops/'.length));
        if (id === null || id.length > MAX_VEHICLE_ID) return send(res, 400, { error: 'Ruta inválida' });
        return sendTrain(req, res, id, () => query.stops?.(id) ?? null, 'Paradas desconocidas', stopsTrains);
      }
      if (url.pathname.startsWith('/api/tracks/')) {
        const id = decodeOrNull(url.pathname.slice('/api/tracks/'.length));
        if (id === null || id.length > MAX_VEHICLE_ID) return send(res, 400, { error: 'Ruta inválida' });
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
      if (file === '/legal.html' && fillAbout) return await serveFilledPage(req, res, join(publicDir, 'legal.html'), fillAbout);
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
    else if (route.few) entry = memo(`${path}?${route.key(params)}`, route.ttl, () => route.fn(params), route);
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
   * Recorrido, lo que le queda o las paradas de un vehículo, desde su memo (ver memoTrains; las paradas,
   * con el suyo). Si hay que calcularlo y se ha gastado el presupuesto, 503 con Retry-After: el mapa
   * vuelve a pedirlo solo. Sin datos, 404.
   */
  function sendTrain(req, res, key, compute, missing, { memo = memoTrains, budget = trainBudget } = {}) {
    let entry;
    try {
      entry = memo(key, TRAIN_TTL_MS, () => {
        if (!budget.take()) throw new Busy();
        const body = compute();
        // Un id que no es de ningún vehículo no cuesta nada: pedir ids inventados no gasta el presupuesto.
        if (body === null) budget.refund();
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

  /**
   * POST /mcp: un mensaje JSON-RPC del protocolo MCP, por HTTP «streamable» sin sesiones ni SSE (el
   * servidor no manda nada por su cuenta, así que GET y DELETE no tienen uso: 405). Una notificación
   * no lleva respuesta: 202 vacío.
   *
   * Como pide el protocolo:
   * - una cabecera Origin que no es la de esta web (ni la de un navegador en local) recibe 403, para
   *   que una web ajena no use el navegador de quien la visita contra el servidor;
   * - en la versión 2026-07-28, las cabeceras MCP-Protocol-Version, Mcp-Method y Mcp-Name tienen que
   *   decir lo mismo que el cuerpo (400 y -32020 si no), y un método que no existe da 404;
   * - una versión que no se conoce da 400 con las que sí (-32022).
   * Cada cliente tiene su presupuesto además del de todos: uno solo no deja sin servicio a los demás.
   */
  async function sendMcp(req, res) {
    res.setHeader('X-Robots-Tag', 'noindex');
    res.setHeader('Cache-Control', 'no-store');
    // Cómo acaba cada mensaje, para la monitorización: método, herramienta y versión, sólo si existen.
    const headerVersion = req.headers['mcp-protocol-version'];
    const counted = (result, message, seconds) => metrics.mcp({
      method: mcpMethodLabel(mcp, message), tool: mcpToolLabel(mcp, message),
      era: isModernVersion(message ? versionOf(message) : headerVersion) ? 'moderna' : 'antigua', result, seconds,
    });
    if (req.method !== 'POST') {
      counted('metodo_http');
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'El servidor MCP sólo acepta POST' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== canonical?.origin && !LOOPBACK_ORIGIN.test(origin)) {
      counted('origen');
      return send(res, 403, rpcFailure(RPC.invalidRequest, 'Origen no permitido'));
    }
    if (headerVersion !== undefined && !PROTOCOL_VERSIONS.includes(headerVersion)) {
      counted('version_no_admitida');
      return send(res, 400, rpcFailure(RPC.unsupportedVersion, 'Versión del protocolo MCP no admitida',
        { supported: PROTOCOL_VERSIONS, requested: headerVersion.slice(0, 40) }));
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      counted('tipo_de_contenido');
      return send(res, 415, rpcFailure(RPC.parse, 'Se espera application/json'));
    }
    // Lo que dice ser grande ni se lee; lo que no lo dice, se corta en cuanto pasa del tope.
    const body = Number(req.headers['content-length']) > MCP_MAX_BODY ? null : await readBody(req, MCP_MAX_BODY);
    if (body === null) {
      counted('demasiado_grande');
      return tooLarge(res);
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      counted('json_no_valido');
      return send(res, 400, rpcFailure(RPC.parse, 'JSON no válido'));
    }
    const mismatch = mcpHeaderMismatch(req.headers, message);
    if (mismatch) {
      counted('cabeceras_distintas', message);
      return send(res, 400, { jsonrpc: '2.0', id: idOf(message), error: { code: RPC.headerMismatch, message: mismatch } });
    }
    let reply;
    const started = performance.now();
    try {
      reply = mcp(message, { budget: bothBudgets(clientBudget(clientAddress(req)), mcpBudget) });
    } catch (err) {
      if (!(err instanceof McpBusy)) throw err;
      counted('ocupado', message);
      res.setHeader('Retry-After', '2');
      return send(res, 429, { jsonrpc: '2.0', id: idOf(message), error: { code: -32000, message: 'Demasiadas consultas a la vez; prueba dentro de un momento' } });
    }
    counted(mcpResultLabel(reply), message, (performance.now() - started) / 1000);
    if (reply === null) {
      res.writeHead(202);
      return res.end();
    }
    return sendJson(req, res, mcpStatus(reply, isModernVersion(versionOf(message))), reply);
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
const TRAIN_MEMO_BYTES = 32 * 1024 * 1024;
const PARAMS_MEMO_BYTES = 48 * 1024 * 1024;
const TRAIN_BUDGET = { perSecond: 4, burst: 20 };
// Paradas: cada una cuesta microsegundos; el tope sólo frena a quien recorra todos los vehículos.
const STOPS_BUDGET = { perSecond: 25, burst: 100 };
const STOPS_MEMO_BYTES = 8 * 1024 * 1024;
// Cálculos de herramientas MCP (las respuestas guardadas no cuentan): un asistente hace una o dos por pregunta.
const MCP_BUDGET = { perSecond: 5, burst: 30 };
// Por cliente: una pregunta a un asistente son una o dos llamadas; unas cuantas seguidas, sin esperar.
const MCP_CLIENT_BUDGET = { perSecond: 1, burst: 10 };
const MCP_CLIENTS_MAX = 10_000;
const MCP_MAX_BODY = 64 * 1024; // los mensajes de un cliente MCP ocupan pocos cientos de bytes
// Métodos cuyo `params.name` (o `params.uri`) va también en la cabecera Mcp-Name (versión 2026-07-28).
const MCP_NAMED = new Set(['tools/call', 'resources/read', 'prompts/get']);
// Un asistente en el navegador de quien lo prueba en local (el inspector de MCP, por ejemplo).
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
// Los ids de vehículo llevan el trip_id de su operador (los más largos, unos 80 caracteres). Más de esto
// no es un vehículo: así nadie llena el memo con claves enormes.
const MAX_VEHICLE_ID = 256;
const CATALOG_CACHE = 'public, max-age=600, s-maxage=3600';
/** Puntualidad de una clave: lo de hoy cambia cada minuto; lo de días anteriores, no. */
const PUNCTUALITY_CACHE = 'public, max-age=60, s-maxage=120';
/** Directo: Cloudflare lo guarda `edge` s y, si el servidor no responde, sirve la última copia 15 min. */
const liveCache = (edge) => `public, max-age=0, s-maxage=${edge}, stale-while-revalidate=${edge * 3}, stale-if-error=900`;
/**
 * Minutos de estela pedidos: 15 (por defecto, lo que pide la web), 30 o 45. Sólo tres variantes: cada
 * una es una estela de todos los trenes, y con un valor por minuto serían 45 copias en memoria.
 */
const trailMinutes = (p) => {
  const min = Math.round(Number(p.get('min')));
  return !(min > 15) ? 15 : min <= 30 ? 30 : 45;
};
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

const NO_METRICS = { request() {}, mcp() {} };

/**
 * Ruta de una petición para las métricas: las de la API, sin lo que se ha pedido
 * (`/api/stations/:code`); lo demás, por tipo (páginas, ficheros, teselas, librerías). Así hay pocas
 * series y ninguna dice qué ha mirado nadie.
 * @param {string} rawUrl  req.url
 * @param {{ routes: Record<string, unknown>, vendorPrefixes?: string[], www?: boolean }} options
 *   www: la petición llega a www.<dominio> y sólo se redirige.
 */
export function routeLabel(rawUrl, { routes, vendorPrefixes = [], www = false }) {
  if (www) return 'www';
  let path;
  try {
    path = new URL(rawUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return 'otra';
  }
  if (path === '/mcp' || Object.hasOwn(routes, path) || path === '/api/burnt-areas') return path;
  if (path.startsWith('/api/')) {
    if (path.startsWith('/api/stations/')) return '/api/stations/:code';
    if (path.startsWith('/api/puntualidad/')) return '/api/puntualidad/:clave';
    for (const p of ['ahead', 'stops', 'tracks']) if (path.startsWith(`/api/${p}/`)) return `/api/${p}/:id`;
    return '/api/otra';
  }
  if (path.startsWith('/tiles/')) return '/tiles';
  if (vendorPrefixes.some((prefix) => path.startsWith(prefix))) return '/vendor';
  return extname(path) ? 'fichero' : 'pagina';
}

// Etiquetas de los mensajes MCP: sólo nombres de métodos y herramientas que existen.
const mcpMethodLabel = (mcp, message) => {
  const method = message?.method;
  if (typeof method !== 'string') return 'ninguno';
  if (method.startsWith('notifications/')) return 'notificacion'; // avisos del cliente, sin respuesta
  return mcp.methodNames?.includes(method) ? method : 'otro';
};
const mcpToolLabel = (mcp, message) => {
  if (message?.method !== 'tools/call') return '';
  const name = message.params?.name;
  return mcp.toolNames?.includes(name) ? name : 'otra';
};
/** Cómo ha acabado un mensaje MCP que ha llegado al adaptador (null: una notificación, sin respuesta). */
function mcpResultLabel(reply) {
  if (reply === null) return 'notificacion';
  const code = reply.error?.code;
  if (code !== undefined) return MCP_ERROR_LABELS.get(code) ?? 'error_rpc';
  return reply.result?.isError ? 'error_herramienta' : 'ok';
}
const MCP_ERROR_LABELS = new Map([
  [RPC.invalidRequest, 'peticion_no_valida'], [RPC.methodNotFound, 'metodo_desconocido'], [RPC.invalidParams, 'parametros_no_validos'],
  [RPC.unsupportedVersion, 'version_no_admitida'], [RPC.headerMismatch, 'cabeceras_distintas'],
]);

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
 * parámetros (y con ellos las claves), guarda como mucho `max` variantes y `maxBytes` entre todas
 * (JSON y gzip): al pasar de un tope se descartan las más antiguas. Las copias caducadas se tiran en
 * cuanto hay que calcular otra: una variante que nadie vuelve a pedir no se queda ocupando memoria.
 * Con `stableEtag`, la firma no cuenta el campo `generatedAt`.
 */
export function createJsonMemo({ max = 200, maxBytes = Infinity, now = Date.now, emptyTtl = 2_000 } = {}) {
  const entries = new Map();
  let bytes = 0;
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.json.length + e.gz.length;
    entries.delete(key);
  };
  return function get(key, ttl, compute, { stableEtag = false, isEmpty } = {}) {
    const t = now();
    const hit = entries.get(key);
    if (hit && t - hit.at < hit.ttl) return hit;
    for (const [k, e] of entries) if (t - e.at >= e.ttl) drop(k);
    const body = compute();
    const json = Buffer.from(JSON.stringify(body));
    const signed = stableEtag && body?.generatedAt !== undefined ? JSON.stringify({ ...body, generatedAt: undefined }) : json;
    const empty = Boolean(isEmpty?.(body));
    const entry = {
      at: now(), ttl: empty ? emptyTtl : ttl, json, gz: gzipSync(json),
      etag: `"${createHash('sha1').update(signed).digest('base64url').slice(0, 20)}"`, empty,
    };
    drop(key);
    entries.set(key, entry);
    bytes += json.length + entry.gz.length;
    while (entries.size > max || (bytes > maxBytes && entries.size > 1)) drop(entries.keys().next().value);
    return entry;
  };
}

/** Redirección permanente (301). Se guarda un día: la dirección canónica no cambia. */
function redirect(res, location, status = 301) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'public, max-age=86400' });
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

/**
 * Cuerpo de la petición como texto; null en cuanto pasa de `max` bytes. Entonces deja de leer: el resto
 * no se baja (tooLarge cierra la conexión), así nadie hace que el servidor reciba megas para tirarlos.
 */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      req.off('data', onData);
      req.pause();
      resolve(null);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
/** 413 y se cierra la conexión: lo que quede del cuerpo no se lee. */
function tooLarge(res) {
  res.setHeader('Connection', 'close');
  return send(res, 413, rpcFailure(RPC.invalidRequest, 'Mensaje demasiado grande'));
}
/** Error JSON-RPC sin petición a la que responder (el mensaje no se pudo leer o no se aceptó). */
const rpcFailure = (code, message, data) => ({ jsonrpc: '2.0', id: null, error: { code, message, ...(data ? { data } : {}) } });

/**
 * Cliente de un mensaje MCP, para su presupuesto. El servidor sólo escucha en 127.0.0.1, detrás del
 * túnel de Cloudflare, que pone la IP real en CF-Connecting-IP y no deja que la cambie quien llama.
 */
const clientAddress = (req) => req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '';

/** Los dos presupuestos a la vez: si el segundo no tiene fichas, se devuelve la del primero. */
const bothBudgets = (a, b) => ({
  take() {
    if (!a.take()) return false;
    if (b.take()) return true;
    a.refund();
    return false;
  },
  refund() {
    a.refund();
    b.refund();
  },
});

/** Estado HTTP de una respuesta MCP: los errores de versión y de cabeceras, 400; en la versión moderna, un método que no existe, 404. */
function mcpStatus(reply, modern) {
  const code = reply.error?.code;
  if (code === RPC.unsupportedVersion || code === RPC.headerMismatch) return 400;
  if (code === RPC.methodNotFound && modern) return 404;
  return 200;
}

/** Valor de una cabecera Mcp-Name o Mcp-Param-*: tal cual o, si va como «=?base64?…?=», descodificado. */
function mcpHeaderValue(value) {
  const m = typeof value === 'string' ? /^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/.exec(value) : null;
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : value;
}

/**
 * En la versión 2026-07-28 las cabeceras repiten lo que dice el cuerpo, para que un proxy pueda
 * decidir sin leerlo: si no coinciden, cada uno podría ver una petición distinta. Devuelve qué no
 * cuadra, o null. Las versiones anteriores no llevan Mcp-Method ni Mcp-Name, ni la versión en `_meta`.
 */
function mcpHeaderMismatch(headers, message) {
  const isRequest = typeof message?.method === 'string' && idOf(message) !== null;
  if (!isRequest) return null;
  const header = headers['mcp-protocol-version'];
  const body = versionOf(message);
  if (body === null) {
    return isModernVersion(header) ? `MCP-Protocol-Version dice ${header}, pero la petición no lleva su versión en params._meta` : null;
  }
  if (header !== body) return `MCP-Protocol-Version (${header ?? 'ninguna'}) no coincide con la versión de params._meta`;
  if (!isModernVersion(body)) return null;
  if (headers['mcp-method'] !== message.method) return 'La cabecera Mcp-Method falta o no coincide con el método';
  if (MCP_NAMED.has(message.method)) {
    const name = message.params?.name ?? message.params?.uri;
    if (mcpHeaderValue(headers['mcp-name']) !== name) return 'La cabecera Mcp-Name falta o no coincide con params.name';
  }
  return null;
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
function fileEtag(info) {
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

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Rellena los `<span data-about="owner|contact">` de una página con el titular y el contacto; el
 * correo, como enlace. null si no hay ninguno de los dos (la página se sirve tal cual).
 * @param {{ owner?: string | null, contact?: string | null }} about
 */
export function aboutFiller({ owner, contact } = {}) {
  if (!owner && !contact) return null;
  const value = {
    owner: owner && escapeHtml(owner),
    contact: contact && (contact.includes('@') ? `<a href="mailto:${escapeHtml(contact)}">${escapeHtml(contact)}</a>` : escapeHtml(contact)),
  };
  const fill = (html) => html.replace(/(<span data-about="(owner|contact)">)[^<]*(<\/span>)/g, (all, open, key, close) => (value[key] ? `${open}${value[key]}${close}` : all));
  fill.tag = createHash('sha1').update(`${owner}|${contact}`).digest('base64url').slice(0, 8); // para el ETag
  return fill;
}

/** Una página que se rellena al servirla: su ETag cuenta el fichero y lo que se le añade. */
async function serveFilledPage(req, res, file, fill) {
  const info = await stat(file);
  const etag = fileEtag(info).replace(/"$/, `-${fill.tag}"`);
  const headers = { 'Cache-Control': OWN_CACHE, ETag: etag, 'Last-Modified': info.mtime.toUTCString() };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const body = Buffer.from(fill(await readFile(file, 'utf8')));
  res.writeHead(200, { ...headers, 'Content-Type': MIME['.html'], 'Content-Length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
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
