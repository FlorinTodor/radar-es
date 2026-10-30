// Conexión SSE con el servidor. EventSource reconecta solo; aquí sólo informamos del estado.
export function connect(handlers) {
  const es = new EventSource('/api/stream');
  const on = (name, fn) => es.addEventListener(name, (e) => {
    try {
      fn(JSON.parse(e.data));
    } catch (err) {
      console.error(`[stream] ${name}`, err);
    }
  });
  on('snapshot', handlers.snapshot);
  on('source', handlers.source);
  on('health', handlers.health);
  on('alerts', handlers.alerts);
  es.addEventListener('open', () => handlers.status?.('live'));
  es.addEventListener('error', () => handlers.status?.(es.readyState === EventSource.CLOSED ? 'error' : 'connecting'));
  return es;
}
