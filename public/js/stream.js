// Datos en directo por consulta periódica a JSON que Cloudflare guarda unos segundos: el servidor
// trabaja lo mismo con 100 personas que con 100.000, y si se cae Cloudflare sigue sirviendo la
// última copia (aquí se avisa de su antigüedad). Las fuentes se leen cada 30–60 s, así que
// consultar cada 15 s apenas añade retraso. Si una consulta falla (un 502 mientras se reinicia el
// servidor en un despliegue, por ejemplo) se reintenta con esperas crecientes hasta 1 min.
//   /api/live          posiciones (sin autobuses), recuentos, alertas e indicadores
//   /api/live/events   incidencias (cambian poco y pesan mucho)
//   /api/live/buses    autobuses, sólo con su capa activa
//   /api/health        estado de las fuentes
const EVERY = { live: 15_000, events: 60_000, buses: 20_000, health: 60_000 };
const RETRY_MAX_MS = 60_000;
const STALE_MS = 120_000; // datos con más de 2 min: el servidor no se está actualizando

/**
 * @param {{ status: (s: 'live'|'connecting'|'error'|'stale', ageMs?: number) => void, live: Function, events: Function,
 *           buses: Function, health: Function }} handlers
 * @param {{ buses?: boolean }} [options]  buses: pedir también los autobuses (sólo si su capa está activa).
 * @returns {{ setBuses: (on: boolean) => void }}
 */
export function connect(handlers, { buses = false } = {}) {
  const feeds = {
    live: { url: '/api/live', on: true },
    events: { url: '/api/live/events', on: true },
    buses: { url: '/api/live/buses', on: buses },
    health: { url: '/api/health', on: true },
  };
  let lastOk = 0;

  async function poll(name) {
    const feed = feeds[name];
    clearTimeout(feed.timer);
    if (!feed.on) return;
    if (document.hidden) { // con la pestaña oculta no se consulta; se retoma al volver
      feed.paused = true;
      return;
    }
    const gen = (feed.gen = (feed.gen ?? 0) + 1);
    let wait = EVERY[name] * (0.9 + Math.random() * 0.2); // algo de azar para no llegar todos a la vez
    try {
      const res = await fetch(feed.url, { cache: 'no-cache' }); // el navegador revalida con ETag (304)
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (gen !== feed.gen || !feed.on) return; // respuesta tardía de una consulta ya sustituida
      feed.failures = 0;
      handlers[name](data);
      if (name === 'live') {
        lastOk = Date.now();
        const age = Date.now() - (data.generatedAt ?? Date.now());
        handlers.status(age > STALE_MS ? 'stale' : 'live', age);
      }
    } catch (err) {
      if (gen !== feed.gen) return;
      feed.failures = (feed.failures ?? 0) + 1;
      wait = Math.min(5000 * 2 ** (feed.failures - 1), RETRY_MAX_MS) * (0.75 + Math.random() / 2);
      if (name === 'live') handlers.status(Date.now() - lastOk > 60_000 ? 'error' : 'connecting');
      console.warn(`[directo] ${feed.url}: ${err.message}`);
    }
    if (feed.on) feed.timer = setTimeout(() => poll(name), wait);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    for (const [name, feed] of Object.entries(feeds)) {
      if (feed.paused) {
        feed.paused = false;
        poll(name);
      }
    }
  });

  handlers.status('connecting');
  for (const name of Object.keys(feeds)) poll(name);

  return {
    setBuses(on) {
      if (on === feeds.buses.on) return;
      feeds.buses.on = on;
      clearTimeout(feeds.buses.timer);
      if (on) poll('buses');
      else handlers.buses(null); // fuera los autobuses
    },
  };
}
