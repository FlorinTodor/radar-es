// Lista cerrada de lo que se puede ejecutar en los hilos de cálculo: funciones puras de los
// adaptadores (entran bytes o texto, sale un resultado que se puede copiar entre hilos).
// `pack` (en el hilo) da el resultado en una forma barata de pasar, con los buffers que se transfieren
// sin copiar; `unpack` (en el hilo principal) lo devuelve a su forma normal.
import { packSchedule, parseSchedule, unpackSchedule } from '../gtfs/gtfs-schedule.js';
import { buildNetwork } from '../network/gtfs-network-catalog.js';
import { parseDgt } from '../sources/dgt.js';

/** @type {Record<string, { run: (...args: any[]) => any, pack?: (result: any) => { value: any, transfer: ArrayBuffer[] }, unpack?: (value: any) => any }>} */
export const TASKS = {
  /** (zip, modo, días, filtro) → horario compacto de hoy y ayer. */
  schedule: { run: parseSchedule, pack: packSchedule, unpack: unpackSchedule },
  /** (zip, nombre de la red) → trazados de sus líneas (GeoJSON). */
  network: { run: buildNetwork },
  /** (XML DATEX II) → incidencias de la DGT. */
  dgt: { run: parseDgt },
};
