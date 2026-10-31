// Lista cerrada de lo que se puede ejecutar en los hilos de cálculo: funciones puras de los
// adaptadores (entran bytes o texto, sale un resultado que se puede copiar entre hilos).
// `transfer` dice qué buffers del resultado se pasan al hilo principal sin copiarlos.
import { parseSchedule, scheduleTransferables } from '../gtfs/gtfs-schedule.js';
import { buildNetwork } from '../network/gtfs-network-catalog.js';
import { parseDgt } from '../sources/dgt.js';

/** @type {Record<string, { run: (...args: any[]) => any, transfer?: (result: any) => ArrayBuffer[] }>} */
export const TASKS = {
  /** (zip, modo, días, filtro) → horario compacto de hoy y ayer. */
  schedule: { run: parseSchedule, transfer: scheduleTransferables },
  /** (zip, nombre de la red) → trazados de sus líneas (GeoJSON). */
  network: { run: buildNetwork },
  /** (XML DATEX II) → incidencias de la DGT. */
  dgt: { run: parseDgt },
};
