// Adaptador de entrada: las métricas para la monitorización del VPS (GET /metrics, formato de texto de
// Prometheus). Escucha en otro puerto que la web y compose.yaml no lo publica: sólo llega a él la
// monitorización del propio VPS, nunca el túnel de Cloudflare ni nginx.
import { createServer } from 'node:http';

/**
 * @param {{ render: () => string, log: import('../../../application/ports.js').LoggerPort }} deps
 *   render: el texto de las métricas en este momento (main.js le pasa el estado de las fuentes).
 */
export function createMetricsServer({ render, log }) {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('No encontrado\n');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let body;
    try {
      body = render();
    } catch (err) {
      log.error(`[métricas] ${err.stack ?? err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Error interno\n');
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}
