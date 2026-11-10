// Métricas en el formato de texto de Prometheus, para la monitorización del VPS (deploy/monitor/): la
// lee cada 30 s desde /metrics, en un puerto interno de Docker que no sale al túnel. Sin dependencias:
// contadores e histogramas en memoria, y el estado de las fuentes y del proceso en el momento de leerlas.
//
// Nada de quién pregunta: las etiquetas son rutas sin parámetros, métodos, códigos y nombres de
// fuentes o herramientas, todos de una lista corta; del bot de Telegram, cuántos chats y qué se sigue, en
// conjunto (domain/seguidos/uso.js), nunca el número de un chat. Aun así, cada métrica admite como mucho
// MAX_SERIES combinaciones: si un fallo metiera valores sin fin, se descartan (y se cuentan).
import { readFileSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';

const MAX_SERIES = 2_000;
// Segundos. Las peticiones a la web tardan milisegundos (casi todo sale de memoria); las lecturas de
// las fuentes, de décimas a minutos (horarios GTFS, la red del IGN).
const REQUEST_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const SOURCE_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']);

const DEFINITIONS = {
  radar_http_requests_total: { type: 'counter', help: 'Peticiones HTTP atendidas, por ruta (sin parámetros), método y código.' },
  radar_http_request_seconds: { type: 'histogram', help: 'Tiempo hasta terminar de enviar cada respuesta, por ruta.', buckets: REQUEST_BUCKETS },
  radar_mcp_messages_total: { type: 'counter', help: 'Mensajes al servidor MCP, por método, herramienta, versión del protocolo y resultado.' },
  radar_mcp_tool_seconds: { type: 'histogram', help: 'Tiempo de cálculo de cada llamada a una herramienta MCP (las guardadas, casi cero).', buckets: REQUEST_BUCKETS },
  radar_source_reads_total: { type: 'counter', help: 'Lecturas de cada fuente, buenas (ok) o fallidas (error).' },
  radar_source_read_seconds: { type: 'histogram', help: 'Duración de cada lectura de una fuente.', buckets: SOURCE_BUCKETS },
  radar_log_messages_total: { type: 'counter', help: 'Avisos (warn) y errores (error) escritos en el registro.' },
  radar_metrics_dropped_total: { type: 'counter', help: 'Series descartadas por pasar del máximo de combinaciones de una métrica.' },
};

/**
 * @param {{ version?: string, now?: () => number, startedAt?: number, cgroupDir?: string }} [options]
 *   cgroupDir: carpeta del cgroup del contenedor, de donde sale su memoria (la que cuenta para su límite).
 * @returns {import('../../../application/ports.js').MetricsPort & {
 *   render(snapshot?: { sources?: object[], bot?: object|null, now?: number }): string, close(): void }}
 *   render: el texto para /metrics, con el estado de las fuentes (`sources`, lo que da /api/health),
 *   el uso del bot de Telegram (`bot`, si este servidor lo atiende) y el del proceso en este momento.
 *   close: deja de medir el retraso del bucle de eventos.
 */
export function createPrometheusMetrics({ version = '0.0.0', now = Date.now, startedAt = now(), cgroupDir = '/sys/fs/cgroup' } = {}) {
  /** @type {Map<string, Map<string, { labels: object, value?: number, counts?: number[], sum?: number, count?: number }>>} */
  const series = new Map(Object.keys(DEFINITIONS).map((name) => [name, new Map()]));
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  const slot = (name, labels) => {
    const all = series.get(name);
    const key = JSON.stringify(labels);
    let s = all.get(key);
    if (!s) {
      if (all.size >= MAX_SERIES) {
        if (name !== 'radar_metrics_dropped_total') add('radar_metrics_dropped_total', { metric: name });
        return null;
      }
      s = DEFINITIONS[name].type === 'histogram'
        ? { labels, counts: DEFINITIONS[name].buckets.map(() => 0), sum: 0, count: 0 }
        : { labels, value: 0 };
      all.set(key, s);
    }
    return s;
  };
  function add(name, labels, n = 1) {
    const s = slot(name, labels);
    if (s) s.value += n;
  }
  function observe(name, labels, value) {
    if (!Number.isFinite(value) || value < 0) return;
    const s = slot(name, labels);
    if (!s) return;
    const { buckets } = DEFINITIONS[name];
    for (let i = 0; i < buckets.length; i++) if (value <= buckets[i]) s.counts[i]++;
    s.sum += value;
    s.count++;
  }

  return {
    request({ route, method, status, seconds }) {
      add('radar_http_requests_total', { route, method: HTTP_METHODS.has(method) ? method : 'OTRO', status: String(status) });
      observe('radar_http_request_seconds', { route }, seconds);
    },
    mcp({ method, tool = '', era, result, seconds }) {
      add('radar_mcp_messages_total', { method, tool, era, result });
      if (tool && seconds !== undefined) observe('radar_mcp_tool_seconds', { tool }, seconds);
    },
    sourceRead({ source, ok, seconds }) {
      add('radar_source_reads_total', { source, result: ok ? 'ok' : 'error' });
      observe('radar_source_read_seconds', { source }, seconds);
    },
    logged(level) {
      add('radar_log_messages_total', { level });
    },
    render({ sources = [], bot = null, now: at = now() } = {}) {
      const out = [];
      const gauge = (name, help, rows) => writeRows(out, name, 'gauge', help, rows);
      gauge('radar_info', 'Versión del servidor.', [[{ version }, 1]]);
      processMetrics(out, { startedAt, loopDelay });
      containerMemory(out, cgroupDir);

      const enabled = sources.filter((s) => s.enabled);
      gauge('radar_source_enabled', 'Fuente activa (1) o desactivada o en pausa (0).',
        sources.map((s) => [{ source: s.id }, s.enabled ? 1 : 0]));
      // Una fuente que aún no se ha leído no cuenta como caída (al arrancar serían todas): si nunca llega
      // a leerse bien, avisa radar_source_seconds_since_ok.
      gauge('radar_source_up', 'La última lectura de la fuente fue buena (1) o falló (0). Sin valor si aún no se ha leído.',
        enabled.filter((s) => s.ok === true || s.ok === false).map((s) => [{ source: s.id }, s.ok ? 1 : 0]));
      gauge('radar_source_items', 'Vehículos, incidencias o valores de la última lectura buena.',
        enabled.map((s) => [{ source: s.id }, s.count ?? 0]));
      gauge('radar_source_interval_seconds', 'Cada cuánto se lee la fuente.',
        enabled.map((s) => [{ source: s.id }, (s.interval ?? 0) / 1000]));
      // Desde el arranque si aún no ha habido ninguna buena: así también avisa la que nunca ha funcionado.
      gauge('radar_source_seconds_since_ok', 'Segundos desde la última lectura buena (o desde el arranque, si no ha habido ninguna).',
        enabled.map((s) => [{ source: s.id }, Math.max(0, (at - (Number.isFinite(s.lastOk) ? s.lastOk : startedAt)) / 1000)]));
      if (bot) botMetrics(out, bot);

      for (const [name, all] of series) {
        const { type, help, buckets } = DEFINITIONS[name];
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const s of all.values()) {
          if (type !== 'histogram') {
            out.push(`${name}${labelText(s.labels)} ${num(s.value)}`);
            continue;
          }
          const base = name;
          buckets.forEach((le, i) => out.push(`${base}_bucket${labelText({ ...s.labels, le: String(le) })} ${s.counts[i]}`));
          out.push(`${base}_bucket${labelText({ ...s.labels, le: '+Inf' })} ${s.count}`);
          out.push(`${base}_sum${labelText(s.labels)} ${num(s.sum)}`, `${base}_count${labelText(s.labels)} ${s.count}`);
        }
      }
      return `${out.join('\n')}\n`;
    },
    close() {
      loopDelay.disable();
    },
  };
}

