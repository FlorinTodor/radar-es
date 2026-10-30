// Ouigo no publica posiciones en tiempo real. Con su horario (GTFS en el NAP) se estima
// dónde debería estar cada tren: se marca como `estimated` y no cuenta para alertas.
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { gtfsTimeToSeconds, scheduledPosition, serviceRuns } from '../../../domain/schedule.js';
import { madridLocalToMs } from './parse.js';

const OUIGO_FICHERO = 1766;
const RELOAD_MS = 24 * 3600_000;

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

function parseSchedule(zip) {
  const f = openGtfs(zip, ['trips.txt', 'stops.txt', 'stop_times.txt', 'calendar.txt', 'calendar_dates.txt']);
  const stops = new Map();
  for (const s of csvRows(f['stops.txt'])) stops.set(s.stop_id, { name: titleCase(s.stop_name), lat: +s.stop_lat, lon: +s.stop_lon });

  const calendar = new Map();
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  for (const c of csvRows(f['calendar.txt'])) calendar.set(c.service_id, { start: c.start_date, end: c.end_date, days: days.map((d) => c[d] === '1') });
  const exceptions = new Map();
  for (const d of csvRows(f['calendar_dates.txt'])) {
    if (!exceptions.has(d.service_id)) exceptions.set(d.service_id, new Map());
    exceptions.get(d.service_id).set(d.date, +d.exception_type);
  }

  const trips = new Map();
  for (const t of csvRows(f['trips.txt'])) trips.set(t.trip_id, { id: t.trip_id, serviceId: t.service_id, label: t.trip_short_name || t.trip_id, stops: [] });
  for (const st of csvRows(f['stop_times.txt'])) {
    const trip = trips.get(st.trip_id);
    const stop = stops.get(st.stop_id);
    if (!trip || !stop) continue;
    const arr = gtfsTimeToSeconds(st.arrival_time || st.departure_time);
    const dep = gtfsTimeToSeconds(st.departure_time || st.arrival_time);
    if (arr === null || dep === null) continue;
    trip.stops.push({ seq: +st.stop_sequence, stopId: st.stop_id, ...stop, arr, dep });
  }
  for (const t of trips.values()) t.stops.sort((a, b) => a.seq - b.seq);
  return { calendar, exceptions, trips: [...trips.values()].filter((t) => t.stops.length >= 2) };
}

/** Día de servicio en Madrid desplazado `offset` días: 'YYYYMMDD', día de la semana (0 = lunes) y su medianoche. */
function madridServiceDay(now, offset) {
  const [y, m, d] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(now).split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d + offset));
  const iso = day.toISOString().slice(0, 10);
  return { ymd: iso.replaceAll('-', ''), iso, weekday: (day.getUTCDay() + 6) % 7, midnight: madridLocalToMs(`${iso}T00:00:00`) };
}

const hhmmss = (secs) => [Math.floor(secs / 3600) % 24, Math.floor(secs / 60) % 60, secs % 60].map((n) => String(n).padStart(2, '0')).join(':');

/** @param {{ nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient> }} deps */
export function createOuigoHorarioSource({ nap }) {
  let schedule = null;
  let loadedAt = 0;

  return {
    id: 'ouigo-horario',
    name: 'Ouigo (posición estimada según horario, GTFS del NAP)',
    kind: 'vehicles',
    interval: 30_000,
    requires: ['NAP_API_KEY'],
    url: 'https://nap.transportes.gob.es',
    license: 'Ouigo España vía Punto de Acceso Nacional (horario, no GPS)',
    async fetch() {
      if (!schedule || Date.now() - loadedAt > RELOAD_MS) {
        schedule = parseSchedule(await nap.gtfs(OUIGO_FICHERO, RELOAD_MS));
        loadedAt = Date.now();
      }
      const now = Date.now();
      const vehicles = [];
      // Un tren que salió ayer antes de medianoche sigue perteneciendo al día de servicio anterior.
      for (const offset of [0, -1]) {
        const day = madridServiceDay(now, offset);
        const t = Math.floor((now - day.midnight) / 1000);
        for (const trip of schedule.trips) {
          if (!serviceRuns(schedule.calendar.get(trip.serviceId), schedule.exceptions.get(trip.serviceId), day.ymd, day.weekday)) continue;
          const pos = scheduledPosition(trip.stops, t);
          if (!pos) continue;
          vehicles.push({
            id: `ouigo:${trip.id}:${day.ymd}`,
            mode: 'av',
            operator: 'Ouigo',
            service: 'Ouigo',
            line: null,
            label: trip.label.replace(/^TGV\s*/i, ''),
            lat: pos.lat,
            lon: pos.lon,
            delay: null,
            estimated: true,
            origin: trip.stops[0].name,
            destination: trip.stops.at(-1).name,
            current: pos.atStop ? pos.prev.name : null,
            next: pos.atStop ? pos.next?.name ?? null : pos.next.name,
            nextEta: pos.next ? `${day.iso}T${hhmmss(pos.next.arr)}` : null,
          });
        }
      }
      return { vehicles };
    },
  };
}
