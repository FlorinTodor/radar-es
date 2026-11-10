// Puntualidad histórica de lo que se puede seguir (domain/seguir.js) de cualquier tipo de vehículo cuyo
// operador publique su retraso: trenes, autobuses, metros, tranvías y los que vengan. No sabe de fuentes
// ni de tipos: sólo usa las claves `follow` de cada vehículo y de cada cancelación, y su retraso.
// Puro: sin red, ni reloj, ni disco (la hora y lo que se guarda los pone el caso de uso record-punctuality).
//
// Qué se guarda, por día de servicio en Madrid y durante KEEP_DAYS días:
// - De cada servicio (clave s-…): el último retraso conocido, el máximo y si su operador lo dio por
//   cancelado o con paradas suprimidas. El último retraso es el de su llegada: un servicio que lleva
//   RUN_END_MS sin verse ha llegado (o ha desaparecido del tiempo real de su operador antes de llegar, que
//   para el radar es lo mismo) y su último retraso cuenta como el de su llegada. Si vuelve a verse antes
//   de RUN_GAP_MS, era un hueco en los datos y sigue el mismo recorrido; después, es otro recorrido.
//   El día de un recorrido es el de su primera lectura: un tren que sale a las 23:30 y llega pasada la
//   medianoche cuenta en el día en que salió.
// - De cada línea (clave l-…), por día: cuántas lecturas con dato de retraso hubo y cuántas con LATE_MIN
//   minutos o más, cuántos vehículos distintos se vieron, cuántos servicios acabaron y cuántos tarde, el
//   máximo y cuántas cancelaciones. Así hay puntualidad también para los autobuses y metros que no tienen
//   un servicio reconocible de un día a otro.
//
// «Tarde» es LATE_MIN minutos o más, como en los indicadores del radar (domain/kpis.js).
//
// Memoria: todo en arrays tipados, con un hueco por clave y día (un anillo de KEEP_DAYS días): 4 bytes por
// servicio y día y 21 por línea y día. Lo que se sabe de cada clave (operador, origen…) va por columnas de
// índices a una tabla de textos que se comparte. Con tope de claves (MAX_SERVICES, MAX_LINES): las que
// llevan KEEP_DAYS sin verse dejan su sitio a otras. Para el disco, sólo copias de los arrays (snapshot):
// así guardar no para el servidor.

import { followKind } from './seguir.js';

export const LATE_MIN = 5;
export const KEEP_DAYS = 60;
export const RUN_END_MS = 15 * 60_000;
export const RUN_GAP_MS = 2 * 3600_000;
export const MAX_SERVICES = 80_000;
export const MAX_LINES = 8_000;
/** Días que da el informe de una clave (la tira de la ficha enseña los últimos). */
export const REPORT_DAYS = 30;
/** «7 de los últimos 10 días en que circuló». */
export const RECENT_DAYS = 10;
const VERSION = 1;
// Textos distintos (operadores, paradas de origen y destino, números…) antes de rehacer su tabla sin los
// que ya no usa ninguna clave.
const STRINGS_MAX = 100_000;

const NONE = -32768; // sin retraso en ese día
const MAX_CAP = 250; // el máximo se guarda en un byte: 250 quiere decir «250 min o más»
const F_SEEN = 1;      // se vio con su retraso
const F_CANCELLED = 2; // su operador lo dio por cancelado
const F_PARTIAL = 4;   // su operador suprimió alguna parada
const F_ENDED = 8;     // su recorrido ha acabado: el último retraso es el de su llegada

// ---------- Días de servicio en Madrid ----------

const MADRID_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Día de Madrid de un instante (epoch ms), como número de días desde el 1-1-1970. */
export function madridDay(ms) {
  const p = {};
  for (const { type, value } of MADRID_DATE.formatToParts(ms)) p[type] = value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86_400_000;
}

/** «AAAA-MM-DD» de un número de día. */
export const dayIso = (day) => new Date(day * 86_400_000).toISOString().slice(0, 10);

/** Número de día de un «AAAA-MM-DD»; null si no lo es. */
export function isoDay(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? ms / 86_400_000 : null;
}

// ---------- Ayudas ----------

