// Geocodificador con CartoCiudad (IGN-CNIG): el nombre de un municipio o de una localidad →
// sus coordenadas, y unas coordenadas → su municipio y su provincia. Servicio REST público y sin clave, catalogado en datos.gob.es con licencia
// CC BY 4.0 («Servicio REST de geocodificación de España (CartoCiudad)»).
import { fold } from '../../../domain/emergencias.js';
import { inBounds, SPAIN_BOUNDS } from '../../../domain/geo.js';

/**
 * Sitúa en el mapa un lugar que sólo se conoce por su nombre (el municipio o la localidad de un aviso
 * del 112). Es un contrato entre adaptadores, no un puerto de la aplicación: ningún caso de uso
 * geocodifica; lo usan las fuentes de avisos oficiales, que no traen coordenadas, y main.js se lo pasa.
 * @typedef {object} Geocoder
 * @property {(place: string, scope?: { region?: string, province?: string }) => Promise<{ name: string, lat: number, lon: number } | null>} locate
 *   region: código de comunidad autónoma del INE («01» Andalucía…), para no confundir pueblos con el
 *   mismo nombre; province: nombre de la provincia. null si no lo encuentra; si el servicio no responde,
 *   lanza el error: quien pregunta decide si sigue (las fuentes de avisos dejan de preguntar en esa lectura).
 * @property {(lat: number, lon: number) => Promise<{ muni: string, province: string } | null>} placeAt
 *   El municipio de un punto de España (el de su dirección más cercana), para nombrar dónde ha sido un
 *   terremoto. null en el mar o fuera de España; si el servicio no responde, lanza el error.
 */
/** Lo que main.js comprueba en el arranque (assertPort) que tiene el geocodificador. */
export const GEOCODER_MEMBERS = Object.freeze(['locate', 'placeAt']);

const BASE = 'https://www.cartociudad.es/geocoder/api/geocoder';
// Primero la entidad de población (su centro, una respuesta pequeña) y si no, el municipio. Nunca
// calles ni portales: un aviso del 112 sólo dice el pueblo.
const TYPES = ['poblacion', 'Municipio'];
const MAX_CACHE = 5000;
// Lo que quede fuera de España no vale: tampoco el 0,0 con el que CartoCiudad responde a veces, que
// cae en el golfo de Guinea, fuera de la caja.
const inSpain = (lat, lon) => inBounds(SPAIN_BOUNDS, lat, lon);

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, log?: import('../../../application/ports.js').LoggerPort, base?: string }} deps
 * @returns {Geocoder}
 */
export function createCartoCiudadGeocoder({ http, log, base = BASE }) {
  // Cada lugar se pregunta una vez: también se guarda que no existe. Un fallo de red no se guarda,
  // para volver a intentarlo en la siguiente lectura de la fuente.
  const cache = new Map();
  const remember = (key, value) => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
  };

  return {
    async locate(place, { region, province } = {}) {
      const name = String(place ?? '').trim();
      if (name.length < 2 || name.length > 80) return null;
      const key = `${fold(name)}|${region ?? ''}|${fold(province)}`;
      if (cache.has(key)) return cache.get(key);
      try {
        const list = await http.json(`${base}/candidates?q=${encodeURIComponent(name)}&limit=10`, { timeout: 10_000, maxBytes: 512 * 1024 });
        const want = fold(name);
        const fits = (c) => (!region || c.comunidadAutonomaCode === region) && (!province || fold(c.province) === fold(province));
        const same = (c) => fold(c.poblacion) === want || fold(c.muni) === want;
        const candidates = Array.isArray(list) ? list : [];
        const pick = TYPES.map((t) => candidates.find((c) => c?.type === t && fits(c) && same(c))).find(Boolean);
        if (!pick) return remember(key, null);
        const found = await http.json(
          `${base}/find?q=${encodeURIComponent(pick.address ?? name)}&type=${encodeURIComponent(pick.type)}&id=${encodeURIComponent(pick.id)}`,
          { timeout: 10_000, maxBytes: 4 * 1024 * 1024 }, // el municipio trae su polígono
        );
        const lat = Number(found?.lat);
        const lon = Number(found?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inSpain(lat, lon)) return remember(key, null);
        // Siempre texto: el nombre llega al mapa (area), que sólo escapa lo que es texto.
        return remember(key, { name: String((pick.type === 'poblacion' ? pick.poblacion : pick.muni) ?? name), lat, lon });
      } catch (err) {
        log?.warn(`[cartociudad] ${name}: ${err.message}`);
        throw err;
      }
    },

    async placeAt(lat, lon) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !inSpain(lat, lon)) return null;
      // A unos cientos de metros es el mismo sitio: así un punto se pregunta una vez.
      const key = `@${lat.toFixed(3)},${lon.toFixed(3)}`;
      if (cache.has(key)) return cache.get(key);
      try {
        // En el mar no hay dirección cercana: responde vacío (no es JSON) y se guarda que no hay municipio.
        const body = await http.text(`${base}/reverseGeocode?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`, { timeout: 10_000, maxBytes: 64 * 1024 });
        let found = null;
        try { found = body.trim() ? JSON.parse(body) : null; } catch { found = null; }
        const muni = typeof found?.muni === 'string' ? found.muni.trim().slice(0, 80) : '';
        const province = typeof found?.province === 'string' ? found.province.trim().slice(0, 60) : '';
        return remember(key, muni ? { muni, province } : null);
      } catch (err) {
        log?.warn(`[cartociudad] ${lat.toFixed(3)},${lon.toFixed(3)}: ${err.message}`);
        throw err;
      }
    },
  };
}
