// Paradas del viaje del vehículo seleccionado (/api/stops/<id>): los puntos del mapa y la lista de su
// ficha. Va aparte de map.js para poder probarlo en Node (map.js carga MapLibre).
import { esc } from './format.js';

/**
 * @typedef {{ name: string, lon: number|null, lat: number|null, time: string|null, eta: string|null, passed: boolean, here?: boolean }} TripStop
 *   here: está parado en ella ahora
 * @typedef {{ stops: TripStop[], partial?: boolean }} TripStops
 */

/** Índice de su próxima parada (ni pasada ni en la que está parado); -1 si no le queda ninguna. */
const nextIndex = (stops) => stops.findIndex((s) => !s.passed && !s.here);

/**
 * Puntos del mapa: origen y destino destacados (`end`: 1), la próxima (`next`: 1), en la que está parado
 * (`here`: 1) y las ya pasadas (`passed`: 1). `rank` ordena las etiquetas que no caben: primero la próxima
 * y en la que está, luego las que le quedan.
 * Las paradas sin posición sólo salen en la lista.
 * @param {TripStops|null} data
 */
export function stopsCollection(data) {
  const stops = data?.stops ?? [];
  const next = nextIndex(stops);
  const features = stops.flatMap((s, i) => {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) return [];
    const end = i === 0 || i === stops.length - 1;
    return [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        i, name: s.name, end: end ? 1 : 0, next: i === next ? 1 : 0, here: s.here ? 1 : 0, passed: s.passed ? 1 : 0,
        rank: i === next || s.here ? 0 : s.passed ? 2 : 1, when: stopWhen(s),
      },
    }];
  });
  return { type: 'FeatureCollection', features };
}

/** «17:05», «17:05 · prevista 17:12» o «prevista 17:12»; '' si no se sabe la hora. */
export function stopWhen(s) {
  if (s.passed) return s.time ?? '';
  return [s.time, s.eta && `prevista ${s.eta}`].filter(Boolean).join(' · ');
}

/**
 * Texto de una parada al pasar el ratón o tocarla en el mapa.
 * @param {{ name: string, when?: string, passed?: number, next?: number, end?: number, i?: number }} p  propiedades del punto
 * @param {number} count  paradas del viaje
 */
export function stopTipHtml(p, count) {
  const role = p.i === 0 ? 'Origen' : p.i === count - 1 ? 'Destino' : null;
  const state = p.passed ? 'ya ha pasado' : p.here ? 'está parado aquí' : p.next ? 'próxima parada' : null;
  const meta = [role, state, p.when].filter(Boolean).join(' · ');
  return `<strong>${esc(p.name)}</strong>${meta ? `<br><span>${esc(meta)}</span>` : ''}`;
}

/**
 * Lista de paradas para la ficha del vehículo, desplegable (abierta si `open`): las pasadas atenuadas, la
 * próxima resaltada y, si la fuente no da todas (FGC), «…» donde faltan. '' si no hay paradas.
 * @param {TripStops|null} data
 * @param {{ open?: boolean }} [opts]
 */
export function stopsListHtml(data, { open = false } = {}) {
  const stops = data?.stops ?? [];
  if (stops.length < 2) return '';
  const next = nextIndex(stops);
  const left = stops.filter((s) => !s.passed && !s.here).length;
  const summary = left === 0 ? `Paradas · ya ha llegado a ${esc(stops.at(-1).name)}`
    : data.partial ? `Paradas · le ${left === 1 ? 'queda' : 'quedan'} ${left}` : `Paradas · le ${left === 1 ? 'queda' : 'quedan'} ${left} de ${stops.length}`;
  const items = stops.map((s, i) => {
    const cls = [s.passed && 'passed', s.here && 'here', i === next && 'next', (i === 0 || i === stops.length - 1) && 'end'].filter(Boolean).join(' ');
    const when = s.here ? ['parado aquí', stopWhen(s)].filter(Boolean).join(' · ') : stopWhen(s);
    const gap = data.partial && i === 1 ? '<li class="gap" aria-label="paradas que la fuente no da">…</li>' : '';
    return `${gap}<li${cls ? ` class="${cls}"` : ''}><span class="ts-name">${esc(s.name)}</span>${when ? `<span class="ts-time">${esc(when)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="trip-stops" data-keep="stops"${open ? ' open' : ''}><summary>${summary}</summary><ol>${items}</ol></details>`;
}
