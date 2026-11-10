// «Siguiendo»: lo que cada cual marca con la estrella (un servicio, una línea o una estación de cualquier tipo de
// vehículo) y cómo está ahora. Se guarda sólo en este navegador (localStorage), con su clave y su nombre: sin
// cuentas y sin nada en el servidor. Si el navegador no deja guardar, funciona igual mientras dure la página.
//
// Las claves, el registro de tipos y el estado salen de los mismos módulos del dominio que usa el servidor
// (los sirve tal cual en /server/domain/, la misma ruta relativa que desde aquí en el repositorio): nada de
// «si es Renfe» ni listas de modos. Un tipo de vehículo nuevo (barco, avión…) funciona aquí sin tocar nada.
// Todo lo de este módulo es puro salvo `follows` (el almacén del navegador): se prueba desde Node.
import { followKind, isFollowKey, parseFollowKey, stopCode } from '../../server/domain/seguir.js';
import { isMode, modeInfo, modeNoun } from '../../server/domain/modos.js';
import { FOLLOW_DELAYED_MIN, followName } from '../../server/domain/siguiendo.js';
import { creditHtml, esc, fmtNum } from './format.js';

export { modeInfo, stopCode };

/** Como mucho, cuántas cosas se siguen: cada una es una consulta cada medio minuto mientras se mira la lista. */
export const FOLLOW_MAX = 40;
export const FOLLOW_STORE_KEY = 'radar-es:siguiendo';
const NAME_MAX = 160;
const KIND_LABEL = { servicio: 'Servicio', linea: 'Línea', parada: 'Estación' };

/** Lo guardado, limpio: claves válidas, sin repetir, con su nombre (o la clave) y como mucho FOLLOW_MAX. */
export function cleanFollowItems(raw) {
  const list = Array.isArray(raw?.items) ? raw.items : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const i of list) {
    if (!i || !isFollowKey(i.key) || seen.has(i.key)) continue;
    seen.add(i.key);
    const name = typeof i.name === 'string' && i.name.trim() ? i.name.trim().slice(0, NAME_MAX) : i.key;
    out.push({ key: i.key, kind: followKind(i.key), name, mode: isMode(i.mode) ? i.mode : null, at: Number.isFinite(i.at) ? i.at : 0 });
    if (out.length >= FOLLOW_MAX) break;
  }
  return out;
}

/**
 * Lo que se sigue, guardado en `storage` (localStorage o algo que se le parezca). Sin almacenamiento, o si
 * falla, se queda en memoria: la web funciona igual.
 * @param {{ getItem: (k: string) => string|null, setItem: (k: string, v: string) => void }|null} storage
 */
export function createFollowStore(storage, now = Date.now) {
  const read = () => {
    try {
      const raw = storage?.getItem(FOLLOW_STORE_KEY);
      return raw ? cleanFollowItems(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  };
  let items = read();
  const write = () => {
    try {
      storage?.setItem(FOLLOW_STORE_KEY, JSON.stringify({ v: 1, items }));
    } catch { /* sin almacenamiento: sólo mientras dure la página */ }
  };
  const has = (key) => items.some((i) => i.key === key);
  const store = {
    /** Lo que se sigue, lo último que se ha marcado primero. */
    list: () => items.map((i) => ({ ...i })),
    has,
    get size() { return items.length; },
    get full() { return items.length >= FOLLOW_MAX; },
    /** @returns {boolean} si se ha añadido (no: ya estaba, la clave no es válida o se ha llegado al tope) */
    add({ key, name, mode = null }) {
      if (!isFollowKey(key) || has(key) || items.length >= FOLLOW_MAX) return false;
      items = [...cleanFollowItems([{ key, name, mode, at: now() }]), ...items];
      write();
      return true;
    },
    remove(key) {
      const before = items.length;
      items = items.filter((i) => i.key !== key);
      if (items.length === before) return false;
      write();
      return true;
    },
    /** @returns {boolean} si queda seguido */
    toggle(item) {
      if (has(item.key)) store.remove(item.key);
      else store.add(item);
      return has(item.key);
    },
    /** Vuelve a leerlo (otra pestaña lo ha cambiado). */
    reload() { items = read(); },
  };
  return store;
}

const browserStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // el navegador no deja usarlo (modo privado estricto, cookies bloqueadas…)
  }
};
/** Lo que se sigue en este navegador. */
export const follows = createFollowStore(browserStorage());

/**
 * Lo que se puede seguir de un vehículo, del viaje de una incidencia (cancelación, tren sin datos) o de una
 * estación, con su nombre y cómo decirlo en el botón («este autobús», «la línea C4a», «esta estación»).
 * @param {{ follow?: string[]|string, mode?: string, operator?: string, line?: string|null }|null} subject
 * @returns {Array<{ key: string, kind: string, mode: string|null, name: string, what: string }>}
 */
