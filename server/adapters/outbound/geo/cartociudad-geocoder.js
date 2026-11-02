// Puerto Geocoder con CartoCiudad (IGN-CNIG): el nombre de un municipio o de una localidad →
// sus coordenadas. Servicio REST público y sin clave, catalogado en datos.gob.es con licencia
// CC BY 4.0 («Servicio REST de geocodificación de España (CartoCiudad)»).
import { fold } from '../../../domain/emergencias.js';

const BASE = 'https://www.cartociudad.es/geocoder/api/geocoder';
// Primero la entidad de población (su centro, una respuesta pequeña) y si no, el municipio. Nunca
// calles ni portales: un aviso del 112 sólo dice el pueblo.
const TYPES = ['poblacion', 'Municipio'];
const MAX_CACHE = 5000;
// Lo que quede fuera de España (o el 0,0 con el que CartoCiudad responde a veces) no vale.
const inSpain = (lat, lon) => lat >= 27 && lat <= 44.5 && lon >= -18.5 && lon <= 4.6 && !(lat === 0 && lon === 0);

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, log?: import('../../../application/ports.js').LoggerPort, base?: string }} deps
 * @returns {import('../../../application/ports.js').GeocoderPort}
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
