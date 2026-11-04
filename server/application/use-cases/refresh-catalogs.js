// Caso de uso: recargar los catálogos estáticos (estaciones de Renfe y de las demás redes, trazados de
// las líneas, red ferroviaria general y vías de toda España). Lo dispara el arranque y, cada hora, el planificador.
// Cada catálogo decide si su copia en disco sigue vigente o hay que descargarlo otra vez.

/**
 * @param {{ stations: import('../ports.js').StationCatalogPort, network: import('../ports.js').NetworkCatalogPort,
 *           log: import('../ports.js').LoggerPort, networkStations?: import('../ports.js').StationCatalogPort,
 *           railNetwork?: import('../ports.js').RailNetworkPort, railGeometry?: import('../ports.js').RailNetworkPort }} deps
 *   railGeometry: vías de toda España con metro y tranvía (para llevar a la vía los trazados que se salen).
 *   networkStations: estaciones de metro, tranvía y otras redes; usan las de Renfe (sus fotos), así que van después.
 */
export function makeRefreshCatalogs({ stations, networkStations, network, railNetwork, railGeometry, log }) {
  // Lo que sigue cargando de la vez anterior: el planificador lo pide cada hora, y una carga que
  // tarde más (un trazado que se rehace entero con el NAP lento) no se duplica.
  const running = {};
  const once = (name, load) => (running[name] ??= Promise.resolve().then(load).finally(() => { running[name] = null; }));

  /**
   * Termina cuando las estaciones están cargadas: las fichas y las alertas las necesitan. Las de las
   * otras redes sólo hacen esperar a leer su copia (lo que tarden en recalcularse va detrás): así la
   * lista que se sirve, y que Cloudflare guarda una hora, ya las lleva. Los trazados tardan en
   * construirse la primera vez (~40 MB de GTFS) y la red ferroviaria sólo hace falta para dibujar
   * recorridos, así que se cargan detrás sin bloquear; si fallan, sólo se registra.
   * @returns {Promise<void>}
   */
  return async function refreshCatalogs() {
    await once('stations', () => stations.load());
    await once('networkStations', () => networkStations?.load()).catch((err) => log.warn(`[estaciones de otras redes] ${err.message}`));
    once('network', () => network.load()).catch((err) => log.warn(`[líneas] ${err.message}`));
    once('railNetwork', () => railNetwork?.load()).catch((err) => log.warn(`[red ferroviaria] ${err.message}`));
    once('railGeometry', () => railGeometry?.load()).catch((err) => log.warn(`[vías del IGN] ${err.message}`));
  };
}