export function followOptions(subject) {
  if (!subject) return [];
  const keys = Array.isArray(subject.follow) ? subject.follow : typeof subject.follow === 'string' ? [subject.follow] : [];
  return [...new Set(keys)].filter(isFollowKey).map((key) => {
    const kind = followKind(key);
    const parsed = parseFollowKey(key);
    let what;
    if (kind === 'servicio') what = `este ${modeNoun(subject.mode)}`;
    else if (kind === 'parada') what = modeInfo(subject.mode)?.family === 'carretera' ? 'esta parada' : 'esta estación';
    else if (parsed.parts.length) what = `la línea ${parsed.parts.at(-1) ?? subject.line ?? ''}`.trim();
    else what = `toda la red de ${subject.operator ?? parsed.network}`;
    return { key, kind, mode: isMode(subject.mode) ? subject.mode : null, name: followName(key, subject) ?? key, what };
  });
}

/** Lo que dice el botón: «☆ Seguir este tren» o «★ Siguiendo este tren». */
export const followButtonText = (what, on) => `<span aria-hidden="true">${on ? '★' : '☆'}</span> ${on ? 'Siguiendo' : 'Seguir'} ${esc(what)}`;

/** Botones Seguir/Siguiendo de una ficha (una sola llamada desde cada ficha del mapa). */
export function followControls(subject, store = follows) {
  const options = followOptions(subject);
  if (!options.length) return '';
  const buttons = options.map((o) => `<button type="button" class="follow-btn" data-follow="${esc(o.key)}" data-follow-name="${esc(o.name)}"
    data-follow-mode="${esc(o.mode ?? '')}" data-follow-what="${esc(o.what)}" aria-pressed="${store.has(o.key)}" title="${esc(o.name)}">${followButtonText(o.what, store.has(o.key))}</button>`);
  return `<div class="follow" role="group" aria-label="Seguir en «Siguiendo»">${buttons.join('')}</div>`;
}

// ---------- Cómo está cada cosa (de /api/live/siguiendo, ver domain/siguiendo.js) ----------

const nouns = (mode, n) => modeNoun(mode, n !== 1);
const delayText = (v) => {
  if (Number.isFinite(v.delay)) return v.delay <= 0 ? 'en hora' : `${v.delay} min de retraso`;
  return v.late === true ? 'con retraso' : v.late === false ? 'en hora' : 'su operador no publica su retraso';
};
const delaySev = (v) => (Number.isFinite(v.delay) ? (v.delay >= 15 ? 'alta' : v.delay >= FOLLOW_DELAYED_MIN ? 'media' : 'baja') : v.late ? 'media' : 'baja');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * El texto de su estado y su gravedad (para el color del borde, siempre con el texto al lado).
 * @param {{ kind: string, mode?: string|null }} item  lo guardado
 * @param {object|undefined} status  la respuesta de /api/live/siguiendo; { error: true } si no se pudo pedir
 * @returns {{ text: string, sev: 'baja'|'media'|'alta' }}
 */
export function followStatusText(item, status) {
  if (item.kind === 'parada') return { text: 'Pulsa para abrir su ficha: lo que está parado en ella, lo que llega y sus avisos.', sev: 'baja' };
  if (!status) return { text: 'Consultando…', sev: 'baja' };
  if (status.error) return { text: 'No se ha podido consultar su estado ahora; se vuelve a intentar en un momento.', sev: 'baja' };
  const mode = status.mode ?? item.mode;
  const events = status.events?.list ?? [];
  const active = events.filter((e) => !e.withdrawn);
  const cancellations = active.filter((e) => e.category === 'cancelacion');
  const { total = 0, withDelayInfo = 0, delayed = 0, list = [] } = status.vehicles ?? {};
  switch (status.state) {
    case 'circula': {
      const v = list[0];
      const where = v.stopped && v.current ? `parado en ${v.current}` : v.next ? `próxima parada: ${v.next}` : null;
      const parts = [cap(delayText(v)), v.destination && `hacia ${v.destination}`, where, v.estimated && 'posición estimada (no es GPS)'];
      if (total > 1) parts.unshift(`Se ven ${total}`);
      const extra = cancellations.length ? ' Su operador también publica una cancelación suya: mira abajo.' : '';
      return { text: `${parts.filter(Boolean).join(' · ')}.${extra}`, sev: cancellations.length ? 'media' : delaySev(v) };
    }
    // El detalle (de dónde a dónde y a qué hora) va debajo, en el enlace a su cancelación.
    case 'cancelado': return { text: 'Cancelado: su operador lo da como cancelado.', sev: 'alta' };
    case 'parcial': return { text: 'Circula con paradas suprimidas, según su operador.', sev: 'media' };
    case 'sin-datos': return { text: 'Sin datos: según su horario debería circular y su operador no publica nada de él.', sev: 'media' };
    case 'cancelado-retirado': return { text: 'Se canceló hoy; su operador ya no lo publica.', sev: 'baja' };
    case 'no-se-ve': return { text: 'No circula ahora o su operador no lo publica.', sev: 'baja' };
    case 'circulan':
    case 'ninguno': {
      const moving = total
        ? `${fmtNum(total)} ${nouns(mode, total)} circulando${withDelayInfo
          ? ` · ${fmtNum(delayed)} con ${FOLLOW_DELAYED_MIN} min de retraso o más` : ' · su operador no publica retrasos'}`
        : `Ningún ${modeNoun(mode)} circula ahora o su operador no lo publica`;
      // Los totales del servidor: la lista viene recortada (como mucho 20) y contar sobre ella se quedaba corto.
      const nCancelled = status.events?.cancellations ?? cancellations.length;
      const notices = Math.max(0, (status.events?.active ?? active.length) - nCancelled);
      const incidents = [nCancelled && `${fmtNum(nCancelled)} ${nCancelled === 1 ? 'cancelación' : 'cancelaciones'}`,
        notices && `${fmtNum(notices)} ${notices === 1 ? 'aviso' : 'avisos'}`].filter(Boolean).join(' y ');
      const sev = nCancelled ? 'alta' : delayed ? 'media' : 'baja';
      return { text: `${moving}${incidents ? ` · ${incidents}` : ''}.`, sev };
    }
    default: return { text: 'Sin datos de su estado.', sev: 'baja' };
  }
}

