// Avisos de servicio GTFS-RT (Service Alerts) de los autobuses que los publican abiertos (AUVASA, EMT
// Málaga): desvíos, paradas trasladadas y paradas suprimidas. Un aviso que suprime paradas es una
// cancelación parcial de la línea (category 'cancelacion', con el aviso como motivo); lo demás, un aviso de
// servicio, como los de EMT Madrid. Se sitúan en la parada que suprimen (o, si no se encuentra, en la que
// cita el aviso), con las coordenadas del horario del operador.
import { decodeFeed } from './gtfs-rt.js';
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { cancellationEvent } from '../../../domain/cancelaciones.js';
import { distanceKm, round5 } from '../../../domain/geo.js';
import { createSeenStore } from '../persistence/seen-store.js';
import { madridClock, madridServiceDay } from './parse.js';
import { followOf, lineKey } from '../../../domain/seguir.js';

const STOPS_TTL_MS = 24 * 3600_000;
const SEVERE_EFFECTS = new Set(['NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS']);
const SUPPRESSED_RE = /paradas? suprimidas?\s*:\s*(.*)$/i;

const text = (t) => ((t?.translation ?? []).find((x) => !x.language || x.language.startsWith('es')) ?? t?.translation?.[0])?.text?.trim() ?? '';
const plain = (s) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ]+/g, ' ').trim();

/**
 * Las paradas suprimidas que dice el texto de un aviso («… - Paradas suprimidas: Plaza Uruguay esquina
 * Honduras»). Si son varias, se parten por comas o «y» sólo cuando cada trozo es una parada del horario
 * (los nombres llevan a veces comas o guiones); si no, va el texto entero como una sola.
 * @param {string} description @param {(name: string) => boolean} [known]
 * @returns {string[]}
 */
export function suppressedStops(description, known = () => false) {
  const list = SUPPRESSED_RE.exec(description ?? '')?.[1]?.trim().replace(/[.\s]+$/, '');
  if (!list) return [];
  if (known(list)) return [list];
  const parts = list.split(/\s*[;,]\s*|\s+y\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 && parts.every(known) ? parts : [list];
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>,
 *           log?: import('../../../application/ports.js').LoggerPort, now?: () => number }} deps
 * @param {{ id: string, name: string, url: string, operator: string, license: string, page?: string,
 *           stopsZip?: () => Promise<Uint8Array>, interval?: number }} options
 *   stopsZip: el horario GTFS del operador, para situar las paradas (sólo se lee su stops.txt).
 * @returns {import('../../../application/ports.js').DataSourcePort}
 */
