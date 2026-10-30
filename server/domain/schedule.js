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
    if (t >= s.arr && t <= s.dep) return { lat: s.lat, lon: s.lon, atStop: true, prev: s, next: stops[i + 1] ?? null };
    const n = stops[i + 1];
    if (n && t > s.dep && t < n.arr) {
      const k = (t - s.dep) / (n.arr - s.dep);
      return { lat: s.lat + (n.lat - s.lat) * k, lon: s.lon + (n.lon - s.lon) * k, atStop: false, prev: s, next: n };
    }
  }
  return null;
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
