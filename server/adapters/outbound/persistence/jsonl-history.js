// Histórico append-only en ficheros JSONL diarios (data/history/<stream>-YYYY-MM-DD.jsonl).
// Fácil de analizar con jq, DuckDB o pandas. Sustituible por una base de datos
// implementando los mismos puertos History (escribir) e HistoryReader (leer un día).
import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { madridDate } from '../sources/parse.js';

/** Días que se guarda cada fichero diario: unos 2 MB al día entre alertas y KPIs. */
const KEEP_DAYS = 90;
const DAILY_FILE = /^[a-z][\w-]*-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const STREAM = /^[a-z][a-z0-9_]{0,31}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Al leer un día: un fichero mayor no se lee (unos 2 MB es lo normal) y, como mucho, estas filas.
const READ_MAX_BYTES = 16 * 1024 * 1024;
const READ_MAX_ROWS = 50_000;

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, keepDays?: number, now?: () => number }} deps
 *   keepDays: al empezar cada día se borran los ficheros de hace más de esos días (sólo los diarios de
 *   este histórico, por su nombre). now: reloj, para los tests.
 * @returns {import('../../../application/ports.js').HistoryPort & import('../../../application/ports.js').HistoryReaderPort}
 */
export function createJsonlHistory({ dir, log, keepDays = KEEP_DAYS, now = Date.now }) {
  let ready = null;
  let prunedDay = null;
  // Un fichero por día de Madrid: el de una noche no se parte a la 01:00.
  const day = (t = now()) => madridDate(t);

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

    /** Las filas de un día, en orden. Las que no son JSON (una escritura cortada) se saltan. */
    async read(stream, date) {
      if (!STREAM.test(stream ?? '') || !DAY.test(date ?? '')) return [];
      const file = new URL(`${stream}-${date}.jsonl`, dir);
      try {
        if ((await stat(file)).size > READ_MAX_BYTES) {
          log.warn(`[historial] ${stream}-${date}.jsonl es demasiado grande para leerlo`);
          return [];
        }
        const rows = [];
        for (const line of (await readFile(file, 'utf8')).split('\n')) {
          if (!line) continue;
          try {
            rows.push(JSON.parse(line));
          } catch { /* una línea a medio escribir */ }
          if (rows.length >= READ_MAX_ROWS) break;
        }
        return rows;
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[historial] ${stream}-${date}.jsonl: ${err.message}`);
        return [];
      }
    },

    /** Los días de los que hay fichero de ese histórico. */
    async days(stream) {
      if (!STREAM.test(stream ?? '')) return [];
      try {
        const prefix = `${stream}-`;
        return (await readdir(dir)).filter((n) => n.startsWith(prefix) && DAILY_FILE.test(n) && DAY.test(n.slice(prefix.length, -6)))
          .map((n) => n.slice(prefix.length, -6)).sort();
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[historial] ${err.message}`);
        return [];
      }
    },
  };
}
