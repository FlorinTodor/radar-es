// El trazado de cada viaje de un GTFS estático (trips.txt y shapes.txt), para los vehículos con GPS cuyo tiempo real dice
// qué viaje hacen: su recorrido y lo que les queda se dibujan por él (domain/recorrido-trazado.js). Sólo eso: ni paradas
// ni horas, que ocuparían mucho más (Bizkaibus: 33.000 viajes y 546.000 puntos de trazado, que quedan en pocos MB).
import { buildShape } from '../../../domain/schedule.js';
import { createPacer, csvColumnsStreamed, own } from './gtfs-reader.js';

/**
 * @typedef {{ coords: Float32Array, dist: Float32Array }} Shape
 * @typedef {{ shapeOf: (tripId: string|undefined) => Shape|null, trips: number, shapes: number }} TripShapes
 */

/**
 * Lee los trazados de un GTFS: cada trazado, una vez (los viajes que lo comparten apuntan al mismo), con un punto cada
 * 10 m como mucho (buildShape). Los ficheros se leen del ZIP por trozos (csvColumnsStreamed) y cediendo el hilo de vez
 * en cuando: el shapes.txt de Bizkaibus son 37 MB descomprimidos, que de golpe y fila a fila como objetos subían la
 * memoria del proceso unos 185 MB mientras se leía (así, unos 75); lo que se queda son unos 11 MB (medido el 16-11-2026).
 * @param {Uint8Array} zip
 * @returns {Promise<TripShapes>}
 */
export async function readTripShapes(zip) {
  const pace = createPacer();
  const points = new Map(); // shape_id → [secuencia, lon, lat, secuencia, lon, lat…]
  try {
    for await (const [id, lat, lon, seq] of csvColumnsStreamed(zip, 'shapes.txt', ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) {
      if (pace.due()) await pace.pause();
      const x = Number(lon);
      const y = Number(lat);
      const n = Number(seq);
      if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(n)) continue;
      let list = points.get(id);
      if (!list) points.set(own(id), (list = []));
      list.push(n, x, y);
    }
  } catch (err) {
    if (/no está en el ZIP/.test(err.message)) return { shapeOf: () => null, trips: 0, shapes: 0 }; // sin shapes.txt
    throw err;
  }
  const shapes = new Map();
  for (const [id, list] of points) {
    if (pace.due()) await pace.pause();
    const order = Array.from({ length: list.length / 3 }, (_, i) => i).sort((a, b) => list[a * 3] - list[b * 3]);
    const lonLat = new Float64Array(order.length * 2);
    order.forEach((k, i) => {
      lonLat[i * 2] = list[k * 3 + 1];
      lonLat[i * 2 + 1] = list[k * 3 + 2];
    });
    points.set(id, null); // ya no hace falta: que se pueda recoger mientras se hacen los demás
    const shape = buildShape(lonLat);
    if (shape.dist.length > 1) shapes.set(id, shape);
  }
  const byTrip = new Map();
  for await (const [tripId, shapeId] of csvColumnsStreamed(zip, 'trips.txt', ['trip_id', 'shape_id'])) {
    if (pace.due()) await pace.pause();
    const shape = shapeId ? shapes.get(shapeId) : null;
    if (tripId && shape) byTrip.set(own(tripId), shape);
  }
  return { shapeOf: (tripId) => (tripId ? byTrip.get(tripId) ?? null : null), trips: byTrip.size, shapes: shapes.size };
}

/**
 * Lo que se sabe del viaje de cada vehículo de una fuente: su trazado y desde cuándo lo hace (cuando cambia de viaje, lo
 * de antes es de otro viaje). Los que dejan de salir en el feed se olvidan.
 */
export function createTripTracker() {
  const byVehicle = new Map(); // id del vehículo → { tripId, shape, since }
  return {
    /** Un vehículo en esta lectura, con su viaje y su trazado (o sin ellos). */
    see(vehicleId, tripId, shape, t, tripStart = null) {
      const known = byVehicle.get(vehicleId);
      if (!tripId || !shape) return void byVehicle.delete(vehicleId);
      if (known?.tripId === tripId) return;
      // Desde que se le ve en este viaje o, si el feed dice a qué hora empezó, desde entonces (lo que sea más tarde no:
      // tras un reinicio, el principio del viaje sigue en su recorrido guardado).
      byVehicle.set(vehicleId, { tripId, shape, since: Number.isFinite(tripStart) && tripStart <= t ? tripStart : t });
    },
    /** Olvida los que no salen en esta lectura. */
    keep(ids) {
      for (const id of byVehicle.keys()) if (!ids.has(id)) byVehicle.delete(id);
    },
    get: (vehicleId) => byVehicle.get(vehicleId) ?? null,
    size: () => byVehicle.size,
  };
}
