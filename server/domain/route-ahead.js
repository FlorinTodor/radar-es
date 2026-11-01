// Lo que le queda a un tren hasta el final de su viaje, por el trazado de su viaje pero pasando por
// las paradas que le quedan. El trazado que publica el operador no siempre es el del viaje: Renfe da
// a un C7 Chamartín → Príncipe Pío el trazado que va por Pitis cuando el tren va por Atocha, a un C6
// a Vinaròs uno que acaba en Castelló y a algunos C2 uno que no pasa por Fuente de la Mora. Siguiendo
// el trazado sólo entre paradas que están sobre él, en el orden del viaje, nunca se dibuja por donde
// no va el tren: donde el trazado se aparta de sus paradas, el dibujo se corta.

// Más lejos que esto del trazado, el tren o la parada no están sobre él.
const NEAR_M = 500;
// Entre dos paradas, el trazado no puede ser mucho más largo que la recta (la vía de montaña lo es
// algo; el doble, no: es la otra pasada de una línea circular o un trazado que da la vuelta).
const DETOUR = 1.8;
const DETOUR_EXTRA_M = 1500;

/**
 * @param {Array<[number, number]>} coords  trazado ([lon, lat]), en cualquier sentido
 * @param {[number, number]} at  posición del tren ([lon, lat])
 * @param {Array<[number, number]>} stops  paradas que le quedan, en orden, la última su destino ([lon, lat])
 * @returns {Array<[number, number]>|null} camino desde el tren, o null si ni el primer tramo encaja
 */
export function pathThroughStops(coords, at, stops) {
  if (!coords || coords.length < 2 || !at || !stops?.length) return null;
  const kx = 111_320 * Math.cos((at[1] * Math.PI) / 180);
  const ky = 110_540;
  const xy = coords.map(([lon, lat]) => [lon * kx, lat * ky]);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));

  const start = project(xy, cum, at, kx, ky);
  if (start.d > NEAR_M) return null;
  const path = [coordAt(coords, cum, start.m)];
  let prev = { m: start.m, p: at };
  let dir = 0; // sentido del viaje sobre el trazado (+1 / -1): lo fija la primera parada
  for (const stop of stops) {
    // En una línea circular o que vuelve sobre sí, la parada está cerca de dos pasadas del trazado:
    // vale la que queda por delante, en el sentido del viaje, a menos distancia.
    const hit = project(xy, cum, stop, kx, ky, prev.m, dir);
    if (hit.d > NEAR_M) break;
    const along = hit.m - prev.m;
    const straight = Math.hypot((stop[0] - prev.p[0]) * kx, (stop[1] - prev.p[1]) * ky);
    if (Math.abs(along) < 1) { prev = { m: hit.m, p: stop }; continue; } // en la misma parada
    const sense = Math.sign(along);
    if ((dir && sense !== dir) || Math.abs(along) > DETOUR * straight + DETOUR_EXTRA_M) break;
    dir = sense;
    path.push(...slice(coords, cum, prev.m, hit.m).slice(1));
    prev = { m: hit.m, p: stop };
  }
  return path.length > 1 ? path : null;
}

/**
 * Hacia dónde va por ese camino (grados desde el norte, de 5 en 5), mirando 100 m por delante para no
 * quedarse con una esquina. null si el camino es más corto que unos metros.
 */
export function headingOfPath(path) {
  if (!path || path.length < 2) return null;
  const [x0, y0] = path[0];
  const kx = 111_320 * Math.cos((y0 * Math.PI) / 180);
  const ky = 110_540;
  const dist = ([x, y]) => Math.hypot((x - x0) * kx, (y - y0) * ky);
  const far = path.find((p) => dist(p) > 100) ?? (dist(path.at(-1)) > 20 ? path.at(-1) : null);
  if (!far) return null;
  const deg = (Math.atan2((far[0] - x0) * kx, (far[1] - y0) * ky) * 180) / Math.PI;
  return (Math.round(((deg + 360) % 360) / 5) * 5) % 360;
}

/**
 * Punto del trazado para `p`: distancia `d` (m) y posición `m` (m desde el principio). Sin `fromM`, el
 * más cercano. Con `fromM`: cada pasada del trazado a menos de NEAR_M (tramos seguidos) da su punto
 * más cercano, y vale la pasada más próxima a lo largo del trazado desde `fromM` (y, si se conoce el
 * sentido `dir`, por delante; si sólo las hay por detrás, la más cercana, y quien llama la descarta).
 */
function project(xy, cum, [lon, lat], kx, ky, fromM = null, dir = 0) {
  const x = lon * kx;
  const y = lat * ky;
  let nearest = { d: Infinity, m: 0 };
  const passes = [];
  let run = null;
  for (let i = 1; i < xy.length; i++) {
    const [ax, ay] = xy[i - 1];
    const dx = xy[i][0] - ax;
    const dy = xy[i][1] - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    const m = cum[i - 1] + t * (cum[i] - cum[i - 1]);
    if (d < nearest.d) nearest = { d, m };
    if (d <= NEAR_M) {
      if (!run) passes.push((run = { d, m }));
      else if (d < run.d) Object.assign(run, { d, m });
    } else run = null;
  }
  if (fromM === null || !passes.length) return nearest;
  const ahead = (q) => !dir || Math.sign(q.m - fromM) !== -dir || Math.abs(q.m - fromM) <= 1;
  const pool = passes.filter(ahead);
  if (!pool.length) return passes.reduce((a, b) => (b.d < a.d ? b : a));
  return pool.reduce((a, b) => (Math.abs(b.m - fromM) < Math.abs(a.m - fromM) ? b : a));
}

function coordAt(coords, cum, m) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < m) i++;
  const span = cum[i] - cum[i - 1];
  const t = span ? Math.max(0, Math.min(1, (m - cum[i - 1]) / span)) : 0;
  const [a, b] = [coords[i - 1], coords[i]];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** El trozo de trazado entre `from` y `to` metros, en el sentido de la marcha. */
function slice(coords, cum, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const inner = coords.filter((_, i) => cum[i] > lo && cum[i] < hi);
  const path = [coordAt(coords, cum, lo), ...inner, coordAt(coords, cum, hi)];
  return from <= to ? path : path.reverse();
}
