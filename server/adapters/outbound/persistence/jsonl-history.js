// Histórico append-only en ficheros JSONL diarios (data/history/<stream>-YYYY-MM-DD.jsonl).
// Fácil de analizar con jq, DuckDB o pandas. Sustituible por una base de datos
// implementando el mismo puerto History.
import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';

/** Días que se guarda cada fichero diario: unos 2 MB al día entre alertas y KPIs. */
const KEEP_DAYS = 90;
const DAILY_FILE = /^[a-z][\w-]*-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, keepDays?: number, now?: () => number }} deps
 *   keepDays: al empezar cada día se borran los ficheros de hace más de esos días (sólo los diarios de
 *   este histórico, por su nombre). now: reloj, para los tests.
 * @returns {import('../../../application/ports.js').HistoryPort}
 */
export function createJsonlHistory({ dir, log, keepDays = KEEP_DAYS, now = Date.now }) {
  let ready = null;
  let prunedDay = null;
  const day = (t = now()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(t);

  async function prune() {
    const oldest = day(now() - keepDays * 86_400_000);
    for (const name of await readdir(dir)) {
      const date = DAILY_FILE.exec(name)?.[1];
      if (date && date < oldest) await unlink(new URL(name, dir));
    }
  }

  return {
    async append(stream, row) {
      try {
        ready ??= mkdir(dir, { recursive: true });
        await ready;
        const today = day();
        await appendFile(new URL(`${stream}-${today}.jsonl`, dir), `${JSON.stringify(row)}\n`);
        if (prunedDay !== today) {
          prunedDay = today; // una vez al día, aunque falle: no se reintenta en cada fila
          await prune();
        }
      } catch (err) {
        ready = null; // si fue la carpeta, se vuelve a intentar con la siguiente fila
        log.warn(`[historial] ${err.message}`);
      }
    },
  };
}
