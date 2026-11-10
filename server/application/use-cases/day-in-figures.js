// Caso de uso: el día en cifras. Cada minuto suma lo que se ve (vehículos, cancelaciones, trenes sin datos y
// avisos de emergencia) al registro del día, lo guarda de vez en cuando y al cambiar de día, y da el resumen
// de cualquier día que se guarde (domain/dia.js).
// El resumen se pide desde la API, que no espera: es síncrono. Lo que hay que leer del disco (los KPI y las
// alertas del histórico, el registro de un día pasado, el de la semana anterior) se lee aparte y se guarda en
// memoria; mientras tanto, un día pasado responde «cargando» y la web vuelve a pedirlo en un momento.
import { addDays, emptyDay, foldEvents, foldVehicles, isDay, madridDay, noteSources, sanitizeDay, summarizeDay } from '../../domain/dia.js';

const SAVE_EVERY_TICKS = 5; // cada 5 min se guarda el registro de hoy: un despliegue pierde como mucho eso
const TODAY_REFRESH_MS = 5 * 60_000; // los KPI y las alertas de hoy, del histórico
const PAST_MAX = 16; // resúmenes de días pasados en memoria
const PAST_TTL_MS = 3600_000;
const LOADS_AT_ONCE = 2; // lecturas de días pasados a la vez: pedir muchos días no satura el disco

/**
 * @param {{ situation: Pick<import('../ports.js').SituationRepositoryPort, 'vehicles'|'events'|'health'>,
 *           history: import('../ports.js').HistoryReaderPort, store: import('../ports.js').DayStorePort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort, keepDays?: number }} deps
 *   keepDays: hasta cuántos días atrás se puede pedir (lo que guarda el histórico).
 */
export function makeDayInFigures({ situation, history, store, clock, log, keepDays = 90 }) {
  /** @type {import('../../domain/dia.js').DayRecord|null} */
  let record = null;
  let ticks = 0;
  // Lo de hoy que sale del histórico (se renueva cada TODAY_REFRESH_MS) y el día de la semana anterior.
  let todayData = { date: null, at: -Infinity, kpiRows: [], alertRows: [], compare: null, days: [] };
  let refreshing = null;
  const past = new Map(); // día → { summary, at }
  const loading = new Map(); // día → promesa

  const warn = (what) => (err) => log.warn(`[día en cifras] ${what}: ${err?.message ?? err}`);

  async function loadRecord(day) {
    return sanitizeDay(await store.load(day).catch(() => null), day);
  }

  /** Los días con algo que enseñar: los del registro y los del histórico de KPI. */
  async function availableDays(today) {
    const [stored, kpi] = await Promise.all([store.days().catch(() => []), history.days('kpis').catch(() => [])]);
    const oldest = addDays(today, -keepDays);
    return [...new Set([...stored, ...kpi, today])].filter((d) => isDay(d) && d >= oldest && d <= today).sort();
  }

  async function compareData(day) {
    const date = addDays(day, -7);
    const [rec, kpiRows] = await Promise.all([loadRecord(date), history.read('kpis', date)]);
    return { date, record: rec, kpiRows };
  }

  /** Renueva lo de hoy que sale del histórico (una sola vez a la vez). */
  function refreshToday(day) {
    refreshing ??= (async () => {
      try {
        const sameDay = todayData.date === day;
        const [kpiRows, alertRows, days, compare] = await Promise.all([
          history.read('kpis', day), history.read('alerts', day), availableDays(day),
          sameDay && todayData.compare ? todayData.compare : compareData(day),
        ]);
        todayData = { date: day, at: clock.now(), kpiRows, alertRows, compare, days };
      } catch (err) {
        warn('no se pudo leer el histórico de hoy')(err);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Lee un día pasado y deja su resumen en memoria (null si no hay nada de ese día). */
  function loadPast(day) {
    if (loading.has(day) || loading.size >= LOADS_AT_ONCE) return;
    const job = (async () => {
      try {
        const today = madridDay(clock.now());
        const [rec, kpiRows, alertRows, compare, days] = await Promise.all([
          loadRecord(day), history.read('kpis', day), history.read('alerts', day), compareData(day), availableDays(today),
        ]);
        // Un día del que no hay ni registro ni KPI: el servidor no estaba en marcha y de sus alertas no se sabe.
        const known = Boolean(rec) || kpiRows.length > 0 || alertRows.length > 0;
        const summary = summarizeDay({ date: day, now: clock.now(), today: false, record: rec, kpiRows, alertRows: known ? alertRows : null,
          compare, days, health: situation.health() });
        past.set(day, { summary, at: clock.now() });
        while (past.size > PAST_MAX) past.delete(past.keys().next().value);
      } catch (err) {
        warn(`no se pudo leer el ${day}`)(err);
      } finally {
        loading.delete(day);
      }
    })();
    loading.set(day, job);
  }

  return {
    /** Al arrancar: el registro de hoy, si lo había (un reinicio no empieza el día de cero). */
    async restore() {
      const today = madridDay(clock.now());
      record = (await loadRecord(today)) ?? emptyDay(today);
      await refreshToday(today);
    },

    /** Cada minuto: suma lo que se ve ahora. Al cambiar de día, guarda el de ayer y empieza otro. */
    async tick() {
      const now = clock.now();
      const today = madridDay(now);
      if (!record) record = (await loadRecord(today)) ?? emptyDay(today);
      if (record.date !== today) {
        const closed = record;
        record = (await loadRecord(today)) ?? emptyDay(today);
        await store.save(closed);
        past.delete(closed.date);
      }
      foldVehicles(record, situation.vehicles(), now);
      foldEvents(record, situation.events(), now);
      noteSources(record, situation.health());
      if (++ticks % SAVE_EVERY_TICKS === 0) await store.save(record);
      if (todayData.date !== today || now - todayData.at >= TODAY_REFRESH_MS) await refreshToday(today);
    },

    /** Guarda el registro de hoy (al apagar). */
    async save() {
      if (record) await store.save(record);
    },

    /**
     * El resumen de un día (null: hoy si no se dice). null si el día no vale o no hay nada de él;
     * { date, loading: true } si es un día pasado que aún se está leyendo.
     * @param {string|null} [day]
     */
    /** El día de hoy en Madrid («AAAA-MM-DD»): pedido con su fecha, hoy es hoy (se renueva, no se guarda como cerrado). */
    today: () => madridDay(clock.now()),

    summary(day = null) {
      const now = clock.now();
      const today = madridDay(now);
      const date = day ?? today;
      if (!isDay(date) || date > today || date < addDays(today, -keepDays)) return null;
      if (date === today) {
        const rec = record?.date === today ? record : null;
        const fresh = todayData.date === today;
        if (!fresh) refreshToday(today);
        return summarizeDay({
          date, now, today: true, record: rec,
          // Mientras no se ha leído el histórico de hoy (justo tras arrancar), sus alertas no se saben: null, no 0.
          kpiRows: fresh ? todayData.kpiRows : [], alertRows: fresh ? todayData.alertRows : null,
          compare: fresh ? todayData.compare : null, days: fresh ? todayData.days : [today], health: situation.health(),
        });
      }
      const hit = past.get(date);
      if (hit && now - hit.at < PAST_TTL_MS) return hit.summary;
      loadPast(date);
      return { date, loading: true };
    },
  };
}
