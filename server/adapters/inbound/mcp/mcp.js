// Adaptador de entrada MCP (Model Context Protocol): deja que un asistente de IA (Claude, ChatGPT…)
// consulte el directo con herramientas: buscar trenes y estaciones, ver la ficha de una estación,
// incidencias, alertas, un resumen y el estado de las fuentes. Habla JSON-RPC 2.0 sin estado y sin
// sesiones (cada POST a /mcp es una petición completa; ver http-server.js), así que no guarda nada
// entre llamadas. Como el adaptador HTTP, sólo habla con el caso de uso de consulta (query).
//
// Cada resultado lleva la atribución que piden las licencias de las fuentes de lo que devuelve y la
// hora de los datos: el asistente puede resumirlos, pero quien los lea tiene que saber de dónde salen.
// La ficha de una estación sale de la misma función pura que usa el mapa: así el asistente y la web
// cuentan los mismos trenes parados y en camino.
import { stationBoard } from '../../../../public/js/station-board.js';
import { isStationCode, SEVERITY_RANK } from '../../../domain/model.js';

/** Versiones del protocolo que entiende; si el cliente pide otra, se le ofrece la primera. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const MODES = ['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'bus', 'otros'];
const CATEGORIES = ['ferroviario', 'carretera', 'meteo', 'incendio', 'sismo', 'catastrofe', 'emergencia'];
const SEVERITIES = ['baja', 'media', 'alta', 'muy alta'];
// Tope de elementos por respuesta: lo que cabe con holgura en el contexto de un modelo.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_TEXT = 100;
const MAX_DESCRIPTION = 400;
const MEMO_MAX = 500; // variantes guardadas: cada una, como mucho MAX_LIMIT elementos

const NOTE = 'Radar España no es una web oficial: reúne datos públicos con retraso, algunos con posición estimada '
  + 'a partir del horario (estimated: true). No sirven para decisiones operativas ni de seguridad.';

const plain = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s ?? null);
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== false));

/** Error de la petición JSON-RPC (método inexistente, parámetros…): va en `error`, no en el resultado. */
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/** Error de una herramienta (estación que no existe…): va en el resultado con isError, para que el modelo lo lea. */
class ToolError extends Error {}
/** Hay que calcular una respuesta y se ha gastado el presupuesto: el adaptador HTTP contesta 429. */
export class McpBusy extends Error {}

/**
 * @param {{ query: ReturnType<typeof import('../../../application/use-cases/query-situation.js').makeQuerySituation>,
 *           about?: { publicUrl?: string }, version?: string, now?: () => number }} deps
 */