/** Huella de 32 bits (FNV-1a) de un texto: para contar distintos sin guardar los textos. */
function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Retraso en minutos enteros, si el operador lo publica (las posiciones estimadas sólo por horario no lo traen). */
const delayOf = (v) => (Number.isFinite(v?.delay) ? Math.round(v.delay) : null);
const capped = (minutes) => Math.max(0, Math.min(MAX_CAP, minutes));
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
const inc16 = (a, o, by = 1) => { a[o] = Math.min(0xffff, Math.max(0, a[o] + by)); };

/**
 * Tabla de textos compartida: cada texto una vez, y en las columnas su número (0: ninguno).
 */
function createStrings() {
  let list = [null];
  let ids = new Map();
  return {
    ref(s) {
      if (s === null || s === undefined) return 0;
      let k = ids.get(s);
      if (k === undefined) {
        k = list.length;
        list.push(s);
        ids.set(s, k);
      }
      return k;
    },
    get: (k) => list[k] ?? null,
    size: () => list.length - 1,
    /** Para el disco: los textos en uno solo (no llevan U+0000). */
    pack: () => list.slice(1).join('\u0000'),
    unpack(joined) {
      if (typeof joined !== 'string') return false;
      list = [null, ...(joined ? joined.split('\u0000') : [])];
      ids = new Map(list.map((s, k) => [s, k]).slice(1));
      return true;
    },
    /** Rehace la tabla con los textos que usan las columnas `cols` (las cambia a los números nuevos). */
    compact(cols) {
      const fresh = createStrings();
      for (const col of cols) for (let i = 0; i < col.length; i++) col[i] = fresh.ref(list[col[i]] ?? null);
      ({ list, ids } = fresh.internals());
    },
    internals: () => ({ list, ids }),
  };
}

/**
 * Tabla de claves con un hueco por día para cada una (un anillo de `keep` días). `lastDay` es el último
 * día escrito de cada clave: al escribir uno más reciente se vacían los huecos de los días que se ha
 * saltado, y al leer sólo valen los de los `keep` días hasta `lastDay`. Lo que se sabe de cada clave va
 * en columnas (`metaFields`) de números de la tabla de textos `strings`.
 */
