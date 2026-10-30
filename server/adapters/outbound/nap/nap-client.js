// Cliente del Punto de Acceso Nacional de transporte (nap.transportes.gob.es).
// Requiere una ApiKey gratuita (NAP_API_KEY). Atribución obligatoria: "Powered by MITRAMS".
// La licencia también obliga a conservar la fecha de actualización de cada conjunto de datos.

const BASE = 'https://nap.transportes.gob.es/api';
const METADATA_MAX_AGE_MS = 12 * 3600_000;

/** Página pública de un conjunto de datos del NAP (la que se enlaza como fuente). */
export const napDatasetPage = (dataset) => `https://nap.transportes.gob.es/ConjuntoDato/Detail/${dataset}`;

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

    /**
     * Fecha de última actualización de un fichero según el NAP, en hora de Madrid sin zona
     * ("2026-10-30T02:36:32"). La API sólo la da por conjunto de datos (dataset), no por fichero.
     * @returns {Promise<string|null>}
     */
    async updatedAt(dataset, ficheroId) {
      if (!apiKey) throw new Error('Falta NAP_API_KEY');
      const bytes = await cache.bytes(`${BASE}/Fichero/${dataset}`, `nap-conjunto-${dataset}.json`, METADATA_MAX_AGE_MS, {
        headers: { ApiKey: apiKey, Accept: 'application/json' },
      });
      const meta = JSON.parse(new TextDecoder().decode(bytes));
      return meta.ficherosDto?.find((f) => f.ficheroId === ficheroId)?.fechaActualizacion?.slice(0, 19) ?? null;
    },
  };
}
