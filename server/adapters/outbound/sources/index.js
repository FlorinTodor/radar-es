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
import { createGdacsSource } from './emergencias-extra.js';
import { createEmtMadridAlertsSource } from './emt-madrid.js';
import { busGroupSources } from './autobuses-nap.js';

const MOVEUSKADI = 'https://opendata.euskadi.eus/transport/moveuskadi';

// Redes sin GPS público cuyo horario GTFS del NAP está vigente:
// [id, nombre, operador, ficheroId del NAP, conjunto de datos del NAP, atribución que pide el operador].
// La licencia del NAP suma las condiciones del operador original: TMB pide citarlo con la fecha
// de actualización (licencia de developer.tmb.cat), TRAM "Powered by TRAM Barcelona" y el CRTM
// "Powered by CRTM". Metro de Madrid no está porque su GTFS en el NAP caducó en mayo de 2026.
const ESTIMATED_BY_SCHEDULE = [
  ['metro-barcelona', 'Metro de Barcelona (TMB)', 'Metro de Barcelona', 1328, 1127, 'Fuente: TMB'],
  ['tram-baix', 'TRAM Baix (Barcelona)', 'TRAM', 1329, 1128, 'Powered by TRAM Barcelona'],
  ['tram-besos', 'TRAM Besòs (Barcelona)', 'TRAM', 1330, 1129, 'Powered by TRAM Barcelona'],
  ['metro-ligero-madrid', 'Metro Ligero y tranvía de Madrid', 'Metro Ligero', 1427, 1226, 'Powered by CRTM'],
  ['metrovalencia', 'Metrovalencia y TRAM de Valencia', 'Metrovalencia', 1168, 967, 'Ferrocarrils de la Generalitat Valenciana (FGV)'],
  ['tram-alacant', "TRAM d'Alacant", "TRAM d'Alacant", 1167, 966, 'Ferrocarrils de la Generalitat Valenciana (FGV)'],
  ['metro-sevilla', 'Metro de Sevilla', 'Metro de Sevilla', 1583, 1385, 'Metro de Sevilla'],
  ['tranvia-sevilla', 'Tranvía de Sevilla (Metrocentro)', 'Metrocentro', 1567, 1369, 'TUSSAM'],
  ['metro-malaga', 'Metro de Málaga', 'Metro de Málaga', 1497, 1296, 'Metro de Málaga'],
  ['metro-granada', 'Metro de Granada', 'Metro de Granada', 1568, 1370, 'Agencia de Obra Pública de la Junta de Andalucía'],
  ['tranvia-zaragoza', 'Tranvía de Zaragoza', 'Tranvía de Zaragoza', 1687, 1394, 'Tranvía de Zaragoza'],
  ['tranvia-murcia', 'Tranvía de Murcia', 'Tranvía de Murcia', 1569, 1371, 'Tranvía de Murcia'],
];

/**
 * Metro Bilbao: el id de entidad es "ESTACIÓN_ESTACIÓN+VÍA_DESTINO_timestamp" ("AIB_AIB2_ETX_…") con
 * códigos de 3 letras, y la posición es la de esa estación (en la que está o la última por la que pasó);
 * su stopId es la misma estación. El trazado del viaje ("IBB_ETX") da el origen; su GTFS, los nombres.
 */
export function metroBilbao(e, gtfs) {
  const [here, , to] = e.id?.split('_') ?? [];
  const shape = gtfs?.trip(e.vehicle?.trip?.tripId)?.shape ?? null;
  const [from, end] = shape?.split('_') ?? [];
  const name = (code) => (code ? gtfs?.stop(code)?.name ?? code : null);
  return {
    origin: name(from),
    destination: name(to ?? end),
    current: name(here),
    next: null,
    shape,
    end: gtfs?.stop(to ?? end)?.at ?? null,
  };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, stations: import('../../../application/ports.js').StationCatalogPort,
 *           nap: ReturnType<typeof import('../nap/nap-client.js').createNapClient>,
 *           log: import('../../../application/ports.js').LoggerPort, env: Record<string, string|undefined>,
 *           pool?: import('../workers/cpu-pool.js').CpuPool }} deps  pool: hilos de cálculo (horarios, XML de la DGT).
 * @returns {import('../../../application/ports.js').DataSourcePort[]}
 */
