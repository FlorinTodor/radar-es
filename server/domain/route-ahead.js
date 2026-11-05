// Lo que le queda a un tren hasta el final de su viaje, por el trazado de su viaje pero pasando por
// las paradas que le quedan. El trazado que publica el operador no siempre es el del viaje: Renfe da
// a un C7 Chamartín → Príncipe Pío el trazado que va por Pitis cuando el tren va por Atocha, a un C6
// a Vinaròs uno que acaba en Castelló y a algunos C2 uno que no pasa por Fuente de la Mora. Siguiendo
// el trazado sólo entre paradas que están sobre él, en el orden del viaje, nunca se dibuja por donde
// no va el tren: donde el trazado se aparta de sus paradas, el dibujo se corta.
import { M_PER_DEG_LAT, mPerDegLon, roundBearing5 } from './geo.js';

// Más lejos que esto del trazado, el tren o la parada no están sobre él.
const NEAR_M = 500;
// Entre dos paradas, el trazado no puede ser mucho más largo que la recta: si la parada está cerca de
// dos pasadas del trazado, la lejana es la otra pasada de una línea circular o de un trazado que da la
// vuelta. Si sólo está cerca de una, no hay con qué confundirla, y el trazado largo es la vía: la rampa
// de Pesquera (C1 Santander–Reinosa) da 8,5 km de vía para 2,6 en recta entre Bárcena y Pujayo, y la
// llegada a Alicante-Terminal o a Estació de França da una curva (4-nov-2026).
const DETOUR = 1.8;
const DETOUR_EXTRA_M = 1500;
// Una parada a menos de esto del tren, a lo largo del trazado, es en la que está o la que acaba de
// dejar: no dice hacia dónde va. Con el tren parado en su estación de origen, el GPS lo pone a unos
// metros por delante o por detrás de ella (C1 de Bilbao en Santurtzi, 4-nov-2026: a 2 m «por delante»),
// y si de ahí se sacaba el sentido, la parada siguiente quedaba detrás y no se dibujaba nada.
const AT_STOP_M = 150;

/**
 * @param {Array<[number, number]>} coords  trazado ([lon, lat]), en cualquier sentido
 * @param {[number, number]} at  posición del tren ([lon, lat])
 * @param {Array<[number, number]>} stops  paradas que le quedan, en orden, la última su destino ([lon, lat])
 * @returns {Array<[number, number]>|null} camino desde el tren, o null si ni el primer tramo encaja
 */
export function pathThroughStops(coords, at, stops) {
  if (!coords || coords.length < 2 || !at || !stops?.length) return null;
  const { kx, ky, xy, cum } = prepared(coords);

  // Donde puede estar el tren sobre el trazado: cada pasada a menos de NEAR_M. Casi siempre es una; en
  // una línea circular, el tren en su estación de origen y destino está a la vez al principio y al final
  // del trazado (Santa Justa en el C4 de Sevilla, a 38 y a 37 m), y en una que vuelve sobre sí, en las dos
  // pasadas. Vale la pasada desde la que se llega a más paradas; a igualdad, la más cercana.
  const starts = passesOf(xy, cum, at, kx, ky).sort((a, b) => a.d - b.d);
  let best = null;
  for (const start of starts) {
    const walked = walk(coords, cum, kx, ky, xy, start, at, stops);
    if (!best || walked.reached > best.reached) best = walked;
  }
  return best && best.path.length > 1 ? best.path : null;
}

/** Desde `start` (pasada del tren), por el trazado hasta cada parada mientras encajen. */
function walk(coords, cum, kx, ky, xy, start, at, stops) {
  const path = [coordAt(coords, cum, start.m)];
  let prev = { m: start.m, p: at };
  let dir = 0; // sentido del viaje sobre el trazado (+1 / -1): lo fija la primera parada
  let reached = 0;
  for (const stop of stops) {
    // En una línea circular o que vuelve sobre sí, la parada está cerca de dos pasadas del trazado:
    // vale la que queda por delante, en el sentido del viaje, a menos distancia.
    const hit = project(xy, cum, stop, kx, ky, prev.m, dir);
    if (hit.d > NEAR_M) break;
    const along = hit.m - prev.m;
    const straight = Math.hypot((stop[0] - prev.p[0]) * kx, (stop[1] - prev.p[1]) * ky);
    const sense = Math.sign(along);
    if (Math.abs(along) < AT_STOP_M) { // en la misma parada: no fija el sentido
      if (dir && sense === dir) pushRest(path, slice(coords, cum, prev.m, hit.m));
      prev = { m: hit.m, p: stop };
      reached++;
      continue;
    }
    if ((dir && sense !== dir) || (hit.passes > 1 && Math.abs(along) > DETOUR * straight + DETOUR_EXTRA_M)) break;
    dir = sense;
    pushRest(path, slice(coords, cum, prev.m, hit.m));
    prev = { m: hit.m, p: stop };
    reached++;
  }
  return { path, reached };
}

