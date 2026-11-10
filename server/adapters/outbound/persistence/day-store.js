// El registro de cada día del día en cifras (domain/dia.js), un JSON por día en data/dias/. Se escribe de
// golpe (writeFileAtomic): durante un relevo hay dos servidores con la misma carpeta y ninguno debe leer
// un registro a medio escribir. Se guardan los últimos `keepDays` días; los más viejos se borran.
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { writeFileAtomic } from '../http/file-cache.js';

const KEEP_DAYS = 90;
const FILE = /^dia-(\d{4}-\d{2}-\d{2})\.json$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Un registro normal pesa decenas de kB (unos cientos en un día de huelga): uno mayor no se lee.
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * @param {{ dir: URL, log: import('../../../application/ports.js').LoggerPort, keepDays?: number }} deps
 * @returns {import('../../../application/ports.js').DayStorePort}
 */
export function createDayStore({ dir, log, keepDays = KEEP_DAYS }) {
  const fileOf = (day) => new URL(`dia-${day}.json`, dir);
  const list = async () => {
    try {
      return (await readdir(dir)).map((n) => FILE.exec(n)?.[1]).filter(Boolean).sort();
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`[día en cifras] ${err.message}`);
      return [];
    }
  };

  return {
    async load(day) {
      if (!DAY.test(day ?? '')) return null;
      try {
        if ((await stat(fileOf(day))).size > MAX_BYTES) {
          log.warn(`[día en cifras] el registro de ${day} es demasiado grande para leerlo`);
          return null;
        }
        return JSON.parse(await readFile(fileOf(day), 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn(`[día en cifras] no se pudo leer el registro de ${day}: ${err.message}`);
        return null;
      }
    },

    async save(record) {
      if (!DAY.test(record?.date ?? '')) return;
      try {
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(fileOf(record.date), JSON.stringify(record));
        // Los de hace más de keepDays días, fuera (sólo los de este almacén, por su nombre).
        const days = await list();
        for (const old of days.slice(0, Math.max(0, days.length - keepDays))) await unlink(fileOf(old)).catch(() => {});
      } catch (err) {
        log.warn(`[día en cifras] no se pudo guardar el registro de ${record.date}: ${err.message}`);
      }
    },

    days: list,
  };
}
