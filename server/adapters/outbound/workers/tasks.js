// Lista cerrada de lo que se puede ejecutar en los hilos de cálculo: funciones puras de los
// adaptadores (entran bytes o texto, sale un resultado que se puede copiar entre hilos).
// `pack` (en el hilo) da el resultado en una forma barata de pasar, con los buffers que se transfieren
// sin copiar; `unpack` (en el hilo principal) lo devuelve a su forma normal.
import { packSchedule, parseSchedule, unpackSchedule } from '../gtfs/gtfs-schedule.js';
import { buildNetwork } from '../network/gtfs-network-catalog.js';
import { parseDgt } from '../sources/dgt.js';
import { renderCardPng } from '../cards/png-card.js';

// El PNG ya es una copia fuera de la memoria de WebAssembly: se transfiere sin volver a copiarlo.
const transferPng = (png) => {
  const own = png.byteOffset === 0 && png.byteLength === png.buffer.byteLength ? png : png.slice();
  return { value: own, transfer: [own.buffer] };
};

/** @type {Record<string, { run: (...args: any[]) => any, pack?: (result: any) => { value: any, transfer: ArrayBuffer[] }, unpack?: (value: any) => any }>} */
export const TASKS = {
  /** (zip, modo, días, filtro) → horario compacto de hoy y ayer. */
  schedule: { run: parseSchedule, pack: packSchedule, unpack: unpackSchedule },
  /** (zip, nombre de la red) → trazados de sus líneas (GeoJSON). */
  network: { run: buildNetwork },
  /** (XML DATEX II, hora de la lectura) → incidencias de la DGT. */
  dgt: { run: parseDgt },
  /** (SVG de una tarjeta de compartir, ficheros de la letra) → PNG (resvg en WebAssembly, que sólo se carga al usarla). */
  card: { run: renderCardPng, pack: transferPng },
};
