// Ferrocarrils de la Generalitat de Catalunya: posición de los trenes en servicio.
// Portal de datos abiertos de FGC (Opendatasoft), sin clave.
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { madridLocalToMs } from './parse.js';
import { tripStopList } from '../../../domain/trip-stops.js';
import { followOf, lineKey } from '../../../domain/seguir.js';

/** Cada cuánto se lee la API de FGC (ver el cupo diario en la fuente). */
export const FGC_INTERVAL_MS = 45_000;
/** Peticiones al día que admite la API de FGC por IP. */
export const FGC_DAILY_QUOTA = 5000;
const BASE = 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100';
// Horario GTFS de FGC en el Punto de Acceso Nacional: el mismo fichero del que salen los trazados de
// sus líneas. Sus stop_id son los códigos que da la posición de cada tren ("PE", "AL"…).
const FGC_GTFS = 1571;
const FGC_DATASET = 1373; // su conjunto de datos en el NAP: de él sale la fecha de actualización
const DAY_MS = 24 * 3600_000;
// La copia en disco la renueva cada día el catálogo de líneas: aquí sólo se lee y, si falta o tiene más de
// 30 días, se descarga.
const GTFS_MAX_AGE_MS = 30 * DAY_MS;

/** Códigos de estación de FGC → { name, at: [lon, lat] }, del stops.txt de su GTFS (sin los andenes). */
export function fgcStations(stopsTxt) {
  const stations = new Map();
  for (const s of csvRows(stopsTxt)) {
    if (!s.stop_id || !s.stop_name || s.parent_station) continue;
    const at = [+s.stop_lon, +s.stop_lat];
    stations.set(s.stop_id, { name: s.stop_name.trim(), at: at.every(Number.isFinite) ? at : null });
  }
  return stations;
}

/**
 * Códigos de las paradas de un tren de FGC: su origen y la última estación en la que ha estado (ya
 * pasadas) y las que le quedan, que FGC da en `properes_parades` («{"parada": "SG"};{"parada": "GR"}»),
 * acabando en su destino. FGC no da las que hay entre el origen y la última en la que ha estado: en
 * cuanto sale del origen, la lista es parcial. En el origen todavía (estacionado en él), está en la
 * primera y ninguna está pasada.
 * @returns {{ codes: string[], from: number, partial: boolean, here: boolean } | null}
 */
export function fgcTripCodes(r) {
  const ahead = [...String(r.properes_parades ?? '').matchAll(/"parada":\s*"([^"]+)"/g)].map((m) => m[1]);
  if (r.desti && ahead.at(-1) !== r.desti) ahead.push(r.desti);
  const atOrigin = r.estacionat_a && r.estacionat_a === r.origen;
  const passed = [r.origen, r.estacionat_a].filter((c, i, all) => c && all.indexOf(c) === i && !ahead.includes(c));
  const codes = [...passed, ...ahead];
  if (codes.length < 2) return null;
  return atOrigin ? { codes, from: 0, partial: false, here: true } : { codes, from: passed.length, partial: passed.length > 0, here: false };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, nap?: { enabled: boolean, gtfs: (id: number, maxAgeMs?: number) => Promise<Uint8Array> },
 *           log?: import('../../../application/ports.js').LoggerPort }} deps
 */
