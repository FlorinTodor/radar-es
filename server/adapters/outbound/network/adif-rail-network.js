// Red ferroviaria general: los «Tramos en servicio» que Adif publica en abierto en ArcGIS Online
// (item 4ec7c0fb3cab42b0b488d65e65eeb7aa, propietario ideadif_adif). Sirve para dibujar por la vía el
// recorrido de los trenes de Alta Velocidad, Larga y Media Distancia.
// Licencia: se permite cualquier uso mencionando la autoría «© Administrador de infraestructuras
// ferroviarias» (va en la atribución del mapa y en /legal).
// La red cambia pocas veces al año: se descarga una vez al mes (1.174 tramos, ~2 MB, en una sola
// petición). Si la descarga falla se sigue con la copia guardada y, sin ella, sin red: el recorrido
// vuelve a dibujarse con rectas.
import { createHash } from 'node:crypto';
import { GAUGE, buildRailNetwork } from '../../../domain/rail-match.js';

export const ADIF_TRAMOS_URL = 'https://services7.arcgis.com/XTupIrLX53AjaJqO/arcgis/rest/services/'
  + 'Tramos_en_servicio_Adif_p%C3%BAblico/FeatureServer/0/query?where=1%3D1&outFields=CODTRAMO,COD_ANCHO_,DEPORIGEN,DEPDESTINO'
  + '&outSR=4326&geometryPrecision=5&maxAllowableOffset=0.00002&f=geojson';
const CACHE_NAME = 'adif-tramos-en-servicio-v2.geojson'; // v2: con el ancho de vía y las estaciones de cada extremo
const MAX_AGE_MS = 30 * 24 * 3600_000;
// La red tiene ~1.200 tramos: muchos menos es una respuesta rota (ArcGIS contesta los errores con un
// 200 y un JSON de error) y no se guarda.
const MIN_TRAMOS = 500;
// COD_ANCHO_ de Adif: I ibérico (1.668 mm), U estándar o internacional (1.435 mm), MI mixto (tercer
// carril, para los dos) y ME métrico (1.000 mm, la antigua Feve).
const GAUGES = { I: GAUGE.iberian, U: GAUGE.standard, MI: GAUGE.mixed, ME: GAUGE.metric };

/**
 * Tramos del GeoJSON de Adif como líneas [lon, lat], con el ancho de vía de cada una y el código de la
 * estación o bifurcación de cada extremo (los de Renfe; «0» es sin código). Lanza si la respuesta no es
 * la red. `truncated`: ArcGIS ha cortado la respuesta en su máximo de registros (hoy 2.000), y faltan tramos.
 * @param {Uint8Array} bytes
 * @param {number} [minTramos]
 * @returns {{ lines: Array<Array<[number, number]>>, gauges: number[], codes: Array<[string|null, string|null]>, truncated: boolean }}
 */
export function parseTramos(bytes, minTramos = MIN_TRAMOS) {
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('la respuesta de Adif no es JSON');
  }
  if (data?.error) throw new Error(`Adif responde con error ${data.error.code ?? ''}`.trim());
  const lines = [];
  const gauges = [];
  const codes = [];
  const code = (c) => (c && c !== '0' ? String(c) : null);
  for (const f of data?.features ?? []) {
    const g = f?.geometry;
    const parts = g?.type === 'LineString' ? [g.coordinates] : g?.type === 'MultiLineString' ? g.coordinates : [];
    parts.forEach((part, i) => {
      lines.push(part);
      gauges.push(GAUGES[f.properties?.COD_ANCHO_] ?? GAUGE.unknown);
      // De un tramo en varias partes, sólo el principio de la primera y el final de la última son sus estaciones.
      codes.push([i === 0 ? code(f.properties?.DEPORIGEN) : null, i === parts.length - 1 ? code(f.properties?.DEPDESTINO) : null]);
    });
  }
  if (lines.length < minTramos) throw new Error(`la red de Adif llega con ${lines.length} tramos`);
  return { lines, gauges, codes, truncated: Boolean(data.properties?.exceededTransferLimit ?? data.exceededTransferLimit) };
}

/**
 * @param {{ cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           log: import('../../../application/ports.js').LoggerPort, url?: string, minTramos?: number }} deps
 *   minTramos: menos tramos que esto es una respuesta rota (sólo cambia en los tests).
 * @returns {import('../../../application/ports.js').RailNetworkPort}
 */
export function createAdifRailNetwork({ cache, log, url = ADIF_TRAMOS_URL, minTramos = MIN_TRAMOS }) {
  let network = null;
  let tramos = 0;
  let digest = null; // huella del fichero con el que se preparó: la recarga periódica no la repite

  return {
    async load() {
      const bytes = await cache.bytes(url, CACHE_NAME, MAX_AGE_MS, {
        validate: (b) => { parseTramos(b, minTramos); }, timeout: 60_000, maxBytes: 32 * 1024 * 1024,
      });
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (network && hash === digest) return tramos;
      const { lines, gauges, codes, truncated } = parseTramos(bytes, minTramos);
      if (truncated) log.warn('[red ferroviaria] Adif ha cortado la respuesta: faltan tramos (hay que pedirla por partes)');
      network = buildRailNetwork(lines, { gauges, codes });
      tramos = lines.length;
      digest = hash;
      log.info(`[red ferroviaria] ${tramos} tramos de Adif: ${network.edges} piezas y ${network.nodes} nudos`
        + ` (${(network.bytes / 1048576).toFixed(1)} MB)`);
      return tramos;
    },
    network: () => network,
  };
}
