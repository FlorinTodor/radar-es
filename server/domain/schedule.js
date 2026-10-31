// Posición estimada de un tren a partir de su horario teórico (GTFS). Se usa para
// operadores que no publican GPS (p. ej. Ouigo). Es una estimación: no sabe de retrasos.

/**
 * @typedef {{ stopId: string, name: string, lat: number, lon: number, arr: number, dep: number }} ScheduledStop
 *   arr/dep en segundos desde el inicio del día de servicio (pueden pasar de 86400).
 */

/** "25:10:00" → 90600. Devuelve null si el formato no es válido. */
export function gtfsTimeToSeconds(s) {
  const m = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(s ?? '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/**
 * Dónde debería estar el tren `t` segundos después del inicio de su día de servicio.
 * @param {ScheduledStop[]} stops ordenadas por secuencia
 * @returns {null | { lat: number, lon: number, atStop: boolean, prev: ScheduledStop, next: ScheduledStop|null }}
 */
export function scheduledPosition(stops, t) {
  if (stops.length < 2 || t < stops[0].dep || t > stops.at(-1).arr) return null;
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (t >= s.arr && t <= s.dep) return { lat: s.lat, lon: s.lon, atStop: true, prev: s, next: stops[i + 1] ?? null, i, k: 0 };
    const n = stops[i + 1];
    if (n && t > s.dep && t < n.arr) {
      // En línea recta entre las dos paradas; quien tenga el trazado lo coloca sobre él con `i` y `k`.
      const k = (t - s.dep) / (n.arr - s.dep);
      return { lat: s.lat + (n.lat - s.lat) * k, lon: s.lon + (n.lon - s.lon) * k, atStop: false, prev: s, next: n, i, k };
    }
  }
  return null;
}

// ---------- Trazados (shapes.txt) ----------
// Para que un vehículo estimado vaya por su calle o carretera y no en línea recta entre paradas.
// Distancias en metros con una proyección local (equirectangular): sobra para tramos de pocos km.

const M_PER_DEG_LAT = 110_540;
const mPerDegLon = (lat) => 111_320 * Math.cos((lat * Math.PI) / 180);

/**
 * Trazado listo para interpolar: quita los puntos a menos de `minStep` metros del anterior (hay
 * GTFS con un punto cada metro) y calcula la distancia acumulada.
 * @param {number[]} lonLat [lon0, lat0, lon1, lat1, …] en orden
 * @returns {{ coords: Float32Array, dist: Float32Array }}
 */
export function buildShape(lonLat, minStep = 10) {
  const keptLonLat = [];
  const dist = [];
  let total = 0;
  const n = lonLat.length / 2;
  for (let i = 0; i < n; i++) {
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    if (keptLonLat.length) {
      const pLon = keptLonLat.at(-2);
      const pLat = keptLonLat.at(-1);
      const step = Math.hypot((lon - pLon) * mPerDegLon(lat), (lat - pLat) * M_PER_DEG_LAT);
      if (step < minStep && i < n - 1) continue; // el último punto se queda siempre
      total += step;
    }
    keptLonLat.push(lon, lat);
    dist.push(total);
  }
  return { coords: Float32Array.from(keptLonLat), dist: Float32Array.from(dist) };
}

/** Punto del trazado a `d` metros del inicio (búsqueda binaria e interpolación lineal). */
export function pointAlong(shape, d) {
  const { coords, dist } = shape;
  const last = dist.length - 1;
  if (d <= 0 || last === 0) return { lon: coords[0], lat: coords[1] };
  if (d >= dist[last]) return { lon: coords[last * 2], lat: coords[last * 2 + 1] };
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (dist[mid] <= d) lo = mid;
    else hi = mid;
  }
  const k = (d - dist[lo]) / (dist[hi] - dist[lo] || 1);
  return { lon: coords[lo * 2] + (coords[hi * 2] - coords[lo * 2]) * k, lat: coords[lo * 2 + 1] + (coords[hi * 2 + 1] - coords[lo * 2 + 1]) * k };
}

