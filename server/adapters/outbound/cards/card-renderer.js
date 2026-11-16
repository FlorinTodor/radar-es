// Dibujante de las tarjetas de compartir (CardRendererPort): el SVG se hace aquí (svg-card.js, unos pocos ms) y el
// PNG, en un hilo de cálculo (la tarea «card» de workers/tasks.js, png-card.js). Si el pool no tiene hilos, el pool
// lo hace en el hilo principal: es lo que hace con todas sus tareas.
import { cardSvg } from './svg-card.js';
import { CARD_FONT, findCardFonts } from './png-card.js';

/**
 * @param {{ pool: import('../workers/cpu-pool.js').CpuPool, log: import('../../../application/ports.js').LoggerPort,
 *           fonts?: string[]|null, site?: string }} deps
 *   fonts: los ficheros de la letra (por defecto, los del sistema); site: la dirección que se lee en la tarjeta.
 * @returns {import('../../../application/ports.js').CardRendererPort}
 */
export function createCardRenderer({ pool, log, fonts = findCardFonts(), site = 'radarespana.es' }) {
  if (!fonts) log.warn('[compartir] no está la letra DejaVu Sans: los enlaces compartidos enseñan la imagen general, sin tarjeta propia');
  return {
    available: () => Boolean(fonts),
    async render(card) {
      if (!fonts) throw new Error('Sin letra para las tarjetas');
      return pool.run('card', [cardSvg(card, { font: CARD_FONT, site }), fonts]);
    },
  };
}
