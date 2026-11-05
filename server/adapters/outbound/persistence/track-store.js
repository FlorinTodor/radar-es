// Copia del historial de posiciones en el disco de datos (data/cache), junto a lo demás que el radar
// calcula y guarda: se escribe de golpe (writeValue), así que un relevo, con dos servidores en la
// misma carpeta, nunca lee una copia a medio escribir.
const NAME = 'estelas.v1';

/**
 * @param {{ cache: { readValue: (name: string) => Promise<any>, writeValue: (name: string, value: any) => Promise<void> },
 *           name?: string }} deps
 * @returns {import('../../../application/ports.js').TrackStorePort}
 */
export function createTrackStore({ cache, name = NAME }) {
  return {
    load: () => cache.readValue(name),
    save: (snapshot) => cache.writeValue(name, snapshot),
  };
}
