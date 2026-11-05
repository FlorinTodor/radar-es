// Caso de uso: que el historial de posiciones sobreviva a un reinicio o a un despliegue. Vive en
// memoria y, sin esto, cada versión nueva empezaba de cero: la estela de todos los trenes arrancaba a
// la hora del despliegue, y la flecha, «detenido en plena vía» y los saltos de retraso se quedaban
// unos minutos sin historial. Se guarda una copia cada minuto y al apagar; al arrancar se recupera.
import { packTracks, restoreTracks } from '../../domain/tracking.js';

const VERSION = 1;

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, store: import('../ports.js').TrackStorePort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort }} deps
 */
export function makeKeepTracks({ situation, store, clock, log }) {
  return {
    /**
     * Guarda el historial de los vehículos que hay ahora en el mapa, menos el de los autobuses con
     * posición estimada: son miles (casi todos los puntos) y su recorrido sale de su horario, no de
     * su historial (que sólo sirve para su flecha).
     */
    async save() {
      const keep = new Set();
      for (const v of situation.vehicles()) if (!(v.mode === 'bus' && v.estimated)) keep.add(v.id);
      const packed = packTracks(situation.tracks(), (id) => keep.has(id));
      await store.save({ version: VERSION, savedAt: clock.now(), ...packed });
    },

    /** Antes de la primera lectura: lo guardado que siga dentro de la ventana del historial. */
    async restore() {
      const saved = await store.load();
      if (saved?.version !== VERSION) return 0;
      const now = clock.now();
      const restored = situation.updateTracks((tracks) => restoreTracks(tracks, saved, now));
      if (restored) log.info(`[estelas] recuperado el historial de ${restored} vehículos (guardado hace ${Math.round((now - saved.savedAt) / 1000)} s)`);
      return restored;
    },
  };
}
