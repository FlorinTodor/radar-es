// Trazado de un viaje hecho de tramos de parada a parada (la carretera de CartoCiudad entre cada dos paradas de un
// autobús cuyo operador no publica el trazado de sus viajes), con la distancia exacta de cada parada sobre él. Puro: sin
// red, ni reloj, ni disco. Va aparte de schedule.js porque ese fichero entra en la huella de los horarios preparados:
// tocarlo obliga a prepararlos todos otra vez al desplegar.
import { M_PER_DEG_LAT, mPerDegLon } from './geo.js';

/**
 * Trazado hecho de tramos de parada a parada (la carretera entre cada dos, en orden), con la distancia de cada
 * parada sobre él. Cada parada está donde empieza su tramo (la última, donde acaba el último), así que no hay que
 * buscarla: con stopsAlongShape, una ruta que vuelve por las mismas calles (una línea de urbanización que entra y
 * sale por la misma avenida) tomaba la otra pasada y el viaje se quedaba sin carretera.
 * Como buildShape, quita los puntos a menos de `minStep` metros del anterior, salvo las paradas.
 * @param {ArrayLike<number>[]} legs  [lon, lat, …] de cada tramo; cada uno empieza en su parada y acaba en la siguiente
 * @returns {{ shape: { coords: Float32Array, dist: Float32Array }, along: Float64Array } | null} null sin tramos
 */
export function shapeFromLegs(legs, minStep = 10) {
  if (!legs.length) return null;
  const kept = []; // [lon, lat, …]
  const dist = [];
  const isStop = [];
  const along = new Float64Array(legs.length + 1);
  const stepTo = (lon, lat) => Math.hypot((lon - kept.at(-2)) * mPerDegLon(lat), (lat - kept.at(-1)) * M_PER_DEG_LAT);
  const push = (lon, lat, stop) => {
    if (!kept.length) {
      kept.push(lon, lat);
      dist.push(0);
      isStop.push(stop);
      return;
    }
    let step = stepTo(lon, lat);
    if (step < minStep) {
      if (!stop) return;
      if (step === 0 && isStop.at(-1)) return; // dos paradas en el mismo punto: un solo punto
      if (!isStop.at(-1) && kept.length > 2) { // el punto de paso cede su sitio a la parada
        kept.length -= 2;
        dist.pop();
        isStop.pop();
        step = stepTo(lon, lat);
      }
    }
    kept.push(lon, lat);
    dist.push(dist.at(-1) + step);
    isStop.push(stop);
  };
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const n = leg.length / 2;
    if (i === 0) {
      push(leg[0], leg[1], true);
      along[0] = dist.at(-1);
    }
    // El primer punto de cada tramo es la parada en la que acabó el anterior.
    for (let j = 1; j < n; j++) push(leg[j * 2], leg[j * 2 + 1], j === n - 1);
    along[i + 1] = dist.at(-1);
  }
  if (kept.length < 4) return null;
  return { shape: { coords: Float32Array.from(kept), dist: Float32Array.from(dist) }, along };
}