/** Una métrica entera: su ayuda, su tipo y una línea por cada fila [etiquetas, valor]. */
function writeRows(out, name, type, help, rows) {
  out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of rows) out.push(`${name}${labelText(labels)} ${num(value)}`);
}

/**
 * Cuánto se usa el bot de Telegram (follow-bot usage()). Sólo lo escribe el servidor que atiende el bot: en un
 * relevo, el otro no escribe nada, y en los paneles no se cuenta dos veces. Los contadores (_total) son los totales
 * que el bot guarda en su disco con lo demás: no vuelven a 0 al arrancar ni al pasar a otro contenedor, así que en
 * Prometheus son la misma cifra antes y después de un despliegue (en los paneles, max y no increase).
 */
function botMetrics(out, { chats = 0, digest = 0, follows = {}, distinct = {}, top = [], totals = null }) {
  const g = (name, help, rows) => writeRows(out, name, 'gauge', help, rows);
  const c = (name, help, rows) => writeRows(out, name, 'counter', help, rows);
  g('radar_bot_chats', 'Chats que siguen algo en el bot de Telegram (cada uno, una persona: sólo atiende chats privados).', [[{}, chats]]);
  g('radar_bot_digest_chats', 'Chats del bot de Telegram con parte diario.', [[{}, digest]]);
  g('radar_bot_follows', 'Cosas seguidas en el bot de Telegram, por tipo (una que siguen tres chats cuenta tres).',
    Object.entries(follows).map(([kind, n]) => [{ kind }, n]));
  g('radar_bot_follow_items', 'Cosas distintas seguidas en el bot de Telegram, por tipo.',
    Object.entries(distinct).map(([kind, n]) => [{ kind }, n]));
  g('radar_bot_follow_top', 'Chats que siguen cada una de las cosas más seguidas en el bot de Telegram.',
    top.map((t) => [{ kind: t.kind, key: t.key, name: t.name }, t.chats]));
  if (!totals) return;
  g('radar_bot_totals_since_seconds', 'Desde cuándo cuentan los totales del bot de Telegram (segundos desde 1970).',
    [[{}, Math.floor(totals.since / 1000)]]);
  c('radar_bot_chats_added_total', 'Chats que han empezado a seguir algo en el bot de Telegram.', [[{}, totals.added]]);
  c('radar_bot_chats_removed_total', 'Chats que han dejado el bot de Telegram: dejan de seguirlo todo (dejar), escriben /baja (baja) o lo bloquean (bloqueo).',
    Object.entries(totals.removed ?? {}).map(([reason, n]) => [{ reason }, n]));
  c('radar_bot_notices_total', 'Avisos del bot de Telegram: de algo seguido (aviso) y partes diarios (parte).',
    Object.entries(totals.notices ?? {}).map(([kind, n]) => [{ kind }, n]));
  c('radar_bot_commands_total', 'Mensajes al bot de Telegram, por orden (enlace: /start desde la web; boton: un botón de una lista; limite: pasado del tope por minuto).',
    Object.entries(totals.commands ?? {}).map(([command, n]) => [{ command }, n]));
}