function createTable({ fields, metaFields, keep, max, strings, cap: wanted = 256 }) {
  const cap = Math.max(1, Math.min(wanted, max));
  const t = {
    keys: [], // índice → clave (null: hueco libre)
    index: new Map(), // clave → índice
    free: [],
    cap,
    known: new Uint8Array(cap), // 1 si se sabe algo de ella (sus columnas)
    firstDay: new Int32Array(cap),
    lastDay: new Int32Array(cap),
    cols: Object.fromEntries(metaFields.map((f) => [f, new Uint32Array(cap)])),
    data: Object.fromEntries(Object.entries(fields).map(([name, { type }]) => [name, new type(cap * keep)])),
  };
  const empty = Object.fromEntries(Object.entries(fields).map(([name, f]) => [name, f.empty ?? 0]));

  const clear = (offset) => {
    for (const name in empty) t.data[name][offset] = empty[name];
  };
  const resized = (old, size) => {
    const a = new old.constructor(size);
    a.set(old.length > size ? old.subarray(0, size) : old);
    return a;
  };
  // Crece un 50 % cada vez: al doble, con 40.000 servicios se reservaba sitio para 65.536.
  const grow = (to = Math.min(max, Math.ceil(t.cap * 1.5))) => {
    t.known = resized(t.known, to);
    t.firstDay = resized(t.firstDay, to);
    t.lastDay = resized(t.lastDay, to);
    for (const f in t.cols) t.cols[f] = resized(t.cols[f], to);
    for (const name in t.data) t.data[name] = resized(t.data[name], to * keep);
    t.cap = to;
  };

  return {
    t,
    /** Índice de una clave; con `create`, la da de alta si hay sitio (-1 si no). */
    idx(key, create = false) {
      const known = t.index.get(key);
      if (known !== undefined || !create) return known ?? -1;
      let i = t.free.pop();
      if (i === undefined) {
        if (t.keys.length >= t.cap) {
          if (t.cap >= max) return -1;
          grow();
        }
        i = t.keys.length;
        t.keys.push(null);
      }
      t.keys[i] = key;
      t.index.set(key, i);
      t.known[i] = 0;
      for (const f in t.cols) t.cols[f][i] = 0;
      t.firstDay[i] = 0;
      t.lastDay[i] = 0;
      for (let d = 0; d < keep; d++) clear(i * keep + d);
      return i;
    },
    hasMeta: (i) => t.known[i] === 1,
    /** Lo que se sabe de la clave `i`, como objeto. */
    meta(i) {
      const out = {};
      for (const f of metaFields) out[f] = strings.get(t.cols[f][i]);
      return out;
    },
    setMeta(i, m) {
      for (const f of metaFields) t.cols[f][i] = strings.ref(m[f] ?? null);
      t.known[i] = 1;
    },
    /** Posición del hueco de `day` para escribir (avanzando `lastDay`), o -1 si el día ya no se guarda. */
    slot(i, day) {
      const last = t.lastDay[i];
      if (!t.firstDay[i]) {
        t.firstDay[i] = day;
        t.lastDay[i] = day;
      } else if (day > last) {
        for (let d = last + 1; d <= day && d <= last + keep; d++) clear(i * keep + (d % keep));
        t.lastDay[i] = day;
      } else if (day <= last - keep) return -1;
      if (day < t.firstDay[i]) t.firstDay[i] = day;
      return i * keep + (day % keep);
    },
    /** Posición del hueco de `day` para leer, o -1 si no hay nada de ese día. */
    read(i, day) {
      const last = t.lastDay[i];
      if (!t.firstDay[i] || day > last || day <= last - keep || day < t.firstDay[i]) return -1;
      return i * keep + (day % keep);
    },
    /** Deja libres las claves que llevan `keep` días sin escribirse. */
    prune(today) {
      let freed = 0;
      for (let i = 0; i < t.keys.length; i++) {
        if (t.keys[i] !== null && t.lastDay[i] <= today - keep) {
          t.index.delete(t.keys[i]);
          t.keys[i] = null;
          t.known[i] = 0;
          for (const f in t.cols) t.cols[f][i] = 0;
          t.free.push(i);
          freed++;
        }
      }
      return freed;
    },
    size: () => t.index.size,
    columns: () => Object.values(t.cols).map((c) => c.subarray(0, t.keys.length)),

    /** Para el disco: copias de lo usado de cada array y las claves en un solo texto (no llevan «\n»). */
    pack() {
      const used = t.keys.length;
      return {
        used, keys: t.keys.map((k) => k ?? '').join('\n'),
        known: t.known.slice(0, used), firstDay: t.firstDay.slice(0, used), lastDay: t.lastDay.slice(0, used),
        cols: Object.fromEntries(Object.entries(t.cols).map(([f, c]) => [f, c.slice(0, used)])),
        data: Object.fromEntries(Object.entries(t.data).map(([name, a]) => [name, a.slice(0, used * keep)])),
      };
    },

    /** Vuelve a lo que dio pack() (con la tabla de textos ya recuperada); false si no vale. */
    unpack(s, stringCount) {
      const used = s?.used;
      if (!Number.isInteger(used) || used < 0 || used > max || typeof s.keys !== 'string') return false;
      const keys = used ? s.keys.split('\n') : [];
      if (keys.length !== used) return false;
      const typed = (a, type, size) => a instanceof type && a.length === size;
      if (!typed(s.known, Uint8Array, used) || !typed(s.firstDay, Int32Array, used) || !typed(s.lastDay, Int32Array, used)) return false;
      for (const [name, { type }] of Object.entries(fields)) if (!typed(s.data?.[name], type, used * keep)) return false;
      for (const f of metaFields) if (!typed(s.cols?.[f], Uint32Array, used) || s.cols[f].some((k) => k > stringCount)) return false;
      if (used > t.cap) grow(Math.min(max, Math.max(used, Math.ceil(used * 1.25))));
      t.known.set(s.known);
      t.firstDay.set(s.firstDay);
      t.lastDay.set(s.lastDay);
      for (const f of metaFields) t.cols[f].set(s.cols[f]);
      for (const name in t.data) t.data[name].set(s.data[name]);
      keys.forEach((k, i) => {
        const key = k || null;
        t.keys.push(key);
        if (key) t.index.set(key, i);
        else t.free.push(i);
      });
      return true;
    },
  };
}

