// Caso de uso: recargar los catálogos estáticos (estaciones de Renfe y de las demás redes, trazados de
// las líneas y red ferroviaria general). Lo dispara el arranque y, cada pocas horas, el planificador.
// Cada catálogo decide si su copia en disco sigue vigente o hay que descargarlo otra vez.

/**
 * @param {{ stations: import('../ports.js').StationCatalogPort, network: import('../ports.js').NetworkCatalogPort,
 *           log: import('../ports.js').LoggerPort, networkStations?: import('../ports.js').StationCatalogPort,
 *           railNetwork?: import('../ports.js').RailNetworkPort }} deps
 *   networkStations: estaciones de metro, tranvía y otras redes; usan las de Renfe (sus fotos), así que van después.
 */
export function makeRefreshCatalogs({ stations, networkStations, network, railNetwork, log }) {
  /**
   * Termina cuando las estaciones están cargadas: las fichas y las alertas las necesitan. Las de las
   * otras redes sólo hacen esperar a leer su copia (lo que tarden en recalcularse va detrás): así la
   * lista que se sirve, y que Cloudflare guarda una hora, ya las lleva. Los trazados tardan en
   * construirse la primera vez (~40 MB de GTFS) y la red ferroviaria sólo hace falta para dibujar
   * recorridos, así que se cargan detrás sin bloquear; si fallan, sólo se registra.
   * @returns {Promise<void>}
   */
  return async function refreshCatalogs() {
    await stations.load();
    await networkStations?.load().catch((err) => log.warn(`[estaciones de otras redes] ${err.message}`));
    network.load().catch((err) => log.warn(`[líneas] ${err.message}`));
    railNetwork?.load().catch((err) => log.warn(`[red ferroviaria] ${err.message}`));
  };
}