/**
 * Distancia a lo largo del trazado de cada parada del viaje, siempre hacia delante: cada parada se
 * busca a partir de la anterior, y se deja de buscar cuando ya hay una buena coincidencia y el
 * trazado se ha alejado 2 km (así una línea circular no salta a su segunda pasada).
 * @param {{ lat: number, lon: number }[]} stops
 * @returns {Float64Array | null} null si alguna parada queda a más de `maxOff` metros del trazado
 */
export function stopsAlongShape(stops, shape, maxOff = 300) {
  const { coords, dist } = shape;
  const segs = dist.length - 1;
  if (segs < 1) return null;
  const out = new Float64Array(stops.length);
  let from = 0;
  let prevAlong = 0;
  for (let s = 0; s < stops.length; s++) {
    const { lat, lon } = stops[s];
    const kx = mPerDegLon(lat);
    let best = { off: Infinity, seg: from, along: prevAlong };
    for (let i = from; i < segs; i++) {
      // Proyección del punto sobre el segmento i, en metros alrededor de la parada.
      const ax = (coords[i * 2] - lon) * kx;
      const ay = (coords[i * 2 + 1] - lat) * M_PER_DEG_LAT;
      const bx = (coords[i * 2 + 2] - lon) * kx;
      const by = (coords[i * 2 + 3] - lat) * M_PER_DEG_LAT;
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const u = len2 ? Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / len2)) : 0;
      const off = Math.hypot(ax + (bx - ax) * u, ay + (by - ay) * u);
      const along = dist[i] + (dist[i + 1] - dist[i]) * u;
      // Nunca hacia atrás (salvo unos metros por la imprecisión de las paradas): en el tramo de la
      // parada anterior, una línea circular volvería a su primera pasada.
      if (along >= prevAlong - 50 && off < best.off) best = { off, seg: i, along: Math.max(along, prevAlong) };
      if (best.off < 50 && dist[i] > best.along + 2000) break;
    }
    if (best.off > maxOff) return null;
    out[s] = best.along;
    prevAlong = best.along;
    from = best.seg;
  }
  return out;
}

/**
 * Viajes por frecuencia (frequencies.txt): el viaje "plantilla" se repite cada `headway`
 * segundos entre `start` y `end`. Devuelve los desfases (en segundos respecto a la plantilla)
 * de las repeticiones que están en circulación en el instante `t`.
 * @param {{ start: number, end: number, headway: number }} freq
 * @param {number} firstDep salida de la plantilla
 * @param {number} duration duración del viaje
 */
export function activeFrequencyOffsets(freq, firstDep, duration, t) {
  if (!(freq.headway > 0)) return [];
  const offsets = [];
  const kMin = Math.max(0, Math.ceil((t - duration - freq.start) / freq.headway));
  for (let k = kMin; ; k++) {
    const departure = freq.start + k * freq.headway;
    if (departure >= freq.end || departure > t) break;
    offsets.push(departure - firstDep);
  }
  return offsets;
}

/**
 * ¿Circula el servicio ese día? (calendar.txt + excepciones de calendar_dates.txt)
 * @param {{ days?: boolean[], start?: string, end?: string } | undefined} calendar  days[0] = lunes
 * @param {Map<string, 1|2> | undefined} exceptions  'YYYYMMDD' → 1 añadido, 2 suprimido
 * @param {string} ymd 'YYYYMMDD'
 * @param {number} weekday 0 = lunes … 6 = domingo
 */
export function serviceRuns(calendar, exceptions, ymd, weekday) {
  const ex = exceptions?.get(ymd);
  if (ex === 1) return true;
  if (ex === 2) return false;
  return !!calendar && calendar.start <= ymd && ymd <= calendar.end && !!calendar.days?.[weekday];
}