/** Memoria, CPU y retraso del bucle de eventos (desde la lectura anterior) del proceso de Node. */
function processMetrics(out, { startedAt, loopDelay }) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const heap = getHeapStatistics();
  const line = (name, type, help, value, labels = {}) => out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labelText(labels)} ${num(value)}`);
  line('process_start_time_seconds', 'gauge', 'Hora de arranque del proceso (segundos desde 1970).', Math.floor(startedAt / 1000));
  line('process_cpu_seconds_total', 'counter', 'Tiempo de CPU usado por el proceso.', (cpu.user + cpu.system) / 1e6);
  line('process_resident_memory_bytes', 'gauge', 'Memoria residente (RSS) del proceso.', mem.rss);
  line('nodejs_heap_used_bytes', 'gauge', 'Montón de V8 en uso.', mem.heapUsed);
  line('nodejs_heap_total_bytes', 'gauge', 'Montón de V8 reservado.', mem.heapTotal);
  line('nodejs_heap_size_limit_bytes', 'gauge', 'Tope del montón de V8.', heap.heap_size_limit);
  line('nodejs_external_memory_bytes', 'gauge', 'Memoria fuera del montón (buffers).', mem.external + (mem.arrayBuffers ?? 0));
  // Cuánto ha tardado el bucle de eventos en atender lo que tocaba: si sube, la web va a tirones.
  const q = (p) => (loopDelay.count ? loopDelay.percentile(p) / 1e9 : 0);
  out.push('# HELP nodejs_eventloop_delay_seconds Retraso del bucle de eventos desde la lectura anterior.', '# TYPE nodejs_eventloop_delay_seconds gauge');
  for (const [quantile, value] of [['0.5', q(50)], ['0.99', q(99)], ['1', loopDelay.count ? loopDelay.max / 1e9 : 0]]) {
    out.push(`nodejs_eventloop_delay_seconds${labelText({ quantile })} ${num(value)}`);
  }
  loopDelay.reset();
}

/**
 * Memoria del contenedor según su cgroup (v2): la que cuenta para su límite (mem_limit de compose.yaml),
 * la parte anónima (lo que no se puede soltar: si llega al límite, el kernel mata el proceso) y el pico.
 * Fuera de un contenedor con límite (en local) no hay memory.max: no se escribe nada.
 */
function containerMemory(out, dir) {
  const read = (file) => {
    try {
      return readFileSync(`${dir}/${file}`, 'utf8').trim();
    } catch {
      return null;
    }
  };
  const max = read('memory.max');
  const current = read('memory.current');
  if (max === null || current === null) return;
  const anon = /^anon (\d+)$/m.exec(read('memory.stat') ?? '')?.[1];
  const rows = [
    ['radar_container_memory_bytes', 'Memoria del contenedor (cgroup), caché de ficheros incluida.', Number(current)],
    ['radar_container_memory_anon_bytes', 'Memoria anónima del contenedor: la que no se puede soltar.', anon === undefined ? null : Number(anon)],
    ['radar_container_memory_peak_bytes', 'Pico de memoria del contenedor desde que arrancó.', read('memory.peak') === null ? null : Number(read('memory.peak'))],
    ['radar_container_memory_limit_bytes', 'Límite de memoria del contenedor (0: sin límite).', max === 'max' ? 0 : Number(max)],
  ];
  for (const [name, help, value] of rows) {
    if (value === null || !Number.isFinite(value)) continue;
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${num(value)}`);
  }
}

const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelText = (labels) => {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};
const num = (v) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0');
