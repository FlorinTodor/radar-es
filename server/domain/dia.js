// El día en cifras: el balance de un día (de Madrid) con lo que el radar ve. Dos piezas:
// - el registro del día, que se va llenando minuto a minuto (vehículos vistos en tiempo real por tipo y por
//   horas, sus retrasos, y las cancelaciones, trenes sin datos y avisos de emergencia que hubo), acotado y
//   guardable en JSON;
// - el resumen que se enseña, a partir del registro, de los KPI y las alertas del histórico JSONL (de los
//   días anteriores a que existiera el registro, sólo eso) y del mismo día de la semana anterior.
// Vale para cualquier tipo de vehículo: agrupa por el registro de tipos (modos.js) y por las claves de
// línea (seguir.js), sin saber de fuentes ni de operadores. Puro: sin red, ni reloj, ni disco.
import { inForce } from './model.js';
import { MODES, modeInfo } from './modos.js';
import { describeFollow, followKind } from './seguir.js';

export const DAY_RECORD_VERSION = 1;
/** Como los KPI (kpis.js): con 5 min o más, «con retraso». */
export const LATE_MIN = 5;
// Topes del registro de un día: en un día de huelga hubo unas 750 cancelaciones; así nunca crece sin fin.
export const DAY_LIMITS = Object.freeze({ cancellations: 6000, missing: 3000, emergencies: 1500, sources: 300, operators: 60 });
// Retrasos de cada tipo, en minutos de vehículo: de 0 a 14 minuto a minuto, y luego 15–29, 30–59 y 60 o más.
// Basta para la mediana exacta mientras sea menor de 15 min (lo normal) y ocupa 18 números por tipo.
const DELAY_BINS = 18;
const SEVERITY_RANK = { baja: 1, media: 2, alta: 3, 'muy alta': 4 };
const LEVEL_RANK = { amarillo: 1, naranja: 2, rojo: 3 };
const MAX_TEXT = 200;
const TOP_LINES = 10;
const TOP_OPERATORS = 8;
const TOP_ALERTS = 8;
// Una hora en la que, de media, menos vehículos que éstos dieron su retraso no tiene porcentaje: con tres o cuatro
// trenes de madrugada, uno solo cambia el resultado de 25 en 25 puntos y una barra al 100 % engaña.
export const MIN_LATE_SAMPLE = 5;
// La semana anterior se dibuja al lado sólo si de ese día hay al menos estas horas: con una o dos, en la gráfica
// queda una raya gris suelta que parece un error.
const MIN_COMPARE_HOURS = 6;
const TOP_EMERGENCIES = 6;

// ---------- Días y horas de Madrid ----------

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' });
const parts = (fmt, t) => Object.fromEntries(fmt.formatToParts(t).map((p) => [p.type, p.value]));