export function createFgcSource({ http, nap, log }) {
  // La API de posiciones sólo da códigos de estación: sin el GTFS (falta la clave del NAP o no
  // responde), se muestran los códigos y no se sabe dónde acaba cada tren.
  let stations = null;
  let namesAt = 0;
  // Fecha de actualización del horario del NAP: su licencia pide conservarla y mostrarla con lo que sale de él.
  let gtfsUpdated = null;
  async function loadNames() {
    if (!nap?.enabled || Date.now() - namesAt < DAY_MS) return;
    namesAt = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      stations = fgcStations((await openGtfs(await nap.gtfs(FGC_GTFS, GTFS_MAX_AGE_MS), ['stops.txt']))['stops.txt']);
      const updated = nap.updatedAt ? await nap.updatedAt(FGC_DATASET, FGC_GTFS).catch(() => null) : null;
      gtfsUpdated = madridLocalToMs(updated) ?? gtfsUpdated;
    } catch (err) {
      log?.warn(`[fgc] nombres de estación: ${err.message}`);
    }
  }
  const name = (code) => (code ? stations?.get(code)?.name ?? code : null);
  // Paradas de cada tren de la última lectura (fgcTripCodes): para su ficha (tripStops).
  let trips = new Map();

  return {
    id: 'fgc',
    name: 'FGC (Ferrocarrils de la Generalitat de Catalunya)',
    kind: 'vehicles',
    // La API de FGC da 5.000 peticiones al día por IP (cabeceras x-ratelimit-*; se renueva a las 00:00 UTC),
    // y desde el VPS leen producción y pruebas. Cada 30 s eran 5.760 al día entre las dos: el cupo se
    // agotaba hacia las 22:30 (HTTP 429 hasta la 01:00). Cada 45 s son 3.840, con margen para los relevos.
    interval: FGC_INTERVAL_MS,
    url: BASE,
    license: 'Ferrocarrils de la Generalitat de Catalunya (CC BY 4.0). Formato adaptado. Nombres de estación y trazados de su '
      + 'horario GTFS del Punto de Acceso Nacional: Powered by MITRAMS (dato explotado)',
    /** Paradas de su viaje que se saben, sin hora (FGC no la da). null si no se saben; undefined si no es de FGC. */
    tripStops(vehicleId) {
      const trip = trips.get(vehicleId);
      if (!trip) return vehicleId.startsWith('fgc:') ? null : undefined;
      return tripStopList(trip.codes.map((code) => ({ name: name(code), at: stations?.get(code)?.at ?? null })), trip.from, { partial: trip.partial, here: trip.here });
    },
    async fetch() {
      await loadNames();
      const vehicles = [];
      const next = new Map();
      // La API pagina de 100 en 100; FGC rara vez pasa de 100 trenes, pero por si acaso.
      for (let offset = 0; offset < 500; offset += 100) {
        const d = await http.json(`${BASE}&offset=${offset}`);
        for (const r of d.results ?? []) {
          const p = r.geo_point_2d;
          if (!p || !Number.isFinite(p.lat)) continue;
          // Sin unidad ni identificador, o sin línea, el registro no es de un tren: FGC da a veces uno con
          // las columnas descolocadas (la línea en ocupacio_mi_tram, el origen en ocupacio_ri_tram…). No se
          // recoloca a ojo: se descarta, y todos los así acabarían con el mismo id «fgc:undefined».
          if (!(r.ut || r.id) || !r.lin) continue;
          const trip = fgcTripCodes(r);
          // FGC da a veces dos registros de la misma unidad: valen las paradas del primero, el de su ficha.
          if (trip && !next.has(`fgc:${r.ut || r.id}`)) next.set(`fgc:${r.ut || r.id}`, trip);
          vehicles.push({
            id: `fgc:${r.ut || r.id}`,
            // L6, L7, L8, L12: servicio urbano tipo metro. S/R: suburbano.
            mode: /^L/.test(r.lin) ? 'metro' : 'cercanias',
            operator: 'FGC',
            service: 'FGC',
            line: r.lin,
            label: r.ut || r.lin,
            // Sólo su línea: FGC da la unidad (el tren físico), no un número de servicio que se repita cada día.
            follow: followOf(lineKey({ operator: 'FGC', line: r.lin })),
            lat: p.lat,
            lon: p.lon,
            delay: null,
            late: r.en_hora === 'False' ? true : r.en_hora === 'True' ? false : null,
            origin: name(r.origen),
            destination: name(r.desti),
            current: name(r.estacionat_a),
            next: name((r.properes_parades ?? '').match(/"parada":\s*"([^"]+)"/)?.[1]),
            rollingStock: r.tipus_unitat ? `Serie ${r.tipus_unitat}` : null,
            // Donde acaba su viaje: el mapa dibuja lo que le queda por el trazado de su línea.
            end: stations?.get(r.desti)?.at ?? null,
            ...(trip ? { stops: true } : {}), // sus paradas: /api/stops
          });
        }
        if ((d.results?.length ?? 0) < 100) break;
      }
      trips = next;
      return { vehicles, ...(stations && gtfsUpdated ? { datasetUpdated: gtfsUpdated } : {}) };
    },
  };
}