export function createSources(deps) {
  return [
    // Ferrocarril
    ...createRenfeSources(deps),
    createRodaliesSource(deps),
    createFgcSource(deps),
    createGtfsScheduleSource(deps, {
      id: 'ouigo-horario', name: 'Ouigo (posición estimada según horario)', operator: 'Ouigo', ficheroId: 1766, dataset: 1515, mode: 'av',
      label: (trip) => trip.label?.replace(/^TGV\s*/i, '') ?? trip.id,
    }),
    createGtfsScheduleSource(deps, {
      id: 'euskotren', name: 'Euskotren (horario + retraso en tiempo real)', operator: 'Euskotren', ficheroId: 1263, dataset: 1062,
      tripUpdatesUrl: `${MOVEUSKADI}/euskotren/gtfsrt_euskotren_trip_updates.pb`,
      license: 'Powered by MITRAMS (horario, Punto de Acceso Nacional) · Open Data Euskadi, CC BY 4.0 (retrasos) · '
        + 'Posición estimada a partir del horario (dato explotado, no GPS)',
    }),
    ...ESTIMATED_BY_SCHEDULE.map(([id, name, operator, ficheroId, dataset, credit]) => createGtfsScheduleSource(deps, {
      id: `horario-${id}`, name: `${name} (posición estimada según horario)`, operator, ficheroId, dataset, credit,
    })),
    // Metro y tranvía
    createGtfsRtVehicleSource(deps, {
      id: 'metro-bilbao',
      name: 'Metro Bilbao (GTFS-RT, Open Data Euskadi)',
      url: `${MOVEUSKADI}/metro_bilbao/gtfsrt_metro_bilbao_vehicle_positions.pb`,
      mode: 'metro',
      operator: 'Metro Bilbao',
      license: 'Open Data Euskadi · MoveUskadi (CC BY 4.0): posiciones y horario (nombres de estación). Formato adaptado, contenido sin alterar',
      line: () => null, // el feed sólo trae routeId "MB"
      staticUrl: `${MOVEUSKADI}/metro_bilbao/gtfs_metro_bilbao.zip`,
      describe: metroBilbao,
    }),
    // Autobús (se muestran, pero no cuentan para las alertas ferroviarias)
    createMoveuskadiBusSource(deps),
    // ALSA sólo publica su horario: nadie (ni ALSA ni los consorcios) publica en abierto su tiempo
    // real. Cuando suba un GTFS-RT al NAP, pasar a posiciones reales.
    createGtfsScheduleSource(deps, {
      id: 'alsa-horario', name: 'ALSA autobuses (posición estimada según horario)', operator: 'ALSA', ficheroId: 1133, dataset: 932,
      mode: 'bus', interval: 60_000,
      line: (name) => name?.replace(/^ALSA\s*-\s*/i, '') || null, // "ALSA - 710" → "710"
    }),
    // AMB publica sus retrasos (trip updates, sin posiciones): posición estimada con el retraso real.
    createGtfsScheduleSource(deps, {
      id: 'amb-bus', name: 'AMB: autobús metropolitano de Barcelona (horario + retraso en tiempo real)', operator: 'AMB',
      ficheroId: 1496, dataset: 1295, mode: 'bus', interval: 60_000,
      tripUpdatesUrl: 'https://www.ambmobilitat.cat/transit/trips-updates/trips.bin',
      license: 'Powered by MITRAMS (Punto de Acceso Nacional) · AMB Àrea Metropolitana de Barcelona · '
        + 'Posición estimada a partir del horario y del retraso real (dato explotado, no GPS)',
    }),
    createGtfsRtVehicleSource(deps, {
      id: 'la-union', name: 'Autobuses La Unión (GTFS-RT)', mode: 'bus', operator: 'La Unión', interval: 60_000,
      license: 'Powered by MITRAMS (Punto de Acceso Nacional) · Autobuses La Unión · Datos en bruto',
      url: 'https://ctb-gtfs-rt.s3.eu-south-2.amazonaws.com/la-union-vehicle-positions.pb',
    }),
    // AUVASA lo publica en su web con CC BY 3.0 ES ("Fuente: AUVASA"); sólo por http y en una IP.
    createGtfsRtVehicleSource(deps, {
      id: 'auvasa', name: 'AUVASA: autobús urbano de Valladolid (GTFS-RT)', mode: 'bus', operator: 'AUVASA', interval: 60_000,
      license: 'Fuente: AUVASA (CC BY 3.0 ES)',
      url: 'http://212.170.201.204:50080/GTFSRTapi/api/vehicleposition',
      line: (e) => e.vehicle?.trip?.tripId?.split('_')[0] ?? e.vehicle?.trip?.routeId ?? null, // "LB5_LB5A1_7" → "LB5"
    }),
    ...busGroupSources(deps, createGtfsScheduleSource),
    createGtfsRtVehicleSource(deps, {
      id: 'emt-malaga', name: 'EMT Málaga (GTFS-RT)', mode: 'bus', operator: 'EMT Málaga', interval: 60_000,
      // El portal de datos abiertos de Málaga declara para estos datos CC BY-SA 4.0: se cumple la más estricta.
      license: 'Powered by MITRAMS (Punto de Acceso Nacional) · EMT Málaga, Ayuntamiento de Málaga · Datos en bruto, CC BY-SA 4.0',
      url: 'https://gtfs.emtmalaga.es/GTFSRTapi/api/vehicleposition',
    }),
    createGtfsRtVehicleSource(deps, {
      id: 'emt-fuenlabrada', name: 'EMT Fuenlabrada (GTFS-RT)', mode: 'bus', operator: 'EMT Fuenlabrada', interval: 60_000,
      license: 'Powered by MITRAMS (Punto de Acceso Nacional) · EMT Fuenlabrada · Datos en bruto',
      url: 'https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=c-5cfcd2d1',
    }),
    // Carreteras
    createDgtSource(deps),
    createEmtMadridAlertsSource(deps),
    createSctSource(deps),
    createTraficoEuskadiSource(deps),
    // Otras situaciones
    createAemetAvisosSource(deps),
    createFirmsSource(deps),
    createIgnSismosSource(deps),
    createGdacsSource(deps),
    createReeSource(deps),
  ];
}