export function createGtfsRtAlertsSource({ http, cache, log, now = Date.now }, { id, name, url, operator, license, page, stopsZip, interval = 300_000 }) {
  let stops = new Map(); // stop_id → { name, at: [lon, lat] }
  let byName = new Map(); // nombre sin tildes → paradas con ese nombre
  let stopsAt = 0;
  const seenStore = createSeenStore({ cache, name: `${id}-cancelaciones-vistas.v1`, now });

  async function loadStops() {
    if (!stopsZip || now() - stopsAt < STOPS_TTL_MS) return;
    stopsAt = now(); // aunque falle, no reintentar en cada lectura
    try {
      const f = await openGtfs(await stopsZip(), ['stops.txt']);
      const next = new Map();
      const names = new Map();
      for (const s of csvRows(f['stops.txt'])) {
        const at = [+s.stop_lon, +s.stop_lat];
        if (!at.every(Number.isFinite)) continue;
        const stop = { name: s.stop_name, at };
        next.set(s.stop_id, stop);
        const key = plain(s.stop_name);
        names.set(key, [...(names.get(key) ?? []), stop]);
      }
      stops = next;
      byName = names;
    } catch (err) {
      log?.warn(`[${id}] paradas del horario: ${err.message}; los avisos van sin ubicación`);
    }
  }

  /** La parada con ese nombre más cerca de `near` (la que cita el aviso), o la primera. */
  const stopNamed = (stopName, near) => {
    const found = byName.get(plain(stopName)) ?? [];
    if (!near || found.length < 2) return found[0] ?? null;
    return found.reduce((a, b) => (distanceKm(a.at[1], a.at[0], near.at[1], near.at[0]) <= distanceKm(b.at[1], b.at[0], near.at[1], near.at[0]) ? a : b));
  };

  return {
    id,
    name,
    kind: 'events',
    interval,
    url,
    page,
    license,
    async fetch() {
      await loadStops();
      const feed = decodeFeed(await http.bytes(url));
      if (feed.damaged) log?.warn(`[${id}] sus avisos llegan mal formados: se descartan ${feed.damaged} partes y se usa el resto`);
      const nowMs = now();
      const nowS = nowMs / 1000;
      const cancellations = new Map(); // el mismo aviso viene repetido (uno por línea, a veces dos veces)
      const notices = new Map();
      for (const e of feed.entity ?? []) {
        const a = e.alert;
        if (!a) continue;
        const periods = a.activePeriod ?? [];
        const period = periods.find((p) => (!p.start || +p.start <= nowS) && (!p.end || +p.end >= nowS));
        if (periods.length && !period) continue;
        const header = text(a.headerText);
        const description = text(a.descriptionText);
        if (!header && !description) continue;
        const informed = (a.informedEntity ?? []).find((ie) => ie.stopId && stops.has(ie.stopId));
        const near = informed ? stops.get(informed.stopId) : null;
        const route = (a.informedEntity ?? []).find((ie) => ie.routeId)?.routeId ?? null;
        const line = /l[ií]nea\s+([\p{L}\p{N}]+)/iu.exec(header)?.[1] ?? /l[ií]nea\s+([\p{L}\p{N}]+)/iu.exec(description)?.[1] ?? route;
        const suppressed = suppressedStops(description, (n) => byName.has(plain(n)));
        if (suppressed.length && line) {
          const key = `${line}|${suppressed.join('|')}`;
          if (cancellations.has(key)) continue;
          const first = suppressed.map((n) => stopNamed(n, near)).find(Boolean) ?? near;
          cancellations.set(key, {
            id: `${id}-suprimidas:${line}:${plain(suppressed.join(' ')).replaceAll(' ', '-').slice(0, 80)}`,
            who: `Línea ${line} de ${operator}`,
            operator,
            mode: 'bus',
            service: 'Autobús',
            line,
            number: null,
            follow: followOf(lineKey({ operator, line })),
            stops: null,
            skippedNames: suppressed,
            cancelled: false,
            running: true,
            at: first?.at ?? null,
            reason: `${header ? `${header}: ` : ''}${description}`.replace(/[.\s]*$/, '.'),
            publisher: operator,
            feed: 'GTFS-RT de avisos de servicio',
            feedUrl: url,
            credit: license,
          });
          continue;
        }
        const key = `${header}|${description}|${period?.start ?? ''}`;
        if (notices.has(key)) continue;
        notices.set(key, {
          id: `${id}:${e.id}`,
          category: 'carretera',
          type: 'aviso',
          severity: SEVERE_EFFECTS.has(a.effect) ? 'alta' : 'media',
          title: `${operator} · ${header || 'Aviso'}`,
          description,
          url: text(a.url) || undefined,
          lat: near ? round5(near.at[1]) : null,
          lon: near ? round5(near.at[0]) : null,
          ...(near ? { area: near.name } : {}),
          start: period?.start ? +period.start * 1000 : null,
          end: period?.end ? +period.end * 1000 : null,
          // La línea que nombra: quien la sigue (domain/seguir.js) se entera del aviso.
          ...(line ? { follow: followOf(lineKey({ operator, line })) } : {}),
        });
      }
      const found = [...cancellations.values()];
      const since = await seenStore.stamp(found.map((c) => c.id));
      const current = found.map((c) => cancellationEvent({ ...c, ...since(c.id) }, nowMs));
      const withdrawn = await seenStore.withdrawn(current, { clock: madridClock(nowMs), endOfDay: madridServiceDay(nowMs, 1).midnight });
      return {
        events: [...current, ...withdrawn, ...notices.values()],
        sourceTime: feed.header?.timestamp ? Number(feed.header.timestamp) * 1000 : null,
      };
    },
  };
}