/** Cuántas cosas seguidas tienen algo que mirar (cancelación, paradas suprimidas o sin datos). */
export function followAttention(items, statuses) {
  return items.filter((i) => {
    const s = statuses.get(i.key);
    return s && (['cancelado', 'parcial', 'sin-datos'].includes(s.state) || (s.events?.list ?? []).some((e) => !e.withdrawn && e.category === 'cancelacion'));
  }).length;
}

/**
 * La lista «Siguiendo».
 * @param {ReturnType<typeof cleanFollowItems>} items
 * @param {Map<string, object>} statuses  clave → respuesta de /api/live/siguiendo
 * @param {{ sourceCredit?: (source: string, operator?: string|null) => string|null,
 *           needsLayer?: (item: object, status: object|undefined) => string|null,
 *           telegram?: (item: object) => string }} [opts]
 *   sourceCredit: la atribución de una fuente (de /api/health); needsLayer: si para verlo en el mapa hay que
 *   encender una capa, su nombre; telegram: el botón para recibir sus avisos por Telegram ('' si no hay bot)
 */
export function followingHtml(items, statuses, { sourceCredit = () => null, needsLayer = () => null, telegram = () => '' } = {}) {
  const note = '<p class="follow-note">Se guarda sólo en este navegador: sin cuentas, y el radar no sabe qué sigue cada cual.</p>';
  if (!items.length) {
    return `<div class="empty">Aún no sigues nada.<br>Abre la ficha de cualquier vehículo, de una cancelación o de una estación y pulsa
      <strong>☆ Seguir</strong>: aquí verás cómo está ahora (su retraso, si se ha cancelado o si su operador no publica nada).</div>${note}`;
  }
  const credits = new Set();
  let withTelegram = false;
  const rows = items.map((item) => {
    const status = statuses.get(item.key);
    const { text, sev } = followStatusText(item, status);
    for (const v of status?.vehicles?.list ?? []) { const c = sourceCredit(v.source, v.operator); if (c) credits.add(c); }
    const events = status?.events?.list ?? [];
    for (const e of events) { const c = e.credit ?? sourceCredit(e.source); if (c) credits.add(c); }
    const shown = events.filter((e) => !e.withdrawn).slice(0, 3);
    const more = (status?.events?.active ?? 0) - shown.length;
    const layer = needsLayer(item, status);
    const tg = telegram(item);
    if (tg) withTelegram = true;
    return `
    <div class="item follow-item sev-${sev}">
      <div class="row"><span class="follow-kind">${esc(KIND_LABEL[item.kind] ?? '')}${item.mode && modeInfo(item.mode) ? ` · ${esc(modeInfo(item.mode).label)}` : ''}</span>
        <button type="button" class="follow-x" data-follow-remove="${esc(item.key)}" aria-label="Dejar de seguir ${esc(item.name)}" title="Dejar de seguir">×</button></div>
      <button type="button" class="follow-open" data-follow-open="${esc(item.key)}"><span class="title">${esc(item.name)}</span></button>
      <div class="desc">${esc(text)}</div>
      ${shown.length ? `<ul class="follow-events">${shown.map((e) => `<li><button type="button" class="link" data-kind="event" data-id="${esc(e.id)}">${esc(e.title)}</button></li>`).join('')}${more > 0 ? `<li>y ${fmtNum(more)} más</li>` : ''}</ul>` : ''}
      ${layer ? `<div class="meta"><span>Para verlo en el mapa se encenderá la capa «${esc(layer)}».</span></div>` : ''}
      ${tg}
    </div>`;
  }).join('');
  const attribution = credits.size ? `<p class="follow-credit">Datos: ${[...credits].map(creditHtml).join(' · ')}</p>` : '';
  const hint = withTelegram ? '<p class="follow-tg-hint">Con «Avisos en Telegram» te llegan al móvil aunque no tengas la web abierta.</p>' : '';
  return `<div class="section-title">Lo que sigues · pulsa uno para verlo en el mapa</div>${hint}${rows}${attribution}${note}`;
}
