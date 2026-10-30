// Cliente del Punto de Acceso Nacional de transporte (nap.transportes.gob.es).
// Requiere una ApiKey gratuita (NAP_API_KEY). Atribución obligatoria: "Powered by MITRAMS".

const BASE = 'https://nap.transportes.gob.es/api';

/**
 * @param {{ cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>, apiKey?: string }} deps
 */
export function createNapClient({ cache, apiKey }) {
  return {
    enabled: !!apiKey,

    /** ZIP de un GTFS estático por su ficheroId, desde caché si es reciente. */
    async gtfs(ficheroId, maxAgeMs = 7 * 24 * 3600_000) {
      if (!apiKey) throw new Error('Falta NAP_API_KEY');
      return cache.bytes(`${BASE}/Fichero/download/${ficheroId}`, `gtfs-${ficheroId}.zip`, maxAgeMs, { headers: { ApiKey: apiKey } });
    },
  };
}
