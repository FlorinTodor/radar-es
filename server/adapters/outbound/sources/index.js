// Registro de adaptadores de fuentes. Para añadir una fuente nueva:
//   1. Crear un fichero aquí que exporte createXxxSource(deps) → DataSourcePort
//      (o, si publica GTFS-Realtime estándar, reutilizar createGtfsRtVehicleSource).
//   2. Añadirlo a la lista de abajo.
// Si necesita clave, que declare `requires: ['NOMBRE_VARIABLE']` y se desactivará sola
// cuando la variable no esté en .env.
import { createRenfeSources } from './renfe.js';
import { createFgcSource } from './fgc.js';
import { createGtfsRtVehicleSource } from './gtfs-rt.js';
import { createTranviaTenerifeSource } from './tranvia-tenerife.js';
import { createMoveuskadiBusSource } from './moveuskadi-bus.js';
import { createOuigoHorarioSource } from './ouigo-horario.js';
import { createDgtSource } from './dgt.js';
import { createSctSource, createTraficoEuskadiSource } from './trafico-autonomico.js';
import { createIgnSismosSource } from './ign-sismos.js';
import { createAemetAvisosSource } from './aemet-avisos.js';
import { createFirmsSource } from './firms.js';
import { createReeSource } from './ree.js';

const MOVEUSKADI = 'https://opendata.euskadi.eus/transport/moveuskadi';

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, stations: import('../../../application/ports.js').StationCatalogPort,
 *           nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>,
 *           log: import('../../../application/ports.js').LoggerPort, env: Record<string, string|undefined> }} deps
 * @returns {import('../../../application/ports.js').DataSourcePort[]}
 */
export function createSources(deps) {
  return [
    // Ferrocarril
    ...createRenfeSources(deps),
    createFgcSource(deps),
    createOuigoHorarioSource(deps),
    // Metro y tranvía
    createGtfsRtVehicleSource(deps, {
      id: 'metro-bilbao',
      name: 'Metro Bilbao (GTFS-RT, Open Data Euskadi)',
      url: `${MOVEUSKADI}/metro_bilbao/gtfsrt_metro_bilbao_vehicle_positions.pb`,
      mode: 'metro',
      operator: 'Metro Bilbao',
      license: 'Open Data Euskadi · MoveUskadi',
      line: () => null, // el feed sólo trae routeId "MB"
      // El id de entidad es "ORIGEN_ORIGEN2_DESTINO_timestamp" con códigos de estación de 3 letras.
      describe: (e) => ({ destination: e.id?.split('_')[2] ?? null, current: e.id?.split('_')[0] ?? null }),
    }),
    createTranviaTenerifeSource(deps),
    // Autobús (se muestran, pero no cuentan para las alertas ferroviarias)
    createMoveuskadiBusSource(deps),
    createGtfsRtVehicleSource(deps, {
      id: 'emt-malaga', name: 'EMT Málaga (GTFS-RT)', mode: 'bus', operator: 'EMT Málaga', interval: 60_000,
      url: 'https://gtfs.emtmalaga.es/GTFSRTapi/api/vehicleposition',
    }),
    createGtfsRtVehicleSource(deps, {
      id: 'emt-fuenlabrada', name: 'EMT Fuenlabrada (GTFS-RT)', mode: 'bus', operator: 'EMT Fuenlabrada', interval: 60_000,
      url: 'https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=c-5cfcd2d1',
    }),
    // Carreteras
    createDgtSource(deps),
    createSctSource(deps),
    createTraficoEuskadiSource(deps),
    // Otras situaciones
    createAemetAvisosSource(deps),
    createFirmsSource(deps),
    createIgnSismosSource(deps),
    createReeSource(deps),
  ];
}
