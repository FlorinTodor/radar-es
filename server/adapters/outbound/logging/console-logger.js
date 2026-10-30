/** @returns {import('../../../application/ports.js').LoggerPort} */
export function createConsoleLogger() {
  const ts = () => new Date().toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid' });
  return {
    info: (msg) => console.log(`${ts()} ${msg}`),
    warn: (msg) => console.warn(`${ts()} ⚠ ${msg}`),
    error: (msg) => console.error(`${ts()} ✖ ${msg}`),
  };
}
