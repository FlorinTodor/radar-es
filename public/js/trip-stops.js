// Paradas del viaje del vehículo seleccionado (/api/stops/<id>): los puntos del mapa y la lista de su
// ficha. Va aparte de map.js para poder probarlo en Node (map.js carga MapLibre).
import { esc } from './format.js';
import { t, tn } from './i18n.js';

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
  // Un viaje cancelado no tiene próxima parada; las suprimidas se ven como las ya pasadas (en gris).
  const next = data?.cancelled ? -1 : nextIndex(stops);
  const features = stops.flatMap((s, i) => {
    if (!Number.isFinite(s.lon) || !Number.isFinite(s.lat)) return [];
    const end = i === 0 || i === stops.length - 1;
    return [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: {
        i, name: s.name, end: end ? 1 : 0, next: i === next ? 1 : 0, here: s.here ? 1 : 0, passed: s.passed || s.skipped ? 1 : 0,
        ...(s.skipped ? { skipped: 1 } : {}),
        rank: i === next || s.here ? 0 : s.passed || s.skipped ? 2 : 1, when: stopWhen(s),
      },
    }];
  });
  return { type: 'FeatureCollection', features };
}

// Sitios para el nombre de una parada, por orden: debajo del punto y, si ahí choca con otro nombre o con
// el punto de otra parada, encima (en em, dejando sitio a la placa del vehículo si está en la parada).
// A los lados no: centrado sobre su punto, cabe en el margen del encuadre (STOP_LABEL_MARGIN de map.js),
// y a un lado el de una parada cerca del borde se saldría de la pantalla.
export const STOP_LABEL_ANCHORS = ['top', [0, 1.6], 'bottom', [0, -1.6]];

// Hueco que ocupa en el mapa el punto de cada parada, para que los nombres no caigan encima: una imagen
// transparente de STOP_SPACE_PX px (map.js), escalada al tamaño del punto. Lo bastante para el punto
// grande del origen, el destino y la próxima (8,5 px de radio más el borde) y para los demás.
export const STOP_SPACE_PX = 24;
export const STOP_SPACE_SIZE = { key: 0.9, rest: 0.65 };

/** El hueco de los puntos: siempre, aunque se toquen, y apartando los nombres (no ignora la colocación). */
export function stopSpaceLayout(keyFilter) {
  return {
    'icon-image': 'stop-space', 'icon-size': ['case', keyFilter, STOP_SPACE_SIZE.key, STOP_SPACE_SIZE.rest],
    'icon-allow-overlap': true, 'icon-ignore-placement': false,
  };
}

/**
 * Rótulo de las paradas en el mapa. `key`: el origen, el destino y la próxima (o en la que está parado).
 * - Esas tres salen siempre: si no caben en ningún sitio sin chocar, se pintan igual.
 * - Las demás se ocultan si chocan, antes las ya pasadas.
 * map.js pone la capa de esas tres encima de la de las demás, y encima de las dos el hueco de los puntos.
 * MapLibre coloca de la capa de arriba hacia abajo: primero los puntos, luego esas tres y luego las
 * demás, que esquivan lo ya colocado.
 * @param {{ key: boolean, font: string[] }} opts
 */
export function stopLabelLayout({ key, font }) {
  return {
    'text-field': ['get', 'name'], 'text-font': font,
    'text-size': key ? 12.5 : 11.5, 'text-max-width': key ? 12 : 10,
    'text-variable-anchor-offset': STOP_LABEL_ANCHORS,
    // La próxima y en la que está, antes que el origen y el destino; en las demás, antes las que le quedan.
    'symbol-sort-key': key ? ['case', ['==', ['get', 'end'], 1], 1, 0] : ['get', 'rank'],
    ...(key ? { 'text-allow-overlap': true } : {}),
  };
}

/**
 * Puntos que encuadra el mapa al seleccionar el vehículo: todas las paradas de su viaje con posición, del
 * origen al destino, y el propio vehículo (puede ir fuera de ellas, p. ej. con la posición sin poner al día).
 * @param {TripStops|null} data  @param {{ lon: number, lat: number }} [vehicle]
 * @returns {number[][]} [lon, lat]
 */
export function tripFramePoints(data, vehicle) {
  const points = (data?.stops ?? []).filter((s) => Number.isFinite(s.lon) && Number.isFinite(s.lat)).map((s) => [s.lon, s.lat]);
  if (Number.isFinite(vehicle?.lon) && Number.isFinite(vehicle?.lat)) points.push([vehicle.lon, vehicle.lat]);
  return points;
}

/** «17:05», «17:05 · prevista 17:12» o «prevista 17:12»; '' si no se sabe la hora. */
export function stopWhen(s) {
  if (s.passed) return s.time ?? '';
  return [s.time, s.eta && t('prevista {time}', { time: s.eta })].filter(Boolean).join(' · ');
}

/**
 * Texto de una parada al pasar el ratón o tocarla en el mapa.
 * @param {{ name: string, when?: string, passed?: number, next?: number, end?: number, i?: number }} p  propiedades del punto
 * @param {number} count  paradas del viaje
 */
export function stopTipHtml(p, count) {
  const role = p.i === 0 ? t('Origen') : p.i === count - 1 ? t('Destino') : null;
  const state = p.skipped ? t('suprimida') : p.passed ? t('ya ha pasado') : p.here ? t('está parado aquí') : p.next ? t('próxima parada') : null;
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
  const summary = left === 0 ? t('Paradas · ya ha llegado a {name}', { name: esc(stops.at(-1).name) })
    : data.partial ? tn('Paradas · le queda {n}', 'Paradas · le quedan {n}', left)
      : tn('Paradas · le queda {n} de {total}', 'Paradas · le quedan {n} de {total}', left, { total: stops.length });
  const items = stops.map((s, i) => {
    const cls = [s.passed && 'passed', s.here && 'here', i === next && 'next', (i === 0 || i === stops.length - 1) && 'end'].filter(Boolean).join(' ');
    const when = s.here ? [t('parado aquí'), stopWhen(s)].filter(Boolean).join(' · ') : stopWhen(s);
    const gap = data.partial && i === 1 ? `<li class="gap" aria-label="${esc(t('paradas que la fuente no da'))}">…</li>` : '';
    return `${gap}<li${cls ? ` class="${cls}"` : ''}><span class="ts-name">${esc(s.name)}</span>${when ? `<span class="ts-time">${esc(when)}</span>` : ''}</li>`;
  }).join('');
  return `<details class="trip-stops" data-keep="stops"${open ? ' open' : ''}><summary>${summary}</summary><ol>${items}</ol></details>`;
}