/** Día de Madrid de un instante (epoch ms): «AAAA-MM-DD». */
export function madridDay(t) {
  const p = parts(DAY_FMT, t);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hora de Madrid (0–23) de un instante. El día del cambio de hora, la hora repetida cuenta en la misma. */
export const madridHour = (t) => Number(parts(HOUR_FMT, t).hour) % 24;

/** ¿Es «AAAA-MM-DD» y una fecha que existe? */
export function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** El día `n` días después (o antes, si es negativo). */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- El registro del día ----------

/**
 * @typedef {object} DayRecord
 * @property {number} v
 * @property {string} date                    «AAAA-MM-DD» de Madrid
 * @property {number|null} from               primera muestra (epoch ms)
 * @property {number|null} to                 última muestra
 * @property {Record<string, { n: number, m: Record<string, number[]> }>} hours
 *   por hora («0»–«23»): muestras (n) y, por tipo, [suma, máximo, con retraso publicado, con LATE_MIN o más]
 * @property {Record<string, number[]>} delays  por tipo: minutos de vehículo en cada tramo de retraso
 * @property {{ t: number, total: number, byMode: Record<string, number> }|null} peak  el minuto con más vehículos
 * @property {Record<string, object>} cancellations  por id: lo que hace falta para agruparlas
 * @property {Record<string, object>} missing         trenes (o vehículos) sin datos, por id
 * @property {Record<string, object>} emergencies     avisos de AEMET, terremotos, avisos oficiales y de GDACS
 * @property {Record<string, string[]>} sources      de qué fuentes (y operadores) son los vehículos contados
 * @property {Record<string, string>} credits         atribución de cada fuente de las incidencias contadas
 * @property {Record<string, { name: string, license: string|null, operators: Record<string, string>|null }>} attrib
 *   nombre y licencia de cada fuente contada, tal como estaban ese día (noteSources): el día se cita igual
 *   aunque después cambie o desaparezca la fuente
 * @property {Record<string, boolean>} truncated      qué lista llegó a su tope
 */

/** @returns {DayRecord} */
export function emptyDay(date) {
  return {
    v: DAY_RECORD_VERSION, date, from: null, to: null, hours: {}, delays: {}, peak: null,
    cancellations: {}, missing: {}, emergencies: {}, sources: {}, credits: {}, attrib: {}, truncated: {},
  };
}

const isObject = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const nums = (a, n) => Array.isArray(a) && a.length === n && a.every((x) => Number.isFinite(x) && x >= 0);
// Claves de tipos y fuentes: las de los adaptadores; nada que pueda pisar un prototipo.
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const safeId = (s) => typeof s === 'string' && SAFE_ID.test(s) && s !== '__proto__' && s !== 'constructor' && s !== 'prototype';
const text = (s) => (typeof s === 'string' && s ? s.slice(0, MAX_TEXT) : null);

/** Copia de objetos planos sin claves raras (lo que se lee del disco puede estar mal). */
const cleanMap = (o, ok, max) => {
  const out = {};
  if (!isObject(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, max)) if (typeof k === 'string' && k.length <= 200 && k !== '__proto__' && ok(v)) out[k] = v;
  return out;
};

/**
 * El registro leído del disco, comprobado: lo que no tenga la forma esperada se descarta. null si no es
 * el registro de `date`.
 * @param {unknown} raw @param {string} date
 * @returns {DayRecord|null}
 */
export function sanitizeDay(raw, date) {
  if (!isObject(raw) || raw.v !== DAY_RECORD_VERSION || raw.date !== date || !isDay(date)) return null;
  const day = emptyDay(date);
  day.from = Number.isFinite(raw.from) ? raw.from : null;
  day.to = Number.isFinite(raw.to) ? raw.to : null;
  for (let h = 0; h < 24; h++) {
    const hour = raw.hours?.[String(h)];
    if (!isObject(hour) || !Number.isFinite(hour.n) || hour.n < 0) continue;
    const m = {};
    for (const [mode, c] of Object.entries(isObject(hour.m) ? hour.m : {})) if (safeId(mode) && nums(c, 4)) m[mode] = c;
    day.hours[String(h)] = { n: hour.n, m };
  }
  for (const [mode, bins] of Object.entries(isObject(raw.delays) ? raw.delays : {})) if (safeId(mode) && nums(bins, DELAY_BINS)) day.delays[mode] = bins;
  if (isObject(raw.peak) && Number.isFinite(raw.peak.t) && Number.isFinite(raw.peak.total)) {
    day.peak = { t: raw.peak.t, total: raw.peak.total, byMode: cleanMap(raw.peak.byMode, Number.isFinite, 64) };
  }
  day.cancellations = cleanMap(raw.cancellations, isObject, DAY_LIMITS.cancellations);
  day.missing = cleanMap(raw.missing, isObject, DAY_LIMITS.missing);
  day.emergencies = cleanMap(raw.emergencies, isObject, DAY_LIMITS.emergencies);
  day.sources = cleanMap(raw.sources, (ops) => Array.isArray(ops) && ops.every((o) => typeof o === 'string'), DAY_LIMITS.sources);
  day.credits = cleanMap(raw.credits, (c) => typeof c === 'string', DAY_LIMITS.sources);
  day.attrib = cleanMap(raw.attrib, (a) => isObject(a) && typeof a.name === 'string'
    && (a.license === null || typeof a.license === 'string') && (a.operators === null || isObject(a.operators)), DAY_LIMITS.sources);
  day.truncated = cleanMap(raw.truncated, (b) => b === true, 10);
  return day;
}

const delayBin = (d) => {
  const m = Math.max(0, Math.floor(d));
  return m < 15 ? m : m < 30 ? 15 : m < 60 ? 16 : 17;
};
const modeOf = (v) => (safeId(v?.mode) ? v.mode : 'otros');

/**
 * Suma un minuto de vehículos al registro: los vistos en tiempo real (las posiciones estimadas por horario
 * no cuentan), por tipo, y sus retrasos donde el operador los publica.
 * @param {DayRecord} day @param {import('./model.js').Vehicle[]} vehicles @param {number} t
 */
export function foldVehicles(day, vehicles, t) {
  const counts = {};
  let total = 0;
  for (const v of vehicles ?? []) {
    if (!v || v.estimated) continue;
    const mode = modeOf(v);
    const c = (counts[mode] ??= [0, 0, 0]);
    c[0]++;
    total++;
    if (Number.isFinite(v.delay)) {
      c[1]++;
      if (v.delay >= LATE_MIN) c[2]++;
      (day.delays[mode] ??= new Array(DELAY_BINS).fill(0))[delayBin(v.delay)]++;
    }
    noteSource(day, v.source, v.operator);
  }
  const hour = (day.hours[String(madridHour(t))] ??= { n: 0, m: {} });
  hour.n++;
  for (const [mode, [n, withDelay, delayed]] of Object.entries(counts)) {
    const m = (hour.m[mode] ??= [0, 0, 0, 0]);
    m[0] += n;
    m[1] = Math.max(m[1], n);
    m[2] += withDelay;
    m[3] += delayed;
  }
  if (total && (!day.peak || total > day.peak.total)) day.peak = { t, total, byMode: Object.fromEntries(Object.entries(counts).map(([k, c]) => [k, c[0]])) };
  day.from ??= t;
  day.to = t;
}

function noteSource(day, source, operator) {
  if (!safeId(source)) return;
  let ops = day.sources[source];
  if (!ops) {
    if (Object.keys(day.sources).length >= DAY_LIMITS.sources) return;
    ops = day.sources[source] = [];
  }
  if (typeof operator === 'string' && operator && !ops.includes(operator) && ops.length < DAY_LIMITS.operators) ops.push(operator.slice(0, 80));
}

/** La primera clave de línea de una lista `follow`. */
const lineKeyOf = (follow) => (Array.isArray(follow) ? follow.find((k) => followKind(k) === 'linea') ?? null : null);

/** ¿Cuenta como aviso de emergencia del día? (y en qué grupo) */
function emergencyGroup(e, date, now) {
  const started = (e.start ?? e.issued ?? now) <= now;
  if (e.category === 'meteo') return started && LEVEL_RANK[e.level] >= 2 ? 'meteo' : null;
  if (e.category === 'sismo') return Number.isFinite(e.start) && madridDay(e.start) === date ? 'sismo' : null;
  if (e.category === 'emergencia') return started ? 'oficial' : null;
  if (e.category === 'catastrofe') return LEVEL_RANK[e.level] >= 2 ? 'gdacs' : null;
  return null;
}

function addOnce(day, list, id, make) {
  const all = day[list];
  if (Object.hasOwn(all, id)) return all[id];
  if (Object.keys(all).length >= DAY_LIMITS[list]) {
    day.truncated[list] = true;
    return null;
  }
  return (all[id] = make());
}

/**
 * Apunta las incidencias del momento que cuentan para el día: cancelaciones (también las que su fuente
 * ya no publica), trenes sin datos y avisos de emergencia en vigor. Cada una una vez por día.
 * @param {DayRecord} day @param {import('./model.js').IncidentEvent[]} events @param {number} now
 */
export function foldEvents(day, events, now) {
  for (const e of events ?? []) {
    if (!e || typeof e.id !== 'string' || e.id.length > 300 || !inForce(e, now)) continue;
    const t = e.trip ?? {};
    let entry = null;
    if (e.category === 'cancelacion') {
      entry = addOnce(day, 'cancellations', e.id, () => ({
        t: Number.isFinite(e.seen) ? e.seen : now, op: text(t.operator), mode: safeId(t.mode) ? t.mode : 'otros', svc: text(t.service),
        line: text(t.line), lk: lineKeyOf(t.follow), type: e.type === 'parcial' ? 'parcial' : 'cancelado',
      }));
      // Si pasa de paradas suprimidas a cancelado del todo (o al revés), cuenta lo último que publica.
      if (entry && !e.withdrawn) entry.type = e.type === 'parcial' ? 'parcial' : 'cancelado';
    } else if (e.category === 'sin-datos') {
      entry = addOnce(day, 'missing', e.id, () => ({
        t: Number.isFinite(e.seen) ? e.seen : now, op: text(t.operator), mode: safeId(t.mode) ? t.mode : 'otros', svc: text(t.service),
        line: text(t.line), num: text(t.number), lk: lineKeyOf(t.follow),
      }));
    } else {
      const group = emergencyGroup(e, day.date, now);
      if (group) {
        entry = addOnce(day, 'emergencies', e.id, () => ({
          g: group, level: text(e.level), title: text(e.title), area: text(e.area), mag: Number.isFinite(e.magnitude) ? e.magnitude : null,
          power: e.power === true, t: Number.isFinite(e.start) ? e.start : Number.isFinite(e.issued) ? e.issued : now,
          sev: SEVERITY_RANK[e.severity] ?? 0,
        }));
      }
    }
    if (entry && safeId(e.source) && typeof e.credit === 'string' && e.credit && !day.credits[e.source]
      && Object.keys(day.credits).length < DAY_LIMITS.sources) day.credits[e.source] = e.credit.slice(0, 400);
  }
}

/**
 * Apunta el nombre y la licencia de las fuentes contadas en el día (de `health`, la lista de fuentes del
 * radar), para citarlas por su nombre aunque otro día cambien o ya no estén. Las que `health` no conoce se
 * quedan como estaban.
 * @param {DayRecord} day @param {import('./model.js').SourceHealth[]} health
 */
export function noteSources(day, health) {
  const byId = new Map((health ?? []).map((h) => [h?.id, h]));
  for (const id of new Set([...Object.keys(day.sources), ...Object.keys(day.credits)])) {
    const h = byId.get(id);
    if (!h || typeof h.name !== 'string' || !h.name) continue;
    const seen = day.sources[id] ?? [];
    const operators = isObject(h.operatorLicenses)
      ? Object.fromEntries(seen.filter((o) => typeof h.operatorLicenses[o] === 'string').map((o) => [o, h.operatorLicenses[o].slice(0, 400)]))
      : null;
    day.attrib[id] = { name: h.name.slice(0, MAX_TEXT), license: typeof h.license === 'string' ? h.license.slice(0, 400) : null, operators };
  }
}

// ---------- El resumen ----------

const round1 = (x) => Math.round(x * 10) / 10;
const share = (part, whole) => (whole > 0 ? round1((100 * part) / whole) : null);
const modeOrder = (a, b) => {
  const ia = MODES.findIndex((m) => m.id === a);
  const ib = MODES.findIndex((m) => m.id === b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
};
const modeLabel = (id) => modeInfo(id)?.label ?? id;

/** Mediana de un histograma de retrasos (minutos). null si está vacío. Desde 15 min, el tramo («15–29»). */
export function medianDelay(bins) {
  const total = (bins ?? []).reduce((s, x) => s + x, 0);
  if (!total) return null;
  let seen = 0;
  for (let i = 0; i < bins.length; i++) {
    seen += bins[i];
    if (seen * 2 >= total) return i < 15 ? { minutes: i } : { from: [15, 30, 60][i - 15], to: [29, 59, null][i - 15] };
  }
  return null;
}

/**
 * Por horas, a partir del registro: muestras y, por tipo, media y máximo de vehículos y sus retrasos.
 * @returns {Map<number, { n: number, modes: Record<string, { avg: number, max: number, withDelay: number, delayed: number }> }>}
 */
function hoursFromRecord(record) {
  const out = new Map();
  for (const [h, hour] of Object.entries(record?.hours ?? {})) {
    if (!hour.n) continue;
    const modes = {};
    for (const [mode, [sum, max, withDelay, delayed]] of Object.entries(hour.m)) modes[mode] = { avg: sum / hour.n, max, withDelay, delayed };
    out.set(Number(h), { n: hour.n, modes, from: 'registro' });
  }
  return out;
}

/**
 * Lo mismo a partir de las filas de KPI del histórico (una por minuto): sólo los tipos que cuentan los
 * KPI (los vehículos ferroviarios con posición real; ver monitoredVehicles) y el retraso de todos juntos.
 */
function hoursFromKpis(rows) {
  const acc = new Map();
  for (const r of rows ?? []) {
    if (!isObject(r) || !Number.isFinite(r.t) || !isObject(r.byMode)) continue;
    const h = madridHour(r.t);
    const a = acc.get(h) ?? { n: 0, sums: {}, maxs: {}, withDelay: 0, delayed: 0 };
    a.n++;
    for (const [mode, c] of Object.entries(r.byMode)) {
      if (!safeId(mode) || !Number.isFinite(c)) continue;
      a.sums[mode] = (a.sums[mode] ?? 0) + c;
      a.maxs[mode] = Math.max(a.maxs[mode] ?? 0, c);
    }
    if (Number.isFinite(r.withDelayInfo)) a.withDelay += r.withDelayInfo;
    if (Number.isFinite(r.delayed)) a.delayed += r.delayed;
    acc.set(h, a);
  }
  const out = new Map();
  for (const [h, a] of acc) {
    const modes = {};
    for (const mode of Object.keys(a.sums)) modes[mode] = { avg: a.sums[mode] / a.n, max: a.maxs[mode] };
    out.set(h, { n: a.n, modes, withDelay: a.withDelay, delayed: a.delayed, from: 'kpi' });
  }
  return out;
}

/** Cada hora, del registro si lo tiene; si no (antes de que existiera el registro), de los KPI. */
function mergedHours(record, kpiRows) {
  const fromRecord = hoursFromRecord(record);
  const fromKpi = hoursFromKpis(kpiRows);
  const out = new Map(fromKpi);
  for (const [h, x] of fromRecord) out.set(h, x);
  return out;
}

const peakFromKpis = (rows) => {
  let best = null;
  for (const r of rows ?? []) {
    if (isObject(r) && Number.isFinite(r.t) && Number.isFinite(r.vehicles) && (!best || r.vehicles > best.total)) {
      best = { t: r.t, total: r.vehicles, byMode: isObject(r.byMode) ? r.byMode : {} };
    }
  }
  return best;
};

const counted = (entries, keyOf) => {
  const m = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
};
const topOf = (map, n) => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);

const nounLabel = (mode) => {
  const noun = modeInfo(mode)?.noun;
  return noun ? noun[0].toUpperCase() + noun.slice(1) : undefined;
};

/**
 * Nombre de lo que agrupa una clave de línea (una línea o, en AV/LD/MD, el producto), tal como lo da
 * describeFollow con lo que se sabe del viaje: «Cercanías C5 · Renfe (Madrid)», «AVE · Renfe».
 */
function lineName(e) {
  const modeLabel = nounLabel(e.mode);
  if (e.lk) return describeFollow(e.lk, { operator: e.op ?? undefined, service: e.svc ?? undefined, line: e.line ?? undefined, modeLabel });
  // Sin clave (las guardadas por versiones anteriores): con la misma forma, pero sin el ámbito, que no se sabe.
  const kind = e.svc && e.svc !== e.op ? e.svc : modeLabel ?? 'Línea';
  const line = e.line ?? (e.svc && e.svc !== e.op ? e.svc : null);
  if (!line) return e.op ?? 'Sin nombre';
  return `${kind === line ? line : `${kind} ${line}`} · ${e.op ?? '?'}`;
}

/** Cancelaciones o trenes sin datos agrupados por operador, por tipo y por línea (con su nombre). */
function grouped(entries, { withType = false } = {}) {
  const list = Object.values(entries);
  // Las que no traen clave (guardadas por versiones anteriores) van con la de su línea si sólo hay una con
  // ese operador, servicio y línea; si hay varias (C1 de Madrid y C1 de Valencia), aparte, porque sin la
  // clave no se sabe de qué núcleo es.
  const triple = (e) => `${e.op ?? '?'}|${e.svc ?? ''}|${e.line ?? ''}`;
  const keysOf = new Map();
  for (const e of list) if (e.lk) keysOf.set(triple(e), new Set([...(keysOf.get(triple(e)) ?? []), e.lk]));
  const byLine = new Map();
  for (const raw of list) {
    const only = !raw.lk && keysOf.get(triple(raw))?.size === 1 ? [...keysOf.get(triple(raw))][0] : null;
    const e = only ? { ...raw, lk: only } : raw;
    const key = e.lk ?? triple(e);
    const g = byLine.get(key) ?? { key: e.lk ?? null, name: lineName(e), operator: e.op ?? null, mode: e.mode, n: 0, partial: 0 };
    g.n++;
    if (e.type === 'parcial') g.partial++;
    byLine.set(key, g);
  }
  const lines = [...byLine.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, TOP_LINES).map((g) => ({
    key: g.key, name: g.name, operator: g.operator, mode: g.mode, n: g.n, ...(withType ? { partial: g.partial } : {}),
  }));
  const byMode = topOf(counted(list, (e) => e.mode), 20).sort((a, b) => modeOrder(a[0], b[0])).map(([id, n]) => ({ id, label: modeLabel(id), n }));
  return {
    total: list.length,
    ...(withType ? { whole: list.filter((e) => e.type !== 'parcial').length, partial: list.filter((e) => e.type === 'parcial').length } : {}),
    byOperator: topOf(counted(list, (e) => e.op), TOP_OPERATORS).map(([name, n]) => ({ name, n })),
    operators: counted(list, (e) => e.op).size,
    byMode,
    byLine: lines,
  };
}

/** Las alertas del día (las filas «nueva» del histórico de alertas); null si no se sabe. */
function alertsOf(rows) {
  if (!Array.isArray(rows)) return null;
  const opened = new Map();
  for (const r of rows ?? []) {
    if (!isObject(r) || typeof r.id !== 'string' || (r.event !== 'nueva' && r.event !== 'escalada')) continue;
    const prev = opened.get(r.id);
    const sev = SEVERITY_RANK[r.severity] ?? 0;
    if (!prev || sev > prev.rank) opened.set(r.id, { title: text(r.title), severity: text(r.severity), rank: sev, since: Number.isFinite(r.since) ? r.since : null, type: text(r.type) });
  }
  const list = [...opened.values()];
  const bySeverity = Object.fromEntries(['muy alta', 'alta', 'media', 'baja'].map((s) => [s, list.filter((a) => a.severity === s).length]).filter(([, n]) => n));
  // Una misma situación (mismo título) que se abre y se cierra varias veces sale una vez, con cuántas: si no, las
  // más graves serían ocho veces el mismo tren detenido.
  const same = new Map();
  for (const a of list.sort((x, y) => y.rank - x.rank || (x.since ?? 0) - (y.since ?? 0))) {
    const prev = same.get(a.title);
    if (prev) prev.times++;
    else same.set(a.title, { title: a.title, severity: a.severity, since: a.since, times: 1 });
  }
  const top = [...same.values()].slice(0, TOP_ALERTS);
  return { total: list.length, situations: same.size, bySeverity, top };
}

function emergenciesOf(entries) {
  const list = Object.values(entries ?? {});
  const of = (g) => list.filter((e) => e.g === g);
  const meteo = of('meteo');
  const quakes = of('sismo').sort((a, b) => (b.mag ?? 0) - (a.mag ?? 0));
  const official = of('oficial');
  const gdacs = of('gdacs');
  const item = (e) => ({ title: e.title, area: e.area, ...(e.level ? { level: e.level } : {}), ...(Number.isFinite(e.mag) ? { magnitude: e.mag } : {}), t: e.t });
  const byLevel = (a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0) || (a.t ?? 0) - (b.t ?? 0);
  return {
    meteo: { total: meteo.length, rojo: meteo.filter((e) => e.level === 'rojo').length, naranja: meteo.filter((e) => e.level === 'naranja').length,
      top: meteo.sort(byLevel).slice(0, TOP_EMERGENCIES).map(item) },
    sismos: { total: quakes.length, felt: quakes.filter((e) => (e.mag ?? 0) >= 3).length, top: quakes.slice(0, 5).map(item) },
    oficiales: { total: official.length, power: official.filter((e) => e.power).length,
      top: official.sort((a, b) => b.sev - a.sev || (a.t ?? 0) - (b.t ?? 0)).slice(0, TOP_EMERGENCIES).map(item) },
    gdacs: { total: gdacs.length, top: gdacs.sort(byLevel).slice(0, 3).map(item) },
  };
}

/**
 * Las fuentes de las cifras con la atribución que pide su licencia: las de los vehículos contados (de
 * `health`: su nombre y su licencia, o la de cada operador si agrupa a varios) y las de las incidencias.
 */
function creditsOf(record, health) {
  // Lo apuntado ese día manda; si no, lo que hay ahora en la lista de fuentes.
  const bySource = new Map((health ?? []).map((s) => [s.id, s]));
  for (const [id, a] of Object.entries(record?.attrib ?? {})) {
    bySource.set(id, { id, name: a.name, license: a.license, operatorLicenses: a.operators });
  }
  const out = new Map();
  const add = (name, credit) => {
    if (!credit) return;
    const prev = out.get(credit);
    if (prev) prev.names.add(name);
    else out.set(credit, { names: new Set([name]), credit });
  };
  for (const [id, operators] of Object.entries(record?.sources ?? {})) {
    const s = bySource.get(id);
    if (!s) continue;
    const perOperator = isObject(s.operatorLicenses) ? operators.map((o) => s.operatorLicenses[o]).filter(Boolean) : [];
    if (perOperator.length) for (const c of perOperator) add(s.name, c);
    else add(s.name, s.license);
  }
  // De una incidencia se cita lo que ella dice; el nombre, el de su fuente (su id sólo si no se sabe).
  for (const [id, credit] of Object.entries(record?.credits ?? {})) add(bySource.get(id)?.name || id, credit);
  const byName = (a, b) => a.localeCompare(b, 'es');
  return [...out.values()].map(({ names, credit }) => ({ names: [...names].sort(byName), credit })).sort((a, b) => byName(a.names[0], b.names[0]));
}

/**
 * El resumen de un día, listo para la API (/api/dia).
 * @param {{ date: string, now: number, today: boolean, record: DayRecord|null, kpiRows?: object[], alertRows?: object[]|null,
 *           compare?: { date: string, record: DayRecord|null, kpiRows?: object[] }|null, days?: string[],
 *           health?: import('./model.js').SourceHealth[] }} input
 *   days: los días con datos (para pasar de uno a otro); health: nombres y licencias de las fuentes.
 *   alertRows null: no se sabe (aún no se ha leído el histórico); entonces las alertas salen null, no 0. Lo
 *   mismo las cancelaciones, los trenes sin datos y los avisos de un día sin registro: null, no 0.
 * @returns {object|null}  null si de ese día no hay nada
 */
export function summarizeDay({ date, now, today, record, kpiRows = [], alertRows = [], compare = null, days = [], health = [] }) {
  const hours = mergedHours(record, kpiRows);
  const alerts = alertsOf(alertRows);
  const hasEvents = record && (Object.keys(record.cancellations).length || Object.keys(record.missing).length || Object.keys(record.emergencies).length);
  if (!hours.size && !alerts?.total && !hasEvents) return null;

  const lastHour = today ? madridHour(now) : 23;
  const modes = new Set();
  for (const x of hours.values()) for (const m of Object.keys(x.modes)) modes.add(m);
  const compareHours = compare ? mergedHours(compare.record, compare.kpiRows) : new Map();
  const series = (map, mode, field) => Array.from({ length: 24 }, (_, h) => {
    const x = map.get(h);
    if (!x || (map === hours && h > lastHour)) return null;
    const v = x.modes[mode]?.[field];
    // Sin ese tipo en una hora con muestras del registro: ninguno visto. De los KPI, sólo los que cuentan.
    if (v === undefined) return x.from === 'kpi' && !KPI_MODES.has(mode) ? null : 0;
    return Math.round(v * 10) / 10;
  });
  const vehicleModes = [...modes].sort(modeOrder).map((id) => {
    const info = modeInfo(id);
    const max = Math.max(0, ...[...hours.values()].map((x) => x.modes[id]?.max ?? 0));
    const ownDelays = record?.delays?.[id];
    const withDelay = [...hours.values()].reduce((s, x) => s + (x.modes[id]?.withDelay ?? 0), 0);
    const delayed = [...hours.values()].reduce((s, x) => s + (x.modes[id]?.delayed ?? 0), 0);
    return {
      id, label: info?.label ?? id, noun: info?.noun ?? 'vehículo', nounPlural: info?.nounPlural ?? 'vehículos', family: info?.family ?? 'otros',
      max, hourly: series(hours, id, 'avg'),
      compare: compareHours.size >= MIN_COMPARE_HOURS ? series(compareHours, id, 'avg') : null,
      delay: withDelay ? { lateShare: share(delayed, withDelay), median: medianDelay(ownDelays) } : null,
    };
  });

  // Retraso de todos juntos, por horas: del registro (todos los tipos) o de los KPI (los ferroviarios).
  const hourDelay = (x) => {
    if (x.from === 'kpi') return { withDelay: x.withDelay, delayed: x.delayed };
    return Object.values(x.modes).reduce((a, m) => ({ withDelay: a.withDelay + m.withDelay, delayed: a.delayed + m.delayed }), { withDelay: 0, delayed: 0 });
  };
  const lateHourly = Array.from({ length: 24 }, (_, h) => {
    const x = hours.get(h);
    if (!x || h > lastHour) return null;
    const d = hourDelay(x);
    return d.withDelay && d.withDelay / Math.max(1, x.n) >= MIN_LATE_SAMPLE ? share(d.delayed, d.withDelay) : null;
  });
  const dayDelay = [...hours.values()].reduce((a, x) => {
    const d = hourDelay(x);
    return { withDelay: a.withDelay + d.withDelay, delayed: a.delayed + d.delayed };
  }, { withDelay: 0, delayed: 0 });
  const allBins = Object.values(record?.delays ?? {}).reduce((acc, b) => acc.map((x, i) => x + b[i]), new Array(DELAY_BINS).fill(0));

  const kpiTimes = (kpiRows ?? []).filter((r) => Number.isFinite(r?.t)).map((r) => r.t);
  const fromRecord = [...hours.values()].filter((x) => x.from === 'registro').length;
  const fromKpi = [...hours.values()].filter((x) => x.from === 'kpi').length;
  const sorted = [...days].filter(isDay).sort().reverse();
  return {
    date,
    today,
    generatedAt: now,
    // Hasta cuándo llega: el día en curso, hasta ahora; uno pasado, entero.
    coverage: {
      from: record?.from ?? (kpiTimes.length ? kpiTimes.reduce((a, b) => Math.min(a, b)) : null),
      to: record?.to ?? (kpiTimes.length ? kpiTimes.reduce((a, b) => Math.max(a, b)) : null),
      // Horas con el registro (todos los tipos) y horas sólo con los KPI (los ferroviarios con posición real).
      hoursAllModes: fromRecord,
      hoursRailOnly: fromKpi,
      incidents: Boolean(record),
    },
    vehicles: {
      peak: record?.peak ?? peakFromKpis(kpiRows),
      modes: vehicleModes,
      compareDate: compareHours.size >= MIN_COMPARE_HOURS ? compare?.date ?? null : null,
    },
    delay: {
      lateMin: LATE_MIN,
      lateShare: share(dayDelay.delayed, dayDelay.withDelay),
      median: medianDelay(allBins),
      hourly: lateHourly,
    },
    cancellations: record ? grouped(record.cancellations, { withType: true }) : null,
    missing: record ? grouped(record.missing) : null,
    alerts,
    emergencies: record ? emergenciesOf(record.emergencies) : null,
    truncated: Object.keys(record?.truncated ?? {}),
    credits: creditsOf(record, health),
    days: sorted,
    prev: sorted.find((d) => d < date) ?? null,
    next: [...sorted].reverse().find((d) => d > date) ?? null,
  };
}

// Los tipos que cuentan los KPI (domain/model.js, monitoredVehicles): de las horas sólo con KPI, el resto
// no se sabe (null), no es cero.
const KPI_MODES = new Set(MODES.filter((m) => m.family === 'ferrocarril' || m.id === 'otros').map((m) => m.id));
