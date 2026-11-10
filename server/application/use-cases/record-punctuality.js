// Caso de uso: la puntualidad histórica de cada servicio y de cada línea, de cualquier tipo de vehículo cuyo
// operador publique su retraso (domain/puntualidad.js). Cada minuto toma las lecturas de los vehículos y las
// cancelaciones del momento; cada cuarto de hora (y al apagar) guarda una copia, y al arrancar la recupera.
import { createPunctualityBook } from '../../domain/puntualidad.js';
import { inForce } from '../../domain/model.js';
import { describeFollow } from '../../domain/seguir.js';
import { modeNoun } from '../../domain/modos.js';

/** Una fuente cuenta si su última lectura buena es de hace menos de esto: la de una caída no es nueva. */
export const FRESH_MS = 5 * 60_000;
const capitalized = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, store: import('../ports.js').PunctualityStorePort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort,
 *           book?: ReturnType<typeof createPunctualityBook> }} deps
 *   book: el libro (para los tests, con otros topes).
 */
export function makeRecordPunctuality({ situation, store, clock, log, book = createPunctualityBook() }) {
  let warnedFull = false;
  return {
    /** Las lecturas de este minuto: vehículos de fuentes al día, cancelaciones en vigor y recorridos acabados. */
    tick() {
      const now = clock.now();
      const fresh = new Set();
      for (const h of situation.health()) if (h.enabled && Number.isFinite(h.lastOk) && now - h.lastOk <= FRESH_MS) fresh.add(h.id);
      book.observe(situation.vehicles().filter((v) => fresh.has(v.source)), now);
      book.cancellations(situation.events().filter((e) => e.category === 'cancelacion' && inForce(e, now)), now);
      book.closeRuns(now);
      const { full } = book.stats();
      if ((full.services || full.lines) && !warnedFull) {
        warnedFull = true;
        log.warn('[puntualidad] la tabla de servicios o de líneas está llena: lo nuevo no se guarda hasta que se libere sitio');
      }
    },

    /**
     * La puntualidad de un servicio o de una línea, con su nombre y la atribución de su fuente; null si el
     * radar no tiene nada de esa clave.
     * @param {string} key
     */
    report(key) {
      const r = book.report(key, clock.now());
      if (!r) return null;
      const source = situation.health().find((h) => h.id === r.source);
      const license = source ? source.operatorLicenses?.[r.operator] ?? source.license ?? source.name ?? null : null;
      return {
        ...r,
        // «Avant 08058», «Cercanías C5 · Renfe (Madrid)», «AVE · Renfe» (domain/seguir.js).
        name: describeFollow(key, { ...r, modeLabel: r.mode ? capitalized(modeNoun(r.mode)) : null }),
        credit: license,
        note: `Retrasos que publica ${r.operator ?? 'su operador'} en su tiempo real; datos modificados: el radar se queda con el último de cada `
          + `recorrido y los cuenta por día (${r.lateMinutes} min o más, tarde).`,
      };
    },

    /** Guarda una copia (nunca rechaza: el almacén registra si no puede). */
    save: () => store.save(book.snapshot()),

    /** Antes de la primera lectura: lo guardado, si vale. */
    async restore() {
      const saved = await store.load();
      if (!saved) return false;
      const ok = book.restore(saved);
      const s = book.stats();
      if (ok) log.info(`[puntualidad] recuperados ${s.services} servicios y ${s.lines} líneas`);
      else log.warn('[puntualidad] la copia guardada no vale (otra versión): se empieza de cero');
      return ok;
    },
  };
}
