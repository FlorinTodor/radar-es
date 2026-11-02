// Geocodificador con CartoCiudad (IGN-CNIG): el nombre de un municipio o de una localidad →
// sus coordenadas. Servicio REST público y sin clave, catalogado en datos.gob.es con licencia
// CC BY 4.0 («Servicio REST de geocodificación de España (CartoCiudad)»).
import { fold } from '../../../domain/emergencias.js';

/**
 * Sitúa en el mapa un lugar que sólo se conoce por su nombre (el municipio o la localidad de un aviso
 * del 112). Es un contrato entre adaptadores, no un puerto de la aplicación: ningún caso de uso
 * geocodifica; lo usan las fuentes de avisos oficiales, que no traen coordenadas, y main.js se lo pasa.
 * @typedef {object} Geocoder
 * @property {(place: string, scope?: { region?: string, province?: string }) => Promise<{ name: string, lat: number, lon: number } | null>} locate
 *   region: código de comunidad autónoma del INE («01» Andalucía…), para no confundir pueblos con el
 *   mismo nombre; province: nombre de la provincia. null si no lo encuentra o el servicio no responde.
 */
/** Lo que main.js comprueba en el arranque (assertPort) que tiene el geocodificador. */
export const GEOCODER_MEMBERS = Object.freeze(['locate']);

const BASE = 'https://www.cartociudad.es/geocoder/api/geocoder';
// Primero la entidad de población (su centro, una respuesta pequeña) y si no, el municipio. Nunca
// calles ni portales: un aviso del 112 sólo dice el pueblo.
const TYPES = ['poblacion', 'Municipio'];
const MAX_CACHE = 5000;
// Lo que quede fuera de España (o el 0,0 con el que CartoCiudad responde a veces) no vale.
const inSpain = (lat, lon) => lat >= 27 && lat <= 44.5 && lon >= -18.5 && lon <= 4.6 && !(lat === 0 && lon === 0);

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
        return remember(key, { name: pick.type === 'poblacion' ? (pick.poblacion ?? name) : (pick.muni ?? name), lat, lon });
      } catch (err) {
        log?.warn(`[cartociudad] ${name}: ${err.message}`);
        return null;
      }
    },
  };
}
