// Registro de adaptadores de fuentes. Para añadir una fuente nueva:
//   1. Crear un fichero aquí que exporte createXxxSource(deps) → DataSourcePort
//      (o, si publica GTFS-Realtime estándar, reutilizar createGtfsRtVehicleSource).
//   2. Añadirlo a la lista de abajo.
// Si necesita clave, que declare `requires: ['NOMBRE_VARIABLE']` y se desactivará sola
// cuando la variable no esté en .env.
import { createRenfeSources } from './renfe.js';
import { createFgcSource } from './fgc.js';
import { createRodaliesSource } from './rodalies.js';
import { createGtfsRtVehicleSource } from './gtfs-rt.js';
import { createMoveuskadiBusSource } from './moveuskadi-bus.js';
import { createGtfsScheduleSource } from './gtfs-horario.js';
import { createDgtSource } from './dgt.js';
import { createSctSource, createTraficoEuskadiSource } from './trafico-autonomico.js';
import { createIgnSismosSource } from './ign-sismos.js';
import { createAemetAvisosSource } from './aemet-avisos.js';
import { createFirmsSource } from './firms.js';
import { createReeSource } from './ree.js';
import { createAvionesSource, createGdacsSource, createIodaSource } from './emergencias-extra.js';

const MOVEUSKADI = 'https://opendata.euskadi.eus/transport/moveuskadi';

// Redes sin GPS público cuyo horario GTFS del NAP está vigente: [id, nombre, operador, ficheroId del NAP].
// Metro de Madrid no está porque su GTFS en el NAP caducó en mayo de 2026.
const ESTIMATED_BY_SCHEDULE = [
  ['metro-barcelona', 'Metro de Barcelona (TMB)', 'Metro de Barcelona', 1328],
  ['tram-baix', 'TRAM Baix (Barcelona)', 'TRAM', 1329],
  ['tram-besos', 'TRAM Besòs (Barcelona)', 'TRAM', 1330],
  ['metro-ligero-madrid', 'Metro Ligero y tranvía de Madrid', 'Metro Ligero', 1427],
  ['metrovalencia', 'Metrovalencia y TRAM de Valencia', 'Metrovalencia', 1168],
  ['tram-alacant', "TRAM d'Alacant", "TRAM d'Alacant", 1167],
  ['metro-sevilla', 'Metro de Sevilla', 'Metro de Sevilla', 1583],
  ['tranvia-sevilla', 'Tranvía de Sevilla (Metrocentro)', 'Metrocentro', 1567],
  ['metro-malaga', 'Metro de Málaga', 'Metro de Málaga', 1497],
  ['metro-granada', 'Metro de Granada', 'Metro de Granada', 1568],
  ['tranvia-zaragoza', 'Tranvía de Zaragoza', 'Tranvía de Zaragoza', 1687],
  ['tranvia-murcia', 'Tranvía de Murcia', 'Tranvía de Murcia', 1569],
];

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
    createRodaliesSource(deps),
    createFgcSource(deps),
    createGtfsScheduleSource(deps, {
      id: 'ouigo-horario', name: 'Ouigo (posición estimada según horario)', operator: 'Ouigo', ficheroId: 1766, mode: 'av',
      label: (trip) => trip.label?.replace(/^TGV\s*/i, '') ?? trip.id,
    }),
    createGtfsScheduleSource(deps, {
      id: 'euskotren', name: 'Euskotren (horario + retraso en tiempo real)', operator: 'Euskotren', ficheroId: 1263,
      tripUpdatesUrl: `${MOVEUSKADI}/euskotren/gtfsrt_euskotren_trip_updates.pb`,
      license: 'Euskotren · Open Data Euskadi y NAP (posición estimada con retraso real)',
    }),
    ...ESTIMATED_BY_SCHEDULE.map(([id, name, operator, ficheroId]) => createGtfsScheduleSource(deps, {
      id: `horario-${id}`, name: `${name} (posición estimada según horario)`, operator, ficheroId,
    })),
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
    createGdacsSource(deps),
    createReeSource(deps),
    createIodaSource(deps),
    // Aire
    createAvionesSource(deps),
  ];
}
