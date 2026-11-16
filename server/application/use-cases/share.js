// Caso de uso «compartir»: lo que dice el enlace propio de una incidencia, una estación o un vehículo (su página y su
// tarjeta, ver domain/compartir.js) y las incidencias que ya no salen en el directo, para que su enlace siga diciendo
// qué eran unos días (y sobreviva a los despliegues: se guardan en disco).
//
// La tarjeta cuesta un dibujo en un hilo de cálculo: se dibuja una vez por cosa, idioma y estado (`version`), y la
// guardan este memo, Cloudflare y cada red social. Como mucho unas pocas a la vez: las demás esperan su turno o, si la
// cola está llena, se rechazan (ShareBusy → 503, y quien pide lo vuelve a intentar).
import {
  emptyShareTotals, endedRecord, eventShare, isShareId, noteEnded, restoreEnded, restoreShareTotals, SHARE_KINDS, stationShare,
  successorOf, vehicleShare,
} from '../../domain/compartir.js';

const KEEP_MS = 3 * 24 * 3600_000; // lo que dura el enlace de una incidencia que ya no sale en el directo
// Salvo los vehículos detenidos de la DGT (sobre todo balizas V16: se encienden y se apagan en minutos, unos 800 por
// hora): con 3 días llenarían el tope en medio día y echarían a los accidentes y cortes antes de tiempo.
const KEEP_STOPPED_MS = 6 * 3600_000;
const keepOf = (e) => (e?.type === 'vehicleObstruction' ? KEEP_STOPPED_MS : KEEP_MS);
const MAX_ENDED = 10_000;
const INDEX_TTL_MS = 5_000; // incidencias y vehículos por id: se rehacen como mucho cada tanto, no en cada petición
const CARDS_MAX = 200;
const CARDS_BYTES = 12 * 1024 * 1024; // unos 50 kB cada una
const QUEUE_MAX = 4; // tarjetas dibujándose o esperando a la vez

/** No se puede dibujar otra tarjeta ahora (cola llena o sin presupuesto): 503 y Retry-After. */
export class ShareBusy extends Error {}

/**
 * @param {{ query: { events: () => object[], vehicles: () => object[], station: (code: string) => object|null, health: () => object[] },
 *           store: import('../ports.js').EndedStorePort, renderer: import('../ports.js').CardRendererPort,
 *           clock: import('../ports.js').ClockPort, log: import('../ports.js').LoggerPort, keepMs?: number, maxEnded?: number }} deps
 *   query: el caso de uso de consulta (query-situation).
 */
