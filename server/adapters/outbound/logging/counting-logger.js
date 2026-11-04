/**
 * El registro de siempre, contando en las métricas cada aviso y cada error: la monitorización avisa
 * si se disparan, sin tener que leer los mensajes.
 * @param {import('../../../application/ports.js').LoggerPort} log
 * @param {Pick<import('../../../application/ports.js').MetricsPort, 'logged'>} metrics
 * @returns {import('../../../application/ports.js').LoggerPort}
 */
export function withLogCounts(log, metrics) {
  return {
    info: (msg) => log.info(msg),
    warn: (msg) => {
      metrics.logged('warn');
      log.warn(msg);
    },
    error: (msg) => {
      metrics.logged('error');
      log.error(msg);
    },
  };
}