export function createMcpHandler({ query, about = {}, version = '0.0.0', now = Date.now }) {
  const site = about.publicUrl ?? 'https://xn--radarespaa-19a.es';

  // Atribución de las fuentes de lo que se devuelve: la que pide su licencia (la de cada operador, si
  // la fuente agrupa a varios) y la hora del último dato leído.
  const credits = (items) => {
    const health = new Map(query.health().map((h) => [h.id, h]));
    const out = new Map();
    for (const it of items) {
      const h = health.get(it.source);
      if (!h || out.has(`${h.id}|${it.operator ?? ''}`)) continue;
      const license = h.operatorLicenses?.[it.operator] ?? h.license;
      out.set(`${h.id}|${it.operator ?? ''}`, compact({ source: h.id, name: h.name, attribution: license, url: h.url, updatedAt: iso(h.sourceTime ?? h.lastOk) }));
    }
    return [...out.values()];
  };
  const envelope = (body, items = []) => ({
    ...body,
    generatedAt: iso(now()),
    sources: credits(items),
    note: NOTE,
    moreInfo: `${site}/legal#fuentes`,
  });

  const vehicleOut = (v) => compact({
    id: v.id, mode: v.mode, operator: v.operator, service: v.service, line: v.line, label: v.label,
    origin: v.origin, destination: v.destination, current: v.current, stopped: v.stopped, next: v.next,
    nextEta: v.nextEta, nextInMinutes: v.nextInMinutes, platform: v.platform, delay: v.delay, late: v.late,
    lat: v.lat, lon: v.lon, fixTime: iso(v.fixTime), estimated: v.estimated,
  });
  const eventOut = (e) => compact({
    id: e.id, category: e.category, type: e.type, severity: e.severity, level: e.level, title: e.title,
    description: clip(e.description, MAX_DESCRIPTION), area: e.area, lat: e.lat, lon: e.lon, magnitude: e.magnitude,
    start: iso(e.start), end: iso(e.end), issued: iso(e.issued), url: e.url,
  });
  const alertOut = (a) => compact({
    id: a.id, type: a.type, severity: a.severity, title: a.title, description: clip(a.description, MAX_DESCRIPTION),
    lat: a.lat, lon: a.lon, vehicles: a.vehicleIds?.length ?? (a.vehicleId ? 1 : null), credit: a.credit,
    since: iso(a.since), updated: iso(a.updated),
  });

  const tools = {
    buscar_trenes: {
      title: 'Buscar trenes y otros vehículos',
      ttl: 5_000,
      description: 'Busca trenes, metros, tranvías y autobuses en circulación ahora en España: número, línea, '
        + 'origen, destino, estación actual o próxima, vía, retraso en minutos y posición. Filtra por texto '
        + '(número de tren, línea, estación, ciudad u operador), tipo y retraso mínimo.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: MAX_TEXT, description: 'Número de tren (p. ej. «3123»), línea («C-5»), estación, ciudad, servicio («AVE») u operador.' },
          mode: { type: 'string', enum: MODES, description: 'av (alta velocidad), ld (larga distancia), md (media distancia), cercanias, metro, tranvia, bus u otros.' },
          minDelay: { type: 'integer', minimum: 0, maximum: 1440, description: 'Sólo los que llevan al menos estos minutos de retraso.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        additionalProperties: false,
      },
      run({ text, mode, minDelay, limit: max }) {
        const words = plain(text).split(' ').filter(Boolean);
        const haystack = (v) => plain([v.label, v.line, v.service, v.operator, v.origin, v.destination, v.current, v.next].join(' '));
        const found = query.vehicles({ mode, minDelay })
          .filter((v) => !words.length || words.every((w) => haystack(v).includes(w)))
          // Primero los de más retraso: es lo que suele preguntarse.
          .sort((a, b) => (b.delay ?? -1) - (a.delay ?? -1));
        const shown = found.slice(0, limitOf(max));
        return envelope({ total: found.length, vehicles: shown.map(vehicleOut) }, shown);
      },
    },

    buscar_estaciones: {
      title: 'Buscar estaciones',
      ttl: 600_000, // el catálogo cambia unas pocas veces al día
      description: 'Busca estaciones de tren (Renfe), metro, tranvía y otras redes por nombre, población o provincia. '
        + 'Devuelve su código, que sirve para ver su ficha con la herramienta «estacion».',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MAX_TEXT, description: 'Nombre de la estación, población o provincia.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        required: ['text'],
        additionalProperties: false,
      },
      run({ text, limit: max }) {
        const q = plain(text);
        if (!q) throw new ToolError('Falta el texto que buscar');
        const scored = [];
        for (const s of query.stations()) {
          const name = plain(s.name);
          // Primero las que se llaman así, luego las que empiezan así y luego el resto que lo contiene.
          const rank = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : plain(`${s.place ?? ''} ${s.province ?? ''}`).includes(q) ? 3 : -1;
          if (rank >= 0) scored.push([rank, s]);
        }
        scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'es'));
        const stations = scored.slice(0, limitOf(max)).map(([, s]) => compact({
          code: s.code, name: s.name, place: s.place, province: s.province, network: s.network ?? 'Renfe',
          mode: s.mode, cercanias: s.cercanias, accessible: s.accessible, lat: s.lat, lon: s.lon,
        }));
        return envelope({ total: scored.length, stations });
      },
    },

    estacion: {
      title: 'Ficha de una estación',
      ttl: 10_000,
      description: 'Trenes parados en una estación y los que van hacia ella (con vía, hora prevista y retraso) y los '
        + 'avisos de Renfe de la estación. El código sale de «buscar_estaciones».',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', maxLength: 80, description: 'Código de la estación: 5 cifras en Renfe («71801») o red:código («fgc:PC»).' } },
        required: ['code'],
        additionalProperties: false,
      },
      run({ code }) {
        const station = isStationCode(code) ? query.station(code) : null;
        if (!station) throw new ToolError(`No hay ninguna estación con el código «${code}». Búscala con buscar_estaciones.`);
        const board = stationBoard(station, { vehicles: query.vehicles(), events: query.events({ category: 'ferroviario' }), lines: [] });
        return envelope({
          station: compact({
            code: station.code, name: station.name, place: station.place, province: station.province, address: station.address,
            network: station.network ?? 'Renfe', accessible: station.accessible, lat: station.lat, lon: station.lon,
          }),
          stopped: board.stopped.map(vehicleOut),
          arriving: board.arriving.map(vehicleOut),
          notices: board.notices.map(eventOut),
        }, [...board.stopped, ...board.arriving, ...board.notices]);
      },
    },

    incidencias: {
      title: 'Incidencias y avisos',
      ttl: 15_000,
      description: 'Incidencias activas en España: avisos ferroviarios de Renfe, tráfico (DGT y otras), avisos '
        + 'meteorológicos de AEMET, incendios, terremotos, catástrofes (GDACS) y emergencias oficiales (planes de '
        + 'protección civil y cortes de luz). De más a menos grave.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          text: { type: 'string', maxLength: MAX_TEXT, description: 'Palabras del título, la descripción o la zona (carretera, ciudad, provincia…).' },
          minSeverity: { type: 'string', enum: SEVERITIES },
          roadWorks: { type: 'boolean', default: false, description: 'Incluir las obras en carretera (más de mil; el mapa también las oculta si no se piden).' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
        additionalProperties: false,
      },
      run({ category, text, minSeverity, roadWorks = false, limit: max }) {
        const words = plain(text).split(' ').filter(Boolean);
        const min = SEVERITY_RANK[minSeverity] ?? 0;
        const found = query.events({ category })
          .filter((e) => roadWorks || e.type !== 'roadMaintenance')
          .filter((e) => (SEVERITY_RANK[e.severity] ?? 0) >= min)
          .filter((e) => !words.length || words.every((w) => plain(`${e.title} ${e.description ?? ''} ${e.area ?? ''}`).includes(w)))
          .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (b.start ?? 0) - (a.start ?? 0));
        const shown = found.slice(0, limitOf(max));
        return envelope({ total: found.length, events: shown.map(eventOut) }, shown);
      },
    },

    alertas: {
      title: 'Alertas activas',
      ttl: 5_000,
      description: 'Alertas que detecta Radar España ahora: retrasos fuertes o agrupados, trenes parados, avisos '
        + 'graves y fuentes de datos caídas, de más a menos grave.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const active = query.alerts();
        return envelope({ total: active.length, alerts: active.slice(0, MAX_LIMIT).map(alertOut) });
      },
    },

    resumen: {
      title: 'Resumen del estado actual',
      ttl: 5_000,
      description: 'Cifras del momento: vehículos en el mapa por tipo, cuántos llevan 5 minutos o más de retraso, '
        + 'retraso mediano y máximo, alertas activas, fuentes funcionando y demanda eléctrica.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const { current } = query.kpis();
        const health = query.health();
        return envelope({
          vehicles: current?.vehicles ?? null,
          byMode: current?.byMode ?? {},
          delayedAtLeast5Min: current?.delayed ?? null,
          withDelayInfo: current?.withDelayInfo ?? null,
          medianDelay: current?.medianDelay ?? null,
          maxDelay: current?.maxDelay ?? null,
          activeAlerts: query.alerts().length,
          sourcesOk: health.filter((h) => h.enabled && h.ok).length,
          sourcesEnabled: health.filter((h) => h.enabled).length,
          metrics: query.metrics(),
        }, Object.keys(query.metrics()).map((source) => ({ source })));
      },
    },

    estado_fuentes: {
      title: 'Estado de las fuentes de datos',
      ttl: 15_000,
      description: 'Cada fuente de datos que usa Radar España: si funciona, cuándo se leyó por última vez, por qué '
        + 'está desactivada si lo está, y su licencia y atribución.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run() {
        const sources = query.health().map((h) => compact({
          id: h.id, name: h.name, kind: h.kind, enabled: h.enabled, ok: h.ok, reason: h.reason, error: h.error,
          count: h.count, lastOk: iso(h.lastOk), attribution: h.license, url: h.url,
        }));
        return { generatedAt: iso(now()), sources, note: NOTE, moreInfo: `${site}/legal#fuentes` };
      },
    },
  };

  const toolList = Object.entries(tools).map(([name, t]) => ({
    name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true, openWorldHint: false },
  }));

  // Resultados ya calculados, unos segundos (el `ttl` de cada herramienta, el mismo ritmo que su ruta de
  // la API): muchos asistentes preguntando lo mismo cuestan lo que uno. La clave son la herramienta y sus
  // argumentos, con el texto sin tildes ni mayúsculas, que es como se busca. Como mucho MEMO_MAX
  // variantes; las caducadas se tiran en cuanto hay que calcular otra.
  const memo = new Map();
  function remember(key, ttl, compute) {
    const t = now();
    const hit = memo.get(key);
    if (hit && t - hit.at < ttl) return hit.result;
    for (const [k, e] of memo) if (t - e.at >= e.ttl) memo.delete(k);
    const result = compute();
    memo.delete(key);
    memo.set(key, { at: t, ttl, result });
    while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    return result;
  }

  function callTool(params, { budget } = {}) {
    const tool = Object.hasOwn(tools, params?.name ?? '') ? tools[params.name] : null;
    if (!tool) throw new RpcError(-32602, `Herramienta desconocida: ${params?.name}`);
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw new RpcError(-32602, 'arguments tiene que ser un objeto');
    checkArgs(tool.inputSchema, args);
    const key = `${params.name}?${JSON.stringify(Object.keys(args).sort().map((k) => [k, k === 'text' ? plain(args[k]) : args[k]]))}`;
    return remember(key, tool.ttl, () => {
      // Sólo se gasta presupuesto al calcular; un error de la herramienta (una estación que no existe) no cuesta nada.
      if (budget && !budget.take()) throw new McpBusy();
      try {
        const data = tool.run(args);
        return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        budget?.refund();
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    });
  }

  const methods = {
    initialize: (params) => ({
      protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'radar-espana', title: 'Radar España', version, websiteUrl: site },
      instructions: 'Datos en directo de trenes, metros, tranvías y autobuses de España y de incidencias (tráfico, '
        + 'tiempo, incendios, terremotos, emergencias). Para una estación, busca primero su código con '
        + 'buscar_estaciones. Cita las fuentes (campo sources) al dar los datos. ' + NOTE,
    }),
    ping: () => ({}),
    'tools/list': () => ({ tools: toolList }),
    'tools/call': callTool,
  };

  /**
   * Atiende un mensaje JSON-RPC ya leído. Devuelve la respuesta, o null si es una notificación o una
   * respuesta (no llevan contestación). `budget` (take/refund) acota los cálculos de las herramientas:
   * sin fichas lanza McpBusy. Los demás métodos y las respuestas ya guardadas no lo gastan.
   * @param {object} message
   * @param {{ budget?: { take(): boolean, refund(): void } }} [options]
   */
  return function handle(message, options) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
      return rpcError(message?.id ?? null, -32600, 'Petición JSON-RPC 2.0 no válida');
    }
    const isRequest = typeof message.method === 'string' && (typeof message.id === 'string' || Number.isInteger(message.id));
    if (!isRequest) return null; // notificaciones (notifications/initialized…) y respuestas
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : null;
    if (!method) return rpcError(message.id, -32601, `Método no disponible: ${message.method}`);
    try {
      return { jsonrpc: '2.0', id: message.id, result: method(message.params, options) };
    } catch (err) {
      if (err instanceof RpcError) return rpcError(message.id, err.code, err.message);
      throw err;
    }
  };
}

const limitOf = (n) => (Number.isInteger(n) ? Math.max(1, Math.min(n, MAX_LIMIT)) : DEFAULT_LIMIT);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Comprueba los argumentos con lo poco de JSON Schema que usan las herramientas (tipos, enum, mínimos,
 * máximos, largos y obligatorios). Un argumento mal formado es un error de la petición (-32602).
 */
function checkArgs(schema, args) {
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new RpcError(-32602, `Argumento desconocido: ${key}`);
  for (const key of schema.required ?? []) if (args[key] === undefined) throw new RpcError(-32602, `Falta el argumento ${key}`);
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const ok = rule.type === 'string' ? typeof value === 'string' && value.length <= (rule.maxLength ?? Infinity) && value.length >= (rule.minLength ?? 0)
      : rule.type === 'integer' ? Number.isInteger(value) && value >= (rule.minimum ?? -Infinity) && value <= (rule.maximum ?? Infinity)
        : rule.type === 'boolean' ? typeof value === 'boolean'
          : false;
    if (!ok || (rule.enum && !rule.enum.includes(value))) throw new RpcError(-32602, `Argumento no válido: ${key}`);
  }
  return args;
}
