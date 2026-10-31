// Caso de uso: recargar los catálogos estáticos (estaciones de Renfe y trazados de las líneas).
// Lo dispara el arranque y, cada pocas horas, el planificador. Cada catálogo decide si su copia
// en disco sigue vigente o hay que descargarlo otra vez.

/**
 * @param {{ stations: import('../ports.js').StationCatalogPort, network: import('../ports.js').NetworkCatalogPort,
 *           log: import('../ports.js').LoggerPort }} deps
 */
export function makeRefreshCatalogs({ stations, network, log }) {
  /**
   * Termina cuando las estaciones están cargadas: las fichas y las alertas las necesitan. Los
   * trazados tardan en construirse la primera vez (~40 MB de GTFS), así que se cargan detrás sin
   * bloquear; si fallan, sólo se registra.
   * @returns {Promise<void>}
   */
  return async function refreshCatalogs() {
    await stations.load();
    network.load().catch((err) => log.warn(`[líneas] ${err.message}`));
  };
}
