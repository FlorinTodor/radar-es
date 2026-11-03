// Caso de uso: las líneas de metro, tranvía y Cercanías por la vía. Hay operadores que publican el trazado
// de sus líneas casi sólo con las estaciones, o no lo publican, y entre estación y estación la recta se
// sale de la vía. Con la red de vías detallada, esos tramos se rehacen por ella (domain/rail-match.js,
// refineToRail). Se presenta como el mismo catálogo de líneas: el mapa, los recorridos y lo que le queda
// a cada tren los usan sin saber de dónde salen.
// Rehacerlas cuesta: se hace detrás, una línea cada vez y cediendo el turno entre una y otra, cuando
// cambian las líneas o la red. Mientras tanto se sirven las del operador, como antes.
import { refineToRail } from '../../domain/rail-match.js';

/**
 * @param {{ network: import('../ports.js').NetworkCatalogPort, railGeometry?: import('../ports.js').RailNetworkPort | null,
 *           yieldTurn?: () => Promise<void> }} deps
 *   railGeometry: red de vías detallada (con metro y tranvía); sin ella, las líneas van como las publica cada operador.
 *   yieldTurn: cómo se cede el turno entre línea y línea (en los tests, nada).
 * @returns {import('../ports.js').NetworkCatalogPort}
 */
export function makeLinesOnRail({ network, railGeometry = null, yieldTurn = () => new Promise((resolve) => setImmediate(resolve)) }) {
  let from = null; // líneas y red con las que se prepararon las de `ready`
  let fromNet = null;
  let ready = null;
  let refined = new Set(); // redes con algún tramo rehecho: su atribución cita la red de vías
  let job = null;
  let provisional = null; // { base, value }: las del operador marcadas como provisionales (el mismo objeto cada vez)
  const provisionalOf = (base) => {
    if (provisional?.base !== base) provisional = { base, value: { ...base, provisional: true } };
    return provisional.value;
  };

  async function prepare(base, net) {
    const features = [];
    const touched = new Set();
    for (const f of base.features) {
      const coords = f.geometry?.type === 'LineString' ? f.geometry.coordinates : null;
      const out = coords ? refineToRail(net, coords) : coords;
      if (out !== coords) {
        touched.add(f.properties?.network);
        features.push({ ...f, geometry: { ...f.geometry, coordinates: out } });
      } else features.push(f);
      await yieldTurn();
    }
    // Si mientras tanto han cambiado las líneas o la red, esto ya no vale: lo rehará la siguiente consulta.
    if (network.lines() !== base || railGeometry.network() !== net) return;
    provisional = null;
    ready = { ...base, features };
    refined = touched;
    from = base;
    fromNet = net;
  }

  // Mientras se rehacen (o mientras la red de vías se carga por primera vez) se sirven las del operador
  // marcadas `provisional`: el servidor web no las guarda ni deja que Cloudflare las guarde (ver
  // http-server.js), y así nadie se queda una hora con las líneas sin rehacer tras cada despliegue.
  const lines = () => {
    const base = network.lines();
    const net = railGeometry?.network() ?? null;
    if (!base) return base;
    if (!net) return railGeometry?.pending?.() ? provisionalOf(base) : base;
    if (base === from && net === fromNet) return ready;
    job ??= prepare(base, net).finally(() => { job = null; });
    // Hasta que estén, las rehechas con la red anterior (si son de estas mismas líneas) o las del operador.
    return ready && from === base ? ready : provisionalOf(base);
  };

  return {
    load: () => network.load(),
    lines,
    /** Las de cada operador y, en las redes con algún tramo rehecho, también la de la red de vías. */
    sources: () => {
      const credit = railGeometry?.credit;
      return network.sources().map((s) => (credit && refined.has(s.name) && from === network.lines() ? { ...s, credit: `${s.credit} · Vía: ${credit}` } : s));
    },
    /** Termina cuando las líneas por la vía están listas (para los tests y herramientas). */
    settled: () => job ?? Promise.resolve(),
  };
}
