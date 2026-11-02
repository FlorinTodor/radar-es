// Caso de uso: recargar los catálogos estáticos (estaciones de Renfe, trazados de las líneas y red
// ferroviaria general). Lo dispara el arranque y, cada pocas horas, el planificador. Cada catálogo
// decide si su copia en disco sigue vigente o hay que descargarlo otra vez.

/**
 * @param {{ stations: import('../ports.js').StationCatalogPort, network: import('../ports.js').NetworkCatalogPort,
 *           railNetwork?: import('../ports.js').RailNetworkPort, log: import('../ports.js').LoggerPort }} deps
 */
export function makeRefreshCatalogs({ stations, network, railNetwork, log }) {
  /**
   * Termina cuando las estaciones están cargadas: las fichas y las alertas las necesitan. Los
   * trazados tardan en construirse la primera vez (~40 MB de GTFS) y la red ferroviaria sólo hace
   * falta para dibujar recorridos, así que se cargan detrás sin bloquear; si fallan, sólo se registra.
   * @returns {Promise<void>}
   */
  return async function refreshCatalogs() {
    await stations.load();
    network.load().catch((err) => log.warn(`[líneas] ${err.message}`));
    railNetwork?.load().catch((err) => log.warn(`[red ferroviaria] ${err.message}`));
  };
}
