// Caso de uso: que el historial de posiciones sobreviva a un reinicio o a un despliegue. Vive en
// memoria y, sin esto, cada versión nueva empezaba de cero: la estela de todos los trenes arrancaba a
// la hora del despliegue, y la flecha, «detenido en plena vía» y los saltos de retraso se quedaban
// unos minutos sin historial. Se guarda una copia cada minuto y al apagar; al arrancar se recupera.
import { joinPacked, packTracks, restoreTracks } from '../../domain/tracking.js';

const VERSION = 1;
// Se empaqueta por partes, cediendo el turno entre una y otra: con todos los trenes y los autobuses con GPS
// son decenas de miles de puntos, y de golpe pararía las respuestas del servidor (en el VPS, cientos de ms).
const SLICE = 150;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, store: import('../ports.js').TrackStorePort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort, pause?: () => Promise<void> }} deps
 *   pause: cómo se cede el turno entre parte y parte (para los tests).
 */
export function makeKeepTracks({ situation, store, clock, log, pause = nextTurn }) {
  return {
    /**
     * Guarda el historial de los vehículos que hay ahora en el mapa, menos el de los autobuses con
     * posición estimada: son miles (casi todos los puntos) y su recorrido sale de su horario, no de
     * su historial (que sólo sirve para su flecha).
     */
    async save() {
      const keep = new Set();
      for (const v of situation.vehicles()) if (!(v.mode === 'bus' && v.estimated)) keep.add(v.id);
      const savedAt = clock.now();
      // Los historiales se siguen actualizando entre parte y parte: cada uno se guarda como esté al empaquetarlo.
      const entries = [...situation.tracks()].filter(([id]) => keep.has(id));
      const parts = [];
      for (let i = 0; i < entries.length; i += SLICE) {
        if (i) await pause();
        parts.push(packTracks(entries.slice(i, i + SLICE)));
      }
      await store.save({ version: VERSION, savedAt, ...joinPacked(parts) });
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
