// Comprobación del entorno de pruebas antes de dar una versión por buena para producción.
// La lanza deploy/actualizar.sh --pruebas con el node de la propia imagen y red del host:
//   docker run --rm -i --network host <imagen> node --input-type=module - < deploy/comprobar.mjs
// Compara con producción en el mismo momento: una fuente que falla en los dos sitios es un fallo
// de la fuente, no de la versión nueva, y no la para. Sale con 0 si todo va bien y con 1 si no.
//
// Variables: PRUEBAS y PRODUCCION (URL base), ESPERA (segundos para cargar todas las fuentes).

const PRUEBAS = process.env.PRUEBAS ?? 'http://127.0.0.1:8081';
const PRODUCCION = process.env.PRODUCCION ?? 'http://127.0.0.1:8080';
const ESPERA = Number(process.env.ESPERA ?? 1500) * 1000;
const VUELTA = 15_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(base, path) {
  const res = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20_000) });
  return { status: res.status, type: res.headers.get('content-type') ?? '', body: await res.text() };
}

async function json(base, path) {
  const r = await get(base, path);
  if (r.status !== 200) throw new Error(`${path} responde ${r.status}`);
  return JSON.parse(r.body);
}

// Producción puede estar caída o arrancando: entonces no hay con qué comparar y se exige todo.
async function okEnProduccion() {
  try {
    return new Set((await json(PRODUCCION, '/api/health')).filter((s) => s.ok).map((s) => s.id));
  } catch {
    return null;
  }
}

/** Espera a que carguen las fuentes. Devuelve la lista de problemas (vacía si todo va bien). */
async function fuentes() {
  const fin = Date.now() + ESPERA;
  let problemas = ['no se ha podido leer /api/health'];
  while (Date.now() < fin) {
    try {
      const pruebas = (await json(PRUEBAS, '/api/health')).filter((s) => s.enabled);
      const prod = await okEnProduccion();
      const pendientes = pruebas.filter((s) => !s.ok && !s.error && s.lastOk === null);
      const caidas = pruebas.filter((s) => !s.ok && !pendientes.includes(s) && (!prod || prod.has(s.id)));
      problemas = [
        ...pendientes.map((s) => `${s.id}: sin cargar todavía`),
        ...caidas.map((s) => `${s.id}: ${s.error ?? 'falla'}${prod ? ' (en producción funciona)' : ''}`),
      ];
      const ok = pruebas.filter((s) => s.ok).length;
      console.log(`fuentes: ${ok}/${pruebas.length} ok, ${pendientes.length} sin cargar, ${caidas.length} con error`);
      if (!problemas.length) return [];
    } catch (e) {
      problemas = [`/api/health: ${e.message}`];
    }
    await wait(VUELTA);
  }
  return problemas;
}

async function directo() {
  const problemas = [];
  const live = await json(PRUEBAS, '/api/live');
  const prod = await json(PRODUCCION, '/api/live').catch(() => null);
  const n = live.vehicles?.length ?? 0;
  const m = prod?.vehicles?.length ?? 0;
  console.log(`directo: ${n} vehículos en pruebas, ${prod ? m : '?'} en producción`);
  // Mismas fuentes en el mismo momento: la mitad o menos es que algo se ha roto al juntarlas.
  if (!n || (prod && n < m / 2)) problemas.push(`/api/live: ${n} vehículos (producción: ${m})`);
  for (const path of ['/api/live/events', '/api/live/buses']) {
    try {
      await json(PRUEBAS, path);
    } catch (e) {
      problemas.push(`${path}: ${e.message}`);
    }
  }
  return problemas;
}

// Todas las páginas del sitemap (se sirven sin .html) y los ficheros que carga el mapa.
async function paginas() {
  const sitemap = await get(PRUEBAS, '/sitemap.xml');
  const rutas = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
  if (!rutas.length) return ['/sitemap.xml no tiene páginas'];
  const problemas = [];
  for (const [path, tipo] of [...rutas.map((p) => [p, 'text/html']), ['/js/app.js', 'javascript'], ['/style.css', 'text/css']]) {
    try {
      const r = await get(PRUEBAS, path);
      if (r.status !== 200 || !r.type.includes(tipo)) problemas.push(`${path}: ${r.status} ${r.type}`);
    } catch (e) {
      problemas.push(`${path}: ${e.message}`);
    }
  }
  console.log(`páginas: ${rutas.length + 2 - problemas.length}/${rutas.length + 2} bien`);
  return problemas;
}

const problemas = await fuentes();
if (!problemas.length) {
  for (const paso of [directo, paginas]) problemas.push(...(await paso().catch((e) => [`${paso.name}: ${e.message}`])));
}
for (const p of problemas) console.log(`  ✗ ${p}`);
process.exit(problemas.length ? 1 : 0);
