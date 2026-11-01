// Recorrido del tren seleccionado pegado a la vía. Cada posición GPS se lleva al punto más cercano
// del trazado de su línea, y entre dos posiciones se dibuja el trozo de trazado que las une, con sus
// curvas. Sólo hay trazado de las líneas de Cercanías, metro y tranvía; para el resto, o si el tren
// se aparta del trazado, las posiciones se unen como siempre, en línea recta.

// Más lejos que esto del trazado, la posición no es de esa línea (otro ramal, un tramo que falta en
// el trazado o un GPS malo) y se queda donde está.
const NEAR_M = 250;
// Entre dos posiciones, el camino por el trazado no puede ser mucho más largo que la recta: si lo es,
// la proyección ha caído en otra pasada de la misma línea (líneas circulares o que vuelven sobre sí).
const DETOUR = 3;
const DETOUR_EXTRA_M = 1000;

/**
 * @param {Array<Array<[number, number]>>} parts  tramos del recorrido ([lon, lat]), ya partidos donde faltan datos
 * @param {Array<{ geometry: { type: string, coordinates: Array<[number, number]> } }>} lines  trazados de la línea del tren
 * @returns {Array<Array<[number, number]>>} los mismos tramos, por el trazado donde se puede
 */
export function matchTrack(parts, lines) {
  const all = parts.flat();
  if (!all.length || !lines.length) return parts;
  const lat0 = all[0][1];
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  const toXY = ([lon, lat]) => [lon * kx, lat * ky];
  const shapes = lines.filter((f) => f.geometry?.type === 'LineString' && f.geometry.coordinates.length > 1).map((f) => shape(f.geometry.coordinates, toXY));
  if (!shapes.length) return parts;

  return parts.map((part) => {
    const out = [];
    let prev = null; // { shape, m, xy } de la posición anterior si estaba sobre el trazado
    for (const lonLat of part) {
      const xy = toXY(lonLat);
      const hit = nearest(shapes, xy);
      if (!hit) {
        out.push(lonLat);
        prev = null;
        continue;
      }
      const straight = Math.hypot(xy[0] - (prev?.xy[0] ?? 0), xy[1] - (prev?.xy[1] ?? 0));
      if (prev && prev.shape === hit.shape && Math.abs(hit.m - prev.m) <= DETOUR * straight + DETOUR_EXTRA_M) {
        out.push(...slice(hit.shape, prev.m, hit.m).slice(1));
      } else {
        out.push(pointAt(hit.shape, hit.m));
      }
      prev = { shape: hit.shape, m: hit.m, xy };
    }
    return out;
  });
}

/** Trazado preparado: coordenadas, puntos en metros, distancia acumulada y caja para descartar rápido. */
function shape(coords, toXY) {
  const xy = coords.map(toXY);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  return { coords, xy, cum, box: [Math.min(...xs) - NEAR_M, Math.min(...ys) - NEAR_M, Math.max(...xs) + NEAR_M, Math.max(...ys) + NEAR_M] };
}

/** El punto más cercano entre todos los trazados, si está a menos de NEAR_M: { shape, m (metros desde el inicio) }. */
function nearest(shapes, [x, y]) {
  let best = null;
  for (const s of shapes) {
    if (x < s.box[0] || y < s.box[1] || x > s.box[2] || y > s.box[3]) continue;
    for (let i = 1; i < s.xy.length; i++) {
      const [ax, ay] = s.xy[i - 1];
      const [bx, by] = s.xy[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d <= NEAR_M && (!best || d < best.d)) best = { shape: s, d, m: s.cum[i - 1] + t * (s.cum[i] - s.cum[i - 1]) };
    }
  }
  return best;
}

/** Coordenada [lon, lat] a `m` metros del inicio del trazado. */
function pointAt(s, m) {
  let i = 1;
  while (i < s.cum.length - 1 && s.cum[i] < m) i++;
  const span = s.cum[i] - s.cum[i - 1];
  const t = span ? (m - s.cum[i - 1]) / span : 0;
  const [a, b] = [s.coords[i - 1], s.coords[i]];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** El trozo de trazado entre `from` y `to` metros, en el sentido de la marcha (puede ir hacia atrás). */
function slice(s, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const inner = s.coords.filter((_, i) => s.cum[i] > lo && s.cum[i] < hi);
  const path = [pointAt(s, lo), ...inner, pointAt(s, hi)];
  return from <= to ? path : path.reverse();
}