const SERVICE_FIELDS = {
  last: { type: Int16Array, empty: NONE },
  max: { type: Uint8Array },
  flags: { type: Uint8Array },
};
const LINE_FIELDS = {
  samples: { type: Uint32Array },
  late: { type: Uint32Array },
  vehicles: { type: Uint16Array },
  finished: { type: Uint16Array },
  finishedLate: { type: Uint16Array },
  cancelled: { type: Uint16Array },
  max: { type: Uint8Array },
};
const LINE_META = ['operator', 'mode', 'source', 'service', 'line'];
const SERVICE_META = [...LINE_META, 'number', 'origin', 'destination', 'lineKey'];

const metaOf = (src, extra = {}) => ({
  operator: text(src.operator), mode: text(src.mode), source: text(src.source), service: text(src.service),
  line: text(src.line), number: text(src.number ?? src.label), origin: text(src.origin), destination: text(src.destination),
  ...extra,
});

/**
 * El libro de la puntualidad: lo que se ha visto de cada servicio y de cada línea, día a día.
 * @param {{ keep?: number, maxServices?: number, maxLines?: number }} [opts]
 */
export function createPunctualityBook({ keep = KEEP_DAYS, maxServices = MAX_SERVICES, maxLines = MAX_LINES } = {}) {
  let strings = createStrings();
  const newServices = () => createTable({ fields: SERVICE_FIELDS, metaFields: SERVICE_META, keep, max: maxServices, strings });
  const newLines = () => createTable({ fields: LINE_FIELDS, metaFields: LINE_META, keep, max: maxLines, strings });
  let services = newServices();
  let lines = newLines();
  let since = 0; // primer día que se guardó algo
  let day = 0; // día de Madrid de la última lectura
  let runs = new Map(); // clave de servicio → { day, lastSeen, line, ended, outcome }
  let lineVehicles = new Map(); // índice de línea → huellas de los vehículos vistos hoy en ella
  let cancelledToday = new Set(); // huellas de las cancelaciones ya contadas hoy en sus líneas
  const full = { services: false, lines: false };

  /** Cambio de día: lo de «hoy» empieza de cero y se liberan las claves que ya no se guardan. */
  function advance(today) {
    if (today <= day) return; // el reloj no vuelve atrás: un día anterior no borra lo de hoy
    day = today;
    since ||= today;
    lineVehicles = new Map();
    cancelledToday = new Set();
    services.prune(today);
    lines.prune(today);
    if (strings.size() > STRINGS_MAX) strings.compact([...services.columns(), ...lines.columns()]);
  }

  function lineIdx(key, src) {
    const i = lines.idx(key, true);
    if (i < 0) {
      full.lines = true;
      return -1;
    }
    if (src && !lines.hasMeta(i)) lines.setMeta(i, metaOf(src));
    return i;
  }

  /** Índice de un servicio; con `refresh` (o si no se sabía nada de él), lo último que se sabe de su viaje. */
  function serviceIdx(key, src, lineKey, refresh) {
    const i = services.idx(key, true);
    if (i < 0) {
      full.services = true;
      return -1;
    }
    // Su origen o su destino pueden cambiar de un día a otro: se toman al empezar cada recorrido.
    if (src && (refresh || !services.hasMeta(i))) services.setMeta(i, metaOf(src, { lineKey: lineKey ?? services.meta(i).lineKey }));
    return i;
  }

  /** Suma (o resta, `sign` -1) un recorrido acabado a su línea, en el día del recorrido. */
  function countFinished(run, sign) {
    if (!run.line || !run.outcome) return;
    const li = lines.idx(run.line);
    const o = li < 0 ? -1 : lines.slot(li, run.day);
    if (o < 0) return;
    inc16(lines.t.data.finished, o, sign);
    if (run.outcome === 2) inc16(lines.t.data.finishedLate, o, sign);
  }

  /**
   * Cómo fue un día: cancelado; en curso (su recorrido no ha acabado); tarde o a tiempo, por su último
   * retraso; con paradas suprimidas y sin lecturas; o sin dato.
   */
  function dayStatus(flags, last, inProgress) {
    if (flags & F_CANCELLED) return 'cancelado';
    if (flags & F_SEEN) {
      if (inProgress) return 'en-curso';
      return last >= LATE_MIN ? 'tarde' : 'a-tiempo';
    }
    if (flags & F_PARTIAL) return 'parcial';
    return 'sin-dato';
  }

  function valueAt(i, d, field) {
    const o = services.read(i, d);
    const v = o < 0 ? NONE : services.t.data[field][o];
    return v === NONE ? null : v;
  }

  function serviceReport(key, today) {
    const i = services.idx(key);
    if (i < 0) return null;
    const { last, max, flags } = services.t.data;
    const run = runs.get(key);
    // El recorrido que aún no ha acabado: su último retraso todavía no es el de su llegada.
    const openDay = run && !run.ended ? run.day : null;
    const days = [];
    for (let d = today - REPORT_DAYS + 1; d <= today; d++) {
      const o = services.read(i, d);
      const f = o < 0 ? 0 : flags[o];
      const entry = { day: dayIso(d), status: dayStatus(f, o < 0 ? NONE : last[o], d === openDay) };
      if (o >= 0 && last[o] !== NONE) {
        entry.delay = last[o];
        entry.max = max[o];
      }
      if (f & F_PARTIAL && !(f & F_CANCELLED)) entry.partial = true;
      days.push(entry);
    }
    // Todos los días guardados, no sólo los del informe: «7 de los últimos 10 días en que circuló».
    let ran = 0;
    let late = 0;
    let cancelled = 0;
    const recent = { days: 0, late: 0, cancelled: 0 };
    for (let d = today; d > today - keep; d--) {
      const o = services.read(i, d);
      if (o < 0) continue;
      const f = flags[o];
      const isCancelled = Boolean(f & F_CANCELLED);
      const ranThatDay = !isCancelled && Boolean(f & F_SEEN) && d !== openDay;
      if (!isCancelled && !ranThatDay) continue;
      const isLate = ranThatDay && last[o] >= LATE_MIN;
      if (isCancelled) cancelled++;
      else ran++;
      if (isLate) late++;
      if (recent.days < RECENT_DAYS) {
        recent.days++;
        if (isCancelled) recent.cancelled++;
        if (isLate) recent.late++;
      }
    }
    const meta = services.meta(i);
    return {
      key,
      kind: 'servicio',
      ...metaOut(meta),
      lineKey: meta.lineKey,
      lateMinutes: LATE_MIN,
      since: dayIso(since || services.t.firstDay[i]),
      firstSeen: dayIso(services.t.firstDay[i]),
      keepDays: keep,
      days,
      summary: { ran, late, cancelled },
      recent,
      ...(openDay !== null ? { now: { day: dayIso(openDay), delay: valueAt(i, openDay, 'last'), max: valueAt(i, openDay, 'max') } } : {}),
    };
  }

  function lineReport(key, today) {
    const i = lines.idx(key);
    if (i < 0) return null;
    const d = lines.t.data;
    const days = [];
    const total = { samples: 0, late: 0, finished: 0, finishedLate: 0, cancelled: 0, days: 0 };
    for (let n = today - REPORT_DAYS + 1; n <= today; n++) {
      const o = lines.read(i, n);
      if (o < 0 || (!d.samples[o] && !d.cancelled[o])) {
        days.push({ day: dayIso(n), samples: 0 });
        continue;
      }
      days.push({
        day: dayIso(n),
        samples: d.samples[o],
        late: d.late[o],
        lateShare: d.samples[o] ? Math.round((d.late[o] / d.samples[o]) * 1000) / 1000 : null,
        vehicles: d.vehicles[o],
        finished: d.finished[o],
        finishedLate: d.finishedLate[o],
        cancelled: d.cancelled[o],
        ...(d.samples[o] ? { max: d.max[o] } : {}),
      });
      if (n < today) {
        total.samples += d.samples[o];
        total.late += d.late[o];
        total.finished += d.finished[o];
        total.finishedLate += d.finishedLate[o];
        total.cancelled += d.cancelled[o];
        total.days++;
      }
    }
    return {
      key,
      kind: 'linea',
      ...metaOut(lines.meta(i)),
      lateMinutes: LATE_MIN,
      since: dayIso(since || lines.t.firstDay[i]),
      firstSeen: dayIso(lines.t.firstDay[i]),
      keepDays: keep,
      days,
      // Los días del informe anteriores a hoy, juntos (hoy aún no ha acabado).
      summary: { ...total, lateShare: total.samples ? Math.round((total.late / total.samples) * 1000) / 1000 : null },
    };
  }

  return {
    /**
     * Las lecturas de vehículos: los que traen su retraso y sus claves. Quien llama sólo da los de fuentes
     * al día (las de una fuente caída no son lecturas nuevas).
     * @param {Iterable<import('./model.js').Vehicle>} vehicles @param {number} now
     */
    observe(vehicles, now) {
      const today = madridDay(now);
      advance(today);
      for (const v of vehicles) {
        const delay = delayOf(v);
        if (delay === null || !Array.isArray(v.follow) || !v.follow.length) continue;
        const serviceKey = v.follow.find((k) => followKind(k) === 'servicio') ?? null;
        const lineKey = v.follow.find((k) => followKind(k) === 'linea') ?? null;
        if (lineKey) {
          const li = lineIdx(lineKey, v);
          const o = li < 0 ? -1 : lines.slot(li, today);
          if (o >= 0) {
            const d = lines.t.data;
            d.samples[o]++;
            if (delay >= LATE_MIN) d.late[o]++;
            if (capped(delay) > d.max[o]) d.max[o] = capped(delay);
            let ids = lineVehicles.get(li);
            if (!ids) lineVehicles.set(li, (ids = new Set()));
            const h = hash32(String(v.id));
            if (!ids.has(h)) {
              ids.add(h);
              inc16(d.vehicles, o);
            }
          }
        }
        if (!serviceKey) continue;
        let run = runs.get(serviceKey);
        const startsRun = !run || now - run.lastSeen > RUN_GAP_MS;
        if (startsRun) {
          run = { day: today, lastSeen: now, line: lineKey, ended: false, outcome: 0 };
          runs.set(serviceKey, run);
        } else if (run.ended) {
          // Vuelve tras un hueco: no había llegado. Se quita de lo contado en su línea.
          countFinished(run, -1);
          run.ended = false;
          run.outcome = 0;
        }
        run.lastSeen = now;
        run.line = lineKey ?? run.line;
        const si = serviceIdx(serviceKey, v, lineKey, startsRun);
        const o = si < 0 ? -1 : services.slot(si, run.day);
        if (o < 0) continue;
        const d = services.t.data;
        d.last[o] = delay;
        if (capped(delay) > d.max[o]) d.max[o] = capped(delay);
        d.flags[o] = (d.flags[o] | F_SEEN) & ~F_ENDED;
      }
    },

    /**
     * Las cancelaciones (incidencias de categoría «cancelacion» con su viaje): las de servicio se apuntan
     * en su día; cada una cuenta una vez al día en sus líneas.
     * @param {Iterable<import('./model.js').IncidentEvent>} events @param {number} now
     */
    cancellations(events, now) {
      const today = madridDay(now);
      advance(today);
      for (const e of events) {
        const t = e?.trip;
        if (e?.category !== 'cancelacion' || !Array.isArray(t?.follow)) continue;
        const onDay = isoDay(t.date) ?? today;
        if (onDay > today + 1 || onDay <= today - keep) continue;
        const flag = e.type === 'cancelado' ? F_CANCELLED : F_PARTIAL;
        const lineKey = t.follow.find((k) => followKind(k) === 'linea') ?? null;
        const h = hash32(String(e.id));
        const first = !cancelledToday.has(h);
        cancelledToday.add(h);
        for (const key of t.follow) {
          const kind = followKind(key);
          if (kind === 'servicio') {
            // Uno que nunca se vio circular: lo que dice su viaje (su número, su origen y su destino).
            const si = serviceIdx(key, { ...t, source: e.source }, lineKey, false);
            const o = si < 0 ? -1 : services.slot(si, onDay);
            if (o >= 0) services.t.data.flags[o] |= flag;
          } else if (kind === 'linea' && first) {
            const li = lineIdx(key, { ...t, source: e.source });
            const o = li < 0 ? -1 : lines.slot(li, onDay);
            if (o >= 0) inc16(lines.t.data.cancelled, o);
          }
        }
      }
    },

    /**
     * Los recorridos que llevan RUN_END_MS sin verse han acabado: su último retraso es el de su llegada, y
     * cuentan en su línea (a tiempo o tarde). Los que llevan RUN_GAP_MS se olvidan.
     * @param {number} now
     */
    closeRuns(now) {
      for (const [key, run] of runs) {
        if (!run.ended && now - run.lastSeen >= RUN_END_MS) {
          run.ended = true;
          const si = services.idx(key);
          const o = si < 0 ? -1 : services.read(si, run.day);
          if (o >= 0 && services.t.data.last[o] !== NONE) {
            services.t.data.flags[o] |= F_ENDED;
            run.outcome = services.t.data.last[o] >= LATE_MIN ? 2 : 1;
            countFinished(run, 1);
          }
        }
        if (run.ended && now - run.lastSeen > RUN_GAP_MS) runs.delete(key);
      }
    },

    /**
     * Lo que se sabe de la puntualidad de una clave (servicio o línea) en los últimos días; null si no se
     * ha visto nunca o no es de las que tienen puntualidad (una parada).
     * @param {string} key @param {number} now
     */
    report(key, now) {
      const today = madridDay(now);
      const kind = followKind(key);
      if (kind === 'servicio') return serviceReport(key, today);
      if (kind === 'linea') return lineReport(key, today);
      return null;
    },

    /** Cuántas claves hay y si alguna tabla se ha llenado (para el registro y las pruebas). */
    stats: () => ({ services: services.size(), lines: lines.size(), runs: runs.size, strings: strings.size(), since, day, full: { ...full } }),

    /** Todo lo guardado, para el disco: copias de los arrays, sin recorrer las claves una a una. */
    snapshot() {
      return {
        version: VERSION, keep, since, day,
        strings: strings.pack(),
        services: services.pack(), lines: lines.pack(),
        runs: [...runs],
        lineVehicles: [...lineVehicles].map(([i, ids]) => [i, Uint32Array.from(ids)]),
        cancelledToday: Uint32Array.from(cancelledToday),
      };
    },

    /** Vuelve a lo guardado; false si no vale (otra versión, otro número de días o mal formado). */
    restore(saved) {
      if (saved?.version !== VERSION || saved.keep !== keep) return false;
      const s2 = createStrings();
      if (!s2.unpack(saved.strings)) return false;
      const previous = strings;
      strings = s2;
      const s = newServices();
      const l = newLines();
      if (!s.unpack(saved.services, s2.size()) || !l.unpack(saved.lines, s2.size())) {
        strings = previous;
        return false;
      }
      services = s;
      lines = l;
      since = Number.isInteger(saved.since) ? saved.since : 0;
      day = Number.isInteger(saved.day) ? saved.day : 0;
      const isRun = (r) => r && Number.isInteger(r.day) && Number.isFinite(r.lastSeen) && typeof r.ended === 'boolean';
      runs = new Map((Array.isArray(saved.runs) ? saved.runs : []).filter(([k, r]) => typeof k === 'string' && isRun(r)));
      lineVehicles = new Map((Array.isArray(saved.lineVehicles) ? saved.lineVehicles : [])
        .filter(([i, ids]) => Number.isInteger(i) && ids instanceof Uint32Array).map(([i, ids]) => [i, new Set(ids)]));
      cancelledToday = new Set(saved.cancelledToday instanceof Uint32Array ? saved.cancelledToday : []);
      return true;
    },
  };
}

const metaOut = (m) => ({
  operator: m.operator ?? null, mode: m.mode ?? null, source: m.source ?? null, service: m.service ?? null,
  line: m.line ?? null, number: m.number ?? null, origin: m.origin ?? null, destination: m.destination ?? null,
});
