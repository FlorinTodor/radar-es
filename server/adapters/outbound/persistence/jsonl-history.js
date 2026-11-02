// Histórico append-only en ficheros JSONL diarios (data/history/<stream>-YYYY-MM-DD.jsonl).
// Fácil de analizar con jq, DuckDB o pandas. Sustituible por una base de datos
// implementando el mismo puerto History.
import { appendFile, mkdir } from 'node:fs/promises';

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').HistoryPort}
 */
export function createJsonlHistory({ dir, log }) {
  let ready = null;
  const day = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());

  return {
    async append(stream, row) {
      try {
        ready ??= mkdir(dir, { recursive: true });
        await ready;
        await appendFile(new URL(`${stream}-${day()}.jsonl`, dir), `${JSON.stringify(row)}\n`);
      } catch (err) {
        ready = null; // si fue la carpeta, se vuelve a intentar con la siguiente fila
        log.warn(`[historial] ${err.message}`);
      }
    },
  };
}
