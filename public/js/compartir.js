// Botón «Compartir» de las fichas (una incidencia, un vehículo, una estación): en el móvil abre el menú de compartir del
// sistema (WhatsApp, Telegram…); en el ordenador copia el enlace. El enlace es el propio de eso (domain/compartir.js),
// y al pegarlo, WhatsApp, Telegram o X enseñan su tarjeta: qué pasa, dónde y desde cuándo, con su fuente.
import { parseSharePath, sharePath } from '../../server/domain/compartir.js';
import { esc } from './format.js';
import { lang, t } from './i18n.js';

export { parseSharePath, sharePath };

// La dirección que se comparte: la de la web sin ñ (radarespana.es), que cualquier aplicación reconoce como enlace
// y lleva a la de siempre (redirección 308 de Cloudflare). En local o en pruebas, la de la propia página.
const PUBLIC_HOSTS = new Set(['xn--radarespaa-19a.es', 'www.xn--radarespaa-19a.es', 'radarespana.es', 'www.radarespana.es']);
const shareOrigin = () => (PUBLIC_HOSTS.has(location.hostname) ? 'https://radarespana.es' : location.origin);

/** El enlace de algo, en el idioma de la web; null si no se puede compartir. */
export function shareUrl(kind, id) {
  const path = sharePath(kind, id);
  return path ? `${shareOrigin()}${path}${lang() === 'en' ? '?lang=en' : ''}` : null;
}

// Tres puntos unidos (dibujo propio, el signo habitual de compartir).
const ICON = '<svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">'
  + '<path d="M8.6 10.7l6.8-3.9M8.6 13.3l6.8 3.9"/></g><g fill="currentColor"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="5.5" r="3"/><circle cx="18" cy="18.5" r="3"/></g></svg>';

/**
 * El botón de una ficha, o '' si eso no se puede compartir.
 * @param {'incidencia'|'estacion'|'vehiculo'} kind  @param {string} id
 * @param {string} title  lo que acompaña al enlace en el menú de compartir (su título)
 */
export function shareButton(kind, id, title) {
  const url = shareUrl(kind, id);
  if (!url) return '';
  return `<div class="share"><button type="button" class="share-btn" data-share-url="${esc(url)}" data-share-kind="${esc(kind)}" data-share-title="${esc(title ?? '')}">${ICON}`
    + `<span>${t('Compartir')}</span></button></div>`;
}

// En pantallas táctiles, el menú de compartir del sistema; en el ordenador (o si no lo hay), copiar.
const touch = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Sin permiso para el portapapeles (http en local, navegadores viejos): que lo copie a mano.
    window.prompt(t('Copia el enlace:'), text);
    return false;
  }
}

/**
 * Cuenta en GoatCounter (sin cookies ni IP) que se ha compartido algo, por tipo y por cómo (menú o copiado), nunca
 * qué: así se sabe cuánto se usa el botón. Sin GoatCounter (en local), nada.
 */
function countShare(kind, how) {
  try {
    window.goatcounter?.count?.({ path: `compartir-${kind}-${how}`, title: 'Compartir', event: true });
  } catch { /* el contador no está: no pasa nada */ }
}

/** Escucha los botones de compartir de toda la página (las fichas se repintan: se escucha en el documento). */
export function listenShareButtons({ onShared = countShare } = {}) {
  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-share-url]');
    if (!btn) return;
    const url = btn.dataset.shareUrl;
    const title = btn.dataset.shareTitle || 'Radar España';
    if (touch() && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text: title, url });
        onShared(btn.dataset.shareKind, 'menu');
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return; // lo ha cerrado sin compartir
      }
    }
    if (!(await copy(url))) return;
    onShared(btn.dataset.shareKind, 'copiado');
    const label = btn.querySelector('span');
    if (!label) return;
    label.textContent = t('Enlace copiado');
    btn.classList.add('done');
    setTimeout(() => {
      label.textContent = t('Compartir');
      btn.classList.remove('done');
    }, 2500);
  });
}
