// Ferrocarrils de la Generalitat de Catalunya: posición de los trenes en servicio.
// Portal de datos abiertos de FGC (Opendatasoft), sin clave.
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';

const BASE = 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100';
// Horario GTFS de FGC en el Punto de Acceso Nacional: el mismo fichero del que salen los trazados de
// sus líneas. Sus stop_id son los códigos que da la posición de cada tren ("PE", "AL"…).
const FGC_GTFS = 1571;
const DAY_MS = 24 * 3600_000;
// La copia en disco la renueva cada semana el catálogo de líneas: aquí sólo se lee y, si falta, se descarga.
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
 * @param {{ http: import('../http/http-client.js').HttpClient, nap?: { enabled: boolean, gtfs: (id: number, maxAgeMs?: number) => Promise<Uint8Array> },
 *           log?: import('../../../application/ports.js').LoggerPort }} deps
 */
export function createFgcSource({ http, nap, log }) {
  // La API de posiciones sólo da códigos de estación: sin el GTFS (falta la clave del NAP o no
  // responde), se muestran los códigos y no se sabe dónde acaba cada tren.
  let stations = null;
  let namesAt = 0;
  async function loadNames() {
    if (!nap?.enabled || Date.now() - namesAt < DAY_MS) return;
    namesAt = Date.now(); // aunque falle, no reintentar en cada lectura
    try {
      stations = fgcStations((await openGtfs(await nap.gtfs(FGC_GTFS, GTFS_MAX_AGE_MS), ['stops.txt']))['stops.txt']);
    } catch (err) {
      log?.warn(`[fgc] nombres de estación: ${err.message}`);
    }
  }
  const name = (code) => (code ? stations?.get(code)?.name ?? code : null);

  return {
    id: 'fgc',
    name: 'FGC (Ferrocarrils de la Generalitat de Catalunya)',
    kind: 'vehicles',
    interval: 30_000,
    url: BASE,
    license: 'Ferrocarrils de la Generalitat de Catalunya (CC BY 4.0), con los nombres de estación de su horario GTFS. Formato adaptado',
    async fetch() {
      await loadNames();
      const vehicles = [];
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
          vehicles.push({
            id: `fgc:${r.ut || r.id}`,
            // L6, L7, L8, L12: servicio urbano tipo metro. S/R: suburbano.
            mode: /^L/.test(r.lin) ? 'metro' : 'cercanias',
            operator: 'FGC',
            service: 'FGC',
            line: r.lin,
            label: r.ut || r.lin,
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
          });
        }
        if ((d.results?.length ?? 0) < 100) break;
      }
      return { vehicles };
    },
  };
}