export function makeShare({ query, store, renderer, clock, log, keepMs = keepOf, maxEnded = MAX_ENDED }) {
  let ended = new Map(); // id → { event, endedAt }
  let before = []; // las incidencias de la última vuelta
  let dirty = false;
  let totals = emptyShareTotals(clock.now());
  const countCard = (result) => {
    totals.cards[result]++;
    dirty = true;
  };

  // La atribución de una fuente: la de su operador si agrupa a varios, como en las fichas de la web.
  const creditOf = (sourceId, operator) => {
    const s = query.health().find((x) => x.id === sourceId);
    return s?.operatorLicenses?.[operator] ?? s?.license ?? s?.name ?? null;
  };

  const indexed = (list) => {
    let at = -Infinity;
    let map = new Map();
    return () => {
      const now = clock.now();
      if (now - at >= INDEX_TTL_MS) {
        map = new Map(list().map((x) => [x.id, x]));
        at = now;
      }
      return map;
    };
  };
  const eventsById = indexed(() => query.events());
  const vehiclesById = indexed(() => query.vehicles());

  /** Lo que dice la vista previa de algo ahora mismo, y si sigue en el directo; null si no se conoce. */
  function lookup(kind, id, lang = 'es') {
    if (!isShareId(id)) return null;
    const now = clock.now();
    if (kind === 'incidencia') {
      const e = eventsById().get(id);
      if (e) return { card: eventShare(e, { now, lang, credit: creditOf(e.source) }), status: 'activa' };
      const gone = ended.get(id);
      // Su fuente la ha vuelto a publicar con otro identificador (la DGT, a veces): el enlace enseña esa, que sigue.
      const again = gone ? successorOf(gone.event, gone.endedAt, eventsById().values(), { now }) : null;
      if (again) return { card: eventShare(again, { now, lang, credit: creditOf(again.source) }), status: 'activa', movedTo: again.id };
      if (gone) {
        return { card: eventShare(gone.event, { now, lang, credit: creditOf(gone.event.source), endedAt: gone.endedAt }), status: 'terminada', ended: gone };
      }
      return null;
    }
    if (kind === 'vehiculo') {
      const v = vehiclesById().get(id);
      return v ? { card: vehicleShare(v, { now, lang, credit: creditOf(v.source, v.operator) }), status: 'activa', vehicle: v } : null;
    }
    if (kind === 'estacion') {
      const st = query.station(id);
      return st ? { card: stationShare(st, { lang }), status: 'activa' } : null;
    }
    return null;
  }

  // Tarjetas ya dibujadas, de la más vieja a la más reciente; y las que se están dibujando (dos peticiones de la misma
  // esperan al mismo dibujo).
  const cards = new Map();
  let cardBytes = 0;
  const drawing = new Map();
  let queued = 0;
  const keepCard = (key, png) => {
    cards.delete(key);
    cards.set(key, png);
    cardBytes += png.byteLength;
    while (cards.size > CARDS_MAX || (cardBytes > CARDS_BYTES && cards.size > 1)) {
      const [oldKey, old] = cards.entries().next().value;
      cards.delete(oldKey);
      cardBytes -= old.byteLength;
    }
  };

  return {
    lookup,
    /** Lo de una página de enlace (lookup), contando la visita por tipo y por si seguía en el directo. */
    page(kind, id, lang = 'es') {
      const found = lookup(kind, id, lang);
      if (SHARE_KINDS.includes(kind)) {
        totals.pages[kind][found?.status ?? 'desconocida']++;
        dirty = true;
      }
      return found;
    },
    /** ¿Hay tarjetas propias? (sin la letra, no: las páginas enseñan la imagen general) */
    cardsAvailable: () => renderer.available(),

    /**
     * La tarjeta de algo, tal como está ahora: { png, version }, o null si no se conoce (o no hay tarjetas). Lanza
     * ShareBusy si hay que dibujarla y no hay sitio en la cola o `allow()` (el presupuesto de quien pide) dice que no.
     * @param {{ allow?: () => boolean }} [o]
     */
    async card(kind, id, lang = 'es', { allow = () => true } = {}) {
      const found = lookup(kind, id, lang);
      if (!found || !renderer.available()) return null;
      const { version } = found.card;
      const key = `${kind}|${id}|${found.card.lang}|${version}`;
      const hit = cards.get(key);
      if (hit) {
        cards.delete(key); // la más reciente, al final
        cards.set(key, hit);
        countCard('servida');
        return { png: hit, version };
      }
      let job = drawing.get(key);
      if (!job) {
        if (queued >= QUEUE_MAX || !allow()) {
          countCard('rechazada');
          throw new ShareBusy();
        }
        queued++;
        job = renderer.render(found.card)
          .then((png) => {
            keepCard(key, png);
            countCard('dibujada');
            return png;
          })
          .finally(() => {
            queued--;
            drawing.delete(key);
          });
        drawing.set(key, job);
      }
      try {
        const png = await job;
        countCard('servida');
        return { png, version };
      } catch (err) {
        log.warn(`[compartir] no se pudo dibujar la tarjeta de ${kind} ${id}: ${err.message}`);
        return null;
      }
    },

    /** Cada minuto: apunta las incidencias que han dejado de salir en el directo desde la vuelta anterior. */
    remember() {
      const current = query.events();
      const before_ = before;
      before = current;
      const sizeBefore = ended.size;
      const added = noteEnded(ended, before_, current, { now: clock.now(), keepMs, max: maxEnded });
      if (added || ended.size !== sizeBefore) dirty = true;
      return added;
    },

    /** Al arrancar: las terminadas que guardó el servidor anterior. */
    async restore() {
      const raw = await store.load();
      ended = restoreEnded(raw, { now: clock.now(), keepMs, max: maxEnded });
      totals = restoreShareTotals(raw?.totals, clock.now());
      if (ended.size) log.info(`[compartir] ${ended.size} incidencias terminadas recuperadas`);
    },

    /** Cada pocos minutos y al apagar, si ha cambiado algo. */
    async save() {
      if (!dirty) return;
      dirty = false;
      await store.save(endedRecord(ended, totals));
    },

    /** Para las pruebas y las métricas: cuántas terminadas y tarjetas guarda. */
    sizes: () => ({ ended: ended.size, cards: cards.size, cardBytes }),
    /** Para las métricas (/metrics): los totales de uso (guardados: no vuelven a 0 al arrancar) y lo que guarda ahora. */
    usage: () => ({ totals: structuredClone(totals), ended: ended.size, cards: cards.size }),
  };
}
