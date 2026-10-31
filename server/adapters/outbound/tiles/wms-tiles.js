// Teselas de las capas WMS (red ferroviaria del IGN y áreas quemadas de EFFIS) servidas desde
// nuestro dominio: así Cloudflare las guarda y, con miles de personas, el IGN y EFFIS reciben cada
// tesela una vez y no una por visitante. Las dos licencias (CC BY 4.0) permiten copiarlas y
// redistribuirlas con su atribución, que el mapa sigue mostrando. El mapa base (OpenFreeMap) NO
// pasa por aquí: sus condiciones no permiten descargarlo de forma automatizada.
//
// Cada tesela se pide una sola vez: se guarda en disco (data/tiles) y, mientras está vigente, sale
// de ahí. Si el servicio falla, se sirve la última copia aunque esté caducada; sin copia, error
// (el mapa deja ese hueco y no reintenta en bucle). Qué teselas se pueden pedir (sólo España y
// hasta un zoom por capa) lo decide antes el caso de uso serve-tiles: aquí no se filtra nada.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const HALF_WORLD = 20037508.342789244; // EPSG:3857

/** Caja EPSG:3857 de la tesela z/x/y (esquema XYZ, como pide MapLibre). */
export function tileBbox(z, x, y) {
  const size = (2 * HALF_WORLD) / 2 ** z;
  const minx = -HALF_WORLD + x * size;
  const maxy = HALF_WORLD - y * size;
  return [minx, maxy - size, minx + size, maxy];
}

export const LAYERS = {
  'ign-rail': {
    url: (bbox) => 'https://servicios.idee.es/wms-inspire/transportes?service=WMS&request=GetMap&version=1.3.0'
      + '&layers=TN.RailTransportNetwork.RailwayLink&styles=&format=image/png&transparent=true&crs=EPSG:3857'
      + `&width=256&height=256&bbox=${bbox.join(',')}`,
    maxAgeMs: 30 * 86_400_000, // la red ferroviaria apenas cambia
    cacheControl: 'public, max-age=86400, s-maxage=2592000, stale-if-error=2592000',
  },
  effis: {
    url: (bbox) => 'https://maps.effis.emergency.copernicus.eu/effis?service=WMS&request=GetMap&version=1.1.1&layers=modis.ba.month'
      + `&styles=&format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256&bbox=${bbox.join(',')}`,
    maxAgeMs: 3 * 3_600_000, // EFFIS actualiza las áreas quemadas a diario
    cacheControl: 'public, max-age=3600, s-maxage=10800, stale-if-error=86400',
  },
};

const PNG = [0x89, 0x50, 0x4e, 0x47];
const isPng = (b) => b.length > 8 && PNG.every((v, i) => b[i] === v); // los WMS devuelven los errores como XML con 200
const MAX_PARALLEL = 4; // peticiones simultáneas al IGN o a EFFIS como mucho

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, dir: string, log?: import('../../../application/ports.js').LoggerPort }} deps
 * @returns {import('../../../application/ports.js').TileProviderPort}
 */
export function createWmsTiles({ http, dir, log }) {
  const inflight = new Map(); // misma tesela pedida a la vez → una sola descarga
  let running = 0;
  const waiting = [];
  const slot = async () => {
    if (running >= MAX_PARALLEL) await new Promise((r) => waiting.push(r));
    running++;
  };
  const release = () => {
    running--;
    waiting.shift()?.();
  };

  async function download(layer, z, x, y, file) {
    await slot();
    try {
      const bytes = await http.bytes(LAYERS[layer].url(tileBbox(z, x, y)), { timeout: 15_000 });
      if (!isPng(bytes)) throw new Error('el servicio no ha devuelto una imagen');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return bytes;
    } finally {
      release();
    }
  }

  return {
    layers: Object.keys(LAYERS),
    cacheControl: (layer) => LAYERS[layer].cacheControl,

    /** PNG de la tesela, o null si no hay forma de conseguirla. */
    async tile(layer, z, x, y) {
      const file = join(dir, layer, String(z), String(x), `${y}.png`);
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs < LAYERS[layer].maxAgeMs) return readFile(file);
      const key = `${layer}/${z}/${x}/${y}`;
      if (!inflight.has(key)) {
        inflight.set(key, download(layer, z, x, y, file).finally(() => inflight.delete(key)));
      }
      try {
        return await inflight.get(key);
      } catch (err) {
        log?.warn(`[teselas] ${key}: ${err.message}`);
        return info ? readFile(file) : null; // la última copia, aunque haya caducado
      }
    },

    /**
     * Áreas quemadas del último mes dentro de una caja lon/lat (WFS de EFFIS, GeoJSON). Pasa por el
     * servidor para que el navegador no tenga que conectarse a EFFIS al pulsar el mapa.
     */
    async burntAreas([minLon, minLat, maxLon, maxLat]) {
      const url = 'https://maps.effis.emergency.copernicus.eu/effis?service=WFS&version=1.0.0&request=GetFeature'
        + `&typename=ms:modis.ba.poly.month&outputformat=geojson&bbox=${minLon},${minLat},${maxLon},${maxLat}`;
      await slot();
      try {
        return JSON.parse(new TextDecoder().decode(await http.bytes(url, { timeout: 15_000 })));
      } finally {
        release();
      }
    },
  };
}