/**
 * Añade a `path` los puntos de `points` menos el primero (el último de `path`), uno a uno: con
 * path.push(...points), cada punto es un argumento, y un trazado de más de unos 125.000 vértices entre el
 * tren y su parada (lo decide el GTFS del operador) agota la pila y deja /api/live en 500.
 */
function pushRest(path, points) {
  for (let i = 1; i < points.length; i++) path.push(points[i]);
}

// El trazado en metros (x, y) y la distancia acumulada en cada vértice, guardados por trazado: sólo
// cambian si cambia el trazado, y cada lectura de Renfe pide lo que le queda a cientos de Cercanías
// con los mismos. La escala de la longitud, la de la latitud media del trazado (un núcleo de
// Cercanías no pasa de un par de grados: el error es de milésimas).
const preparedShapes = new WeakMap();
function prepared(coords) {
  let p = preparedShapes.get(coords);
  if (!p) {
    const lat = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
    const kx = mPerDegLon(lat);
    const ky = M_PER_DEG_LAT;
    const xy = coords.map(([lon, lat]) => [lon * kx, lat * ky]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    preparedShapes.set(coords, (p = { kx, ky, xy, cum }));
  }
  return p;
}

/**
 * Hacia dónde va por ese camino (grados desde el norte, de 5 en 5), mirando 100 m por delante para no
 * quedarse con una esquina. null si el camino es más corto que unos metros.
 */
export function headingOfPath(path) {
  if (!path || path.length < 2) return null;
  const [x0, y0] = path[0];
  const kx = mPerDegLon(y0);
  const ky = M_PER_DEG_LAT;
  const dist = ([x, y]) => Math.hypot((x - x0) * kx, (y - y0) * ky);
  const far = path.find((p) => dist(p) > 100) ?? (dist(path.at(-1)) > 20 ? path.at(-1) : null);
  if (!far) return null;
  const deg = (Math.atan2((far[0] - x0) * kx, (far[1] - y0) * ky) * 180) / Math.PI;
  return roundBearing5(deg);
}

/**
 * Punto del trazado para `p`: distancia `d` (m) y posición `m` (m desde el principio). Sin `fromM`, el
 * más cercano. Con `fromM`: cada pasada del trazado a menos de NEAR_M (tramos seguidos) da su punto
 * más cercano, y vale la pasada más próxima a lo largo del trazado desde `fromM` (y, si se conoce el
 * sentido `dir`, por delante; si sólo las hay por detrás, la más cercana, y quien llama la descarta).
 */
function project(xy, cum, p, kx, ky, fromM = null, dir = 0) {
  const { nearest, passes } = scan(xy, cum, p, kx, ky);
  if (fromM === null || !passes.length) return { ...nearest, passes: passes.length };
  const ahead = (q) => !dir || Math.sign(q.m - fromM) !== -dir || Math.abs(q.m - fromM) <= 1;
  const pool = passes.filter(ahead);
  const pick = pool.length ? pool.reduce((a, b) => (Math.abs(b.m - fromM) < Math.abs(a.m - fromM) ? b : a))
    : passes.reduce((a, b) => (b.d < a.d ? b : a));
  return { ...pick, passes: passes.length };
}

/** Cada pasada del trazado a menos de NEAR_M de `p` (tramos seguidos), con su punto más cercano. */
const passesOf = (xy, cum, p, kx, ky) => scan(xy, cum, p, kx, ky).passes;

function scan(xy, cum, [lon, lat], kx, ky) {
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
  return { nearest, passes };
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
