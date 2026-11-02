// Recorridos de un tren por la vía de la red ferroviaria general (los tramos de vía en servicio):
// - El reciente (matchToRail). Las posiciones de los trenes de Larga y Media Distancia de Renfe caen sobre
//   esa red, pero llegan cada 20 s y a veces pasan minutos sin llegar (túneles, zonas sin cobertura):
//   unidas con rectas, la línea corta por el mar o el monte. Aquí cada posición va a una vía cercana y
//   entre dos posiciones seguidas se dibuja el camino más corto por la vía que las une, pasando de un
//   tramo a otro por las estaciones y bifurcaciones.
// - Lo que le queda hasta su destino (routeAhead): desde su posición, por las paradas que le quedan.
// En los dos, la vía de cada punto se elige mirando el recorrido entero (programación dinámica), con
// preferencia por la vía de su ancho.
//
// Los tramos llegan sueltos (cada uno une dos estaciones o bifurcaciones). Con ellos se arma un grafo:
// los extremos que coinciden son el mismo nudo, y donde un tramo acaba en mitad de otro, ese otro se
// parte en dos. Para no recorrer los ~85.000 puntos de la red en cada consulta, los trozos de vía se
// guardan en una rejilla de celdas de ~1 km. Todo va en arrays tipados: pocos objetos y poca memoria.
//
// Puro: sin red ni disco. La red llega ya descargada como lista de líneas [lon, lat].

const RAD = Math.PI / 180;
const KY = 110_540; // metros por grado de latitud
const kx = (lat) => 111_320 * Math.cos(lat * RAD); // metros por grado de longitud a esa latitud

/** Distancia en metros entre dos puntos cercanos (proyección local; sobra para unos cientos de km). */
export function meters(lon1, lat1, lon2, lat2) {
  return Math.hypot((lon2 - lon1) * kx((lat1 + lat2) / 2), (lat2 - lat1) * KY);
}

// Más lejos que esto de la vía, la posición no está en la red (un tramo que no está en servicio, una
// línea de otro país) y se queda donde está. Las posiciones de Renfe de Larga Distancia caen a menos
// de 3 m de los tramos: el margen es para los datos que no sean tan finos sin pegar el tren a otra vía.
export const NEAR_M = 150;
// Extremos de tramos más cerca que esto son el mismo nudo de la red: los tramos no siempre se tocan
// exactamente (en el 90 % de los nudos coinciden al metro; algunos quedan a 20-40 m).
export const MERGE_M = 40;
// Extremos con el mismo código de estación o bifurcación son el mismo nudo aunque estén más lejos (en
// Lebrija los dos tramos de la línea Sevilla-Cádiz acaban a 43 m; en las estaciones grandes, a 100-200 m).
export const CODE_MERGE_M = 250;
// Entre dos posiciones, el camino por la vía no puede ser mucho más largo que la recta: si lo es, la
// vía que las une no está en la red (o una de las dos no es buena) y se dibuja la recta, como antes.
export const DETOUR = 3;
export const DETOUR_EXTRA_M = 1000;
// Con un hueco de minutos, una vía de montaña que da vueltas (la rampa de Pajares: 19 km de vía para 2 km
// de recta; cerca de Ponferrada, 7,5 km para 0,9) sí puede ser el camino: tras LOOP_GAP_MS sin posiciones
// se admite hasta LOOP_DETOUR veces la recta si al tren le ha dado tiempo a recorrerlo a LOOP_SPEED. Entre
// dos lecturas casi seguidas, no: dos posiciones en vías paralelas de una estación darían la vuelta por un
// cambio de vía lejano (en Barcelona-Sants, 2,3 km para 300 m).
export const LOOP_DETOUR = 12;
const LOOP_SPEED = 160 / 3.6; // m/s
const LOOP_GAP_MS = 2 * 60_000;
// Cada posición puede ir a cualquier vía a menos de SNAP_SLACK_M más que la más cercana (las paralelas de
// una estación, o la de alta velocidad junto a la convencional). La de cada posición se elige mirando el
// recorrido entero: cada metro de la posición a su vía cuesta como SNAP_WEIGHT metros de camino.
const SNAP_SLACK_M = 25;
const SNAP_WEIGHT = 10;
// Más de esto entre dos posiciones seguidas es un rato largo sin datos: no se unen (como TRACK_GAP_KM
// en public/js/map.js, que parte el recorrido en el mismo sitio).
export const GAP_KM = 30;
// Ningún paso de la línea dibujada puede pasar de esto: el mapa la partiría como si faltaran datos.
const MAX_STEP_M = 10_000;

// Ancho de vía de cada tramo (lo que Adif llama COD_ANCHO_): un AVE no puede ir por vía de ancho
// ibérico ni un Regional por la de ancho estándar. Sirve para preferir la vía buena entre dos paralelas.
// Mixta: de tres carriles, para los dos anchos. La métrica (la antigua Feve) es una red aparte: sus vías
// no se unen con las demás aunque acaben en la misma estación.
export const GAUGE = { unknown: 0, iberian: 1, standard: 2, mixed: 3, metric: 4 };
// Un tren puede pasar por vía de otro ancho sólo si no hay otra (datos de vía mal clasificados,
// cambiadores de ancho): esa vía cuesta WRONG_GAUGE veces su longitud.
const WRONG_GAUGE = 3;

/**
 * Coste por ancho de vía para un tren de la red general (para route, matchToRail y routeAhead): la vía
 * métrica nunca es la suya y, si sólo va por un ancho (`gauge`: 'standard' o 'iberian'), tampoco la del otro.
 * @returns {number[]}
 */
export function gaugeFactors(gauge) {
  const factors = [1, 1, 1, 1, WRONG_GAUGE];
  if (gauge === 'standard') factors[GAUGE.iberian] = WRONG_GAUGE;
  if (gauge === 'iberian') factors[GAUGE.standard] = WRONG_GAUGE;
  return factors;
}

/** ¿Pueden dos tramos de estos anchos tocarse en un nudo? La vía métrica sólo con la métrica. */
const joinable = (g1, g2) => (g1 === GAUGE.metric) === (g2 === GAUGE.metric) || !g1 || !g2;

// Lo que le queda a un tren hasta su destino: entre parada y parada, el camino por la vía no puede
// pasar de esto (la vía de montaña es más larga que la recta, pero no tanto); si pasa, no se dibuja.
export const LEG_DETOUR = 3;
export const LEG_EXTRA_M = 5000;
// Las coordenadas de una estación caen en el edificio o entre sus vías: valen todas las vías que pasan
// a menos de STOP_SPREAD_M más que la más cercana (en las estaciones con vías de los dos anchos, las
// dos), hasta STOP_M. El tren pasa por la que le queda de camino.
export const STOP_M = 600;
const STOP_SPREAD_M = 100;

const CELL = 0.01; // grados (~1,1 km de latitud y ~0,85 km de longitud en España)
const cellOf = (deg) => Math.floor(deg / CELL);
const cellKey = (ix, iy) => ix * 100_000 + iy + 50_000;

/**
 * @typedef {object} RailNetwork  Red preparada para pegar recorridos a la vía (ver buildRailNetwork).
 * @property {number} edges  tramos (ya partidos en las bifurcaciones)
 * @property {number} nodes  nudos (estaciones, bifurcaciones, finales de vía)
 * @property {number} points puntos de vía
 * @property {number} bytes  memoria aproximada de los arrays
 */

/**
 * Prepara la red: grafo de tramos y nudos, e índice espacial.
 * @param {Array<Array<[number, number]>>} lines  tramos de vía como líneas [lon, lat]
 * @param {{ mergeM?: number, gauges?: number[], codes?: Array<[string|null, string|null]> }} [options]
 *   gauges: ancho de cada línea (GAUGE); codes: código de la estación o bifurcación de cada extremo.
 * @returns {RailNetwork}
 */
export function buildRailNetwork(lines, { mergeM = MERGE_M, gauges = [], codes = [] } = {}) {
  const clean = [];
  for (const [i, line] of (lines ?? []).entries()) {
    const pts = [];
    for (const p of line ?? []) {
      const lon = p?.[0];
      const lat = p?.[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const last = pts.at(-1);
      if (last && last[0] === lon && last[1] === lat) continue;
      pts.push([lon, lat]);
    }
    pts.gauge = gauges[i] ?? GAUGE.unknown;
    pts.codes = codes[i] ?? [null, null];
    if (pts.length > 1) clean.push(pts);
  }
  const pieces = splitAtJunctions(clean, mergeM);
  const net = pack(pieces);
  linkNodes(net, mergeM, pieces.map((l) => l.codes));
  return net;
}

/**
 * Líneas en arrays tipados: los puntos de la línea i van de first[i] a first[i + 1] - 1, y el trozo de
 * vía g une los puntos g y g + 1 (si son de la misma línea). cum: metros desde el inicio de su línea.
 */
function pack(lines) {
  let n = 0;
  for (const l of lines) n += l.length;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const cum = new Float64Array(n);
  const lineOf = new Int32Array(n);
  const first = new Int32Array(lines.length + 1);
  const gauge = new Uint8Array(lines.length);
  let k = 0;
  lines.forEach((l, i) => {
    first[i] = k;
    gauge[i] = l.gauge ?? GAUGE.unknown;
    for (let j = 0; j < l.length; j++, k++) {
      lon[k] = l[j][0];
      lat[k] = l[j][1];
      lineOf[k] = i;
      cum[k] = j ? cum[k - 1] + meters(lon[k - 1], lat[k - 1], lon[k], lat[k]) : 0;
    }
  });
  first[lines.length] = n;
  const net = { lon, lat, cum, lineOf, first, gauge, edges: lines.length, points: n };
  net.index = buildIndex(net);
  return net;
}

const lengthOf = (net, e) => net.cum[net.first[e + 1] - 1];

/**
 * Índice espacial: para cada celda de la rejilla, los trozos de vía que pasan por ella. Cada trozo se
 * recorre a pasos de media celda: así cualquier punto a menos de ~600 m de un trozo tiene una muestra
 * de ese trozo en su celda o en una de las 8 de alrededor. Celdas ordenadas para buscarlas por bisección.
 */
function buildIndex(net) {
  const keys = [];
  const vals = [];
  for (let g = 0; g + 1 < net.points; g++) {
    if (net.lineOf[g + 1] !== net.lineOf[g]) continue;
    const dlon = net.lon[g + 1] - net.lon[g];
    const dlat = net.lat[g + 1] - net.lat[g];
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dlon), Math.abs(dlat)) / (CELL / 2)));
    let last = NaN;
    for (let s = 0; s <= steps; s++) {
      const key = cellKey(cellOf(net.lon[g] + (dlon * s) / steps), cellOf(net.lat[g] + (dlat * s) / steps));
      if (key === last) continue;
      keys.push(key);
      vals.push(g);
      last = key;
    }
  }
  const order = Uint32Array.from(keys, (_, i) => i).sort((a, b) => keys[a] - keys[b] || vals[a] - vals[b]);
  const cells = [];
  const offsets = [];
  const items = [];
  for (const i of order) {
    if (cells.at(-1) !== keys[i]) {
      cells.push(keys[i]);
      offsets.push(items.length);
    } else if (items.at(-1) === vals[i]) continue;
    items.push(vals[i]);
  }
  offsets.push(items.length);
  return { cells: Int32Array.from(cells), offsets: Int32Array.from(offsets), items: Int32Array.from(items) };
}

/** Llama a `fn(g)` con cada trozo de vía de la celda del punto y de las 8 de alrededor (puede repetir). */
function nearPieces(index, lon, lat, fn) {
  const ix = cellOf(lon);
  const iy = cellOf(lat);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const c = bisect(index.cells, cellKey(ix + dx, iy + dy));
      if (c < 0) continue;
      for (let k = index.offsets[c]; k < index.offsets[c + 1]; k++) fn(index.items[k]);
    }
  }
}

function bisect(arr, key) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === key) return mid;
    if (arr[mid] < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Proyección de un punto sobre el trozo g: { d (metros), t (0-1 a lo largo del trozo) }. */
function project(net, g, lon, lat) {
  const k = kx(lat);
  const ax = (net.lon[g] - lon) * k;
  const ay = (net.lat[g] - lat) * KY;
  const dx = (net.lon[g + 1] - lon) * k - ax;
  const dy = (net.lat[g + 1] - lat) * KY - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}

/** Punto de la vía en el trozo g, a la fracción t, como sitio del recorrido: { edge, m, lon, lat, d }. */
function siteAt(net, g, t, d) {
  return {
    edge: net.lineOf[g],
    m: net.cum[g] + t * (net.cum[g + 1] - net.cum[g]),
    lon: net.lon[g] + t * (net.lon[g + 1] - net.lon[g]),
    lat: net.lat[g] + t * (net.lat[g + 1] - net.lat[g]),
    d,
  };
}

/**
 * Punto de la red más cercano a una posición, si está a menos de `maxM` metros (la rejilla sólo mira
 * las celdas de alrededor: con más de ~600 m puede no encontrar la vía).
 * @returns {{ edge: number, m: number, lon: number, lat: number, d: number } | null}
 */
export function nearestOnRail(net, lon, lat, maxM = NEAR_M) {
  let best = null;
  nearPieces(net.index, lon, lat, (g) => {
    const p = project(net, g, lon, lat);
    if (p.d <= maxM && (!best || p.d < best.d)) best = { g, ...p };
  });
  return best && siteAt(net, best.g, best.t, best.d);
}

/**
 * Donde un tramo acaba en mitad de otro (una bifurcación que la red no corta), ese otro se parte en dos
 * por ahí, para que el grafo pueda pasar de uno a otro.
 */
function splitAtJunctions(lines, mergeM) {
  const net = pack(lines);
  const cuts = lines.map(() => []);
  for (let i = 0; i < lines.length; i++) {
    for (const v of [net.first[i], net.first[i + 1] - 1]) {
      const nearest = new Map(); // línea → { g, d, t } más cercano a este extremo
      nearPieces(net.index, net.lon[v], net.lat[v], (g) => {
        const line = net.lineOf[g];
        if (line === i || !joinable(net.gauge[line], net.gauge[i])) return;
        const p = project(net, g, net.lon[v], net.lat[v]);
        if (p.d <= mergeM && !(nearest.get(line)?.d <= p.d)) nearest.set(line, { g, ...p });
      });
      for (const [line, { g, t }] of nearest) {
        const m = net.cum[g] + t * (net.cum[g + 1] - net.cum[g]);
        if (m > mergeM && m < lengthOf(net, line) - mergeM) cuts[line].push(m);
      }
    }
  }
  const out = [];
  lines.forEach((l, i) => {
    const ms = cuts[i].sort((a, b) => a - b).filter((m, k, all) => !k || m - all[k - 1] > mergeM);
    if (!ms.length) {
      out.push(l);
      return;
    }
    const base = net.first[i];
    // Los trozos de en medio no acaban en una estación con código: sólo el primero y el último.
    const cut = (points, codes) => Object.assign(points, { gauge: l.gauge, codes });
    let piece = cut([l[0]], [l.codes[0], null]);
    let c = 0;
    for (let j = 1; j < l.length; j++) {
      const from = net.cum[base + j - 1];
      const to = net.cum[base + j];
      while (c < ms.length && ms[c] < to) {
        const t = to > from ? (ms[c] - from) / (to - from) : 0;
        const p = [l[j - 1][0] + t * (l[j][0] - l[j - 1][0]), l[j - 1][1] + t * (l[j][1] - l[j - 1][1])];
        piece.push(p);
        out.push(piece);
        piece = cut([p], [null, null]);
        c++;
      }
      piece.push(l[j]);
    }
    piece.codes[1] = l.codes[1];
    out.push(piece);
  });
  return out;
}

/**
 * Nudos del grafo: los extremos de tramo a menos de `mergeM`, o a menos de CODE_MERGE_M con el mismo
 * código, se juntan en uno (unión-búsqueda con una rejilla de extremos). Deja en la red los nudos de
 * cada tramo (na, nb) y, por nudo, sus tramos (adj).
 */
function linkNodes(net, mergeM, codes) {
  const E = net.edges;
  const ends = new Int32Array(2 * E); // extremo 2e = inicio del tramo e; 2e + 1 = final
  for (let e = 0; e < E; e++) {
    ends[2 * e] = net.first[e];
    ends[2 * e + 1] = net.first[e + 1] - 1;
  }
  const parent = Int32Array.from({ length: 2 * E }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const grid = new Map();
  for (let i = 0; i < 2 * E; i++) {
    const v = ends[i];
    const key = cellKey(cellOf(net.lon[v]), cellOf(net.lat[v]));
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  for (let i = 0; i < 2 * E; i++) {
    const v = ends[i];
    const ix = cellOf(net.lon[v]);
    const iy = cellOf(net.lat[v]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(cellKey(ix + dx, iy + dy)) ?? []) {
          if (j <= i) continue;
          const w = ends[j];
          const d = meters(net.lon[v], net.lat[v], net.lon[w], net.lat[w]);
          const code = codes[i >> 1]?.[i & 1];
          if (!joinable(net.gauge[i >> 1], net.gauge[j >> 1])) continue;
          if (d <= mergeM || (code && d <= CODE_MERGE_M && code === codes[j >> 1]?.[j & 1])) parent[find(i)] = find(j);
        }
      }
    }
  }
  const ids = new Map();
  const node = (i) => {
    const root = find(i);
    if (!ids.has(root)) ids.set(root, ids.size);
    return ids.get(root);
  };
  net.na = new Int32Array(E);
  net.nb = new Int32Array(E);
  for (let e = 0; e < E; e++) {
    net.na[e] = node(2 * e);
    net.nb[e] = node(2 * e + 1);
  }
  net.nodes = ids.size;
  // Tramos de cada nudo (lista compacta). Un tramo que sale y vuelve al mismo nudo no lleva a otro sitio.
  const deg = new Int32Array(net.nodes + 1);
  for (let e = 0; e < E; e++) {
    if (net.na[e] === net.nb[e]) continue;
    deg[net.na[e] + 1]++;
    deg[net.nb[e] + 1]++;
  }
  for (let n = 0; n < net.nodes; n++) deg[n + 1] += deg[n];
  net.adjOffsets = deg;
  net.adj = new Int32Array(deg[net.nodes]);
  const fill = deg.slice(0, net.nodes);
  for (let e = 0; e < E; e++) {
    if (net.na[e] === net.nb[e]) continue;
    net.adj[fill[net.na[e]]++] = e;
    net.adj[fill[net.nb[e]]++] = e;
  }
  net.bytes = [net.lon, net.lat, net.cum, net.lineOf, net.first, net.gauge, net.na, net.nb, net.adjOffsets, net.adj,
    net.index.cells, net.index.offsets, net.index.items].reduce((s, a) => s + a.byteLength, 0);
}

/** Puntos [lon, lat] del tramo e entre `from` y `to` metros, en ese sentido (puede ir hacia atrás). */
function slice(net, e, from, to) {
  const a = net.first[e];
  const b = net.first[e + 1] - 1;
  const at = (m) => {
    let lo = a;
    let hi = b;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (net.cum[mid] <= m) lo = mid;
      else hi = mid;
    }
    const span = net.cum[hi] - net.cum[lo];
    const t = span ? Math.max(0, Math.min(1, (m - net.cum[lo]) / span)) : 0;
    return [net.lon[lo] + t * (net.lon[hi] - net.lon[lo]), net.lat[lo] + t * (net.lat[hi] - net.lat[lo])];
  };
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const path = [at(lo)];
  for (let k = a; k <= b; k++) if (net.cum[k] > lo && net.cum[k] < hi) path.push([net.lon[k], net.lat[k]]);
  path.push(at(hi));
  return from <= to ? path : path.reverse();
}

/** Montículo binario de mínimos (distancia, nudo) para Dijkstra. */
function heap() {
  const d = [];
  const n = [];
  return {
    get size() { return d.length; },
    push(dist, node) {
      let i = d.length;
      d.push(dist);
      n.push(node);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (d[p] <= dist) break;
        d[i] = d[p];
        n[i] = n[p];
        i = p;
      }
      d[i] = dist;
      n[i] = node;
    },
    pop() {
      const top = [d[0], n[0]];
      const lastD = d.pop();
      const lastN = n.pop();
      if (d.length) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= d.length) break;
          if (c + 1 < d.length && d[c + 1] < d[c]) c++;
          if (d[c] >= lastD) break;
          d[i] = d[c];
          n[i] = n[c];
          i = c;
        }
        d[i] = lastD;
        n[i] = lastN;
      }
      return top;
    },
  };
}

/**
 * Camino más corto por la vía desde el sitio `a` hasta el primero que alcance de los sitios `targets`
 * (cada uno, un punto de un tramo), si no mide más de `capM` (ver explore).
 * @param {RailNetwork} net
 * @param {{ edge: number, m: number }} a
 * @param {Array<{ edge: number, m: number }>} targets
 * @param {number} capM
 * @param {number[]} [factors]
 * @returns {{ length: number, cost: number, path: Array<[number, number]>, target: object } | null}
 */
function route(net, a, targets, capM, factors) {
  const bound = capM * Math.max(1, ...(factors ?? [])); // en coste: la longitud se comprueba al final
  const { goals, via } = explore(net, a, targets, bound, factors, false);
  let i = -1;
  goals.forEach((g, j) => { if (g && (i < 0 || g.cost < goals[i].cost)) i = j; });
  if (i < 0 || !(goals[i].cost <= bound)) return null;
  const { length, path } = assemble(net, a, targets[i], goals[i], via);
  return length <= capM ? { length, cost: goals[i].cost, path, target: targets[i] } : null;
}

/**
 * Dijkstra entre los nudos desde el sitio `a`: empieza por los dos extremos de su tramo y llega a cada
 * destino al entrar por un extremo en su tramo (o directamente, si está en el mismo tramo). El coste de
 * cada tramo es su longitud por `factors[ancho del tramo]` (1 si no se da): así se evita sin prohibirla
 * la vía de otro ancho. Con `all`, sigue hasta tener el mejor camino a cada destino (o pasar de `bound`);
 * sin él, para en el primero.
 * @returns {{ goals: Array<{ cost: number, node: number, atStart?: boolean } | null>, via: Map<number, number> }}
 *   node -1: el trozo directo en el mismo tramo. via: nudo → tramo por el que se llega (-1/-2: desde a,
 *   por el inicio/final de su tramo), para reconstruir el camino con assemble.
 */
function explore(net, a, targets, bound, factors, all) {
  const f = (e) => factors?.[net.gauge[e]] ?? 1;
  const cost = (e, from, to) => Math.abs(to - from) * f(e);
  const goals = targets.map(() => null);
  const arrivals = new Map(); // nudo → destinos cuyo tramo empieza o acaba en él
  targets.forEach((t, i) => {
    const len = lengthOf(net, t.edge);
    if (t.edge === a.edge) goals[i] = { cost: cost(t.edge, a.m, t.m), node: -1 };
    for (const [node, extra, atStart] of [[net.na[t.edge], cost(t.edge, 0, t.m), true], [net.nb[t.edge], cost(t.edge, len, t.m), false]]) {
      if (!arrivals.has(node)) arrivals.set(node, []);
      arrivals.get(node).push({ i, extra, atStart });
    }
  });
  // Coste a partir del cual ya no se mejora nada: el mejor destino (o, con all, el peor) o bound.
  const limit = () => {
    let worst = 0;
    let best = Infinity;
    for (const g of goals) {
      worst = Math.max(worst, g ? g.cost : Infinity);
      best = Math.min(best, g ? g.cost : Infinity);
    }
    return Math.min(bound, all ? worst : best);
  };
  const lenA = lengthOf(net, a.edge);
  const dist = new Map();
  const via = new Map();
  const done = new Set();
  const queue = heap();
  const reach = (node, d, from) => {
    if (d <= limit() && d < (dist.get(node) ?? Infinity)) {
      dist.set(node, d);
      via.set(node, from);
      queue.push(d, node);
    }
  };
  reach(net.na[a.edge], cost(a.edge, a.m, 0), -1);
  reach(net.nb[a.edge], cost(a.edge, a.m, lenA), -2);
  while (queue.size) {
    const [d, node] = queue.pop();
    if (d >= limit()) break;
    if (done.has(node)) continue;
    done.add(node);
    for (const { i, extra, atStart } of arrivals.get(node) ?? []) {
      if (!goals[i] || d + extra < goals[i].cost) goals[i] = { cost: d + extra, node, atStart };
    }
    for (let k = net.adjOffsets[node]; k < net.adjOffsets[node + 1]; k++) {
      const e = net.adj[k];
      reach(net.na[e] === node ? net.nb[e] : net.na[e], d + lengthOf(net, e) * f(e), e);
    }
  }
  return { goals, via };
}

/** Puntos y longitud del camino de `a` a `target` que ha encontrado explore. */
function assemble(net, a, target, goal, via) {
  if (goal.node < 0) return { length: Math.abs(target.m - a.m), path: slice(net, a.edge, a.m, target.m) };
  // Tramos del camino, de atrás adelante, desde el nudo de entrada hasta el de salida del tramo de a.
  const edges = [];
  let node = goal.node;
  while (via.get(node) >= 0) {
    const e = via.get(node);
    edges.push(e);
    node = net.na[e] === node ? net.nb[e] : net.na[e];
  }
  const lenA = lengthOf(net, a.edge);
  const exitAtStart = via.get(node) === -1;
  const path = slice(net, a.edge, a.m, exitAtStart ? 0 : lenA);
  let length = exitAtStart ? a.m : lenA - a.m;
  for (const e of edges.reverse()) {
    const forward = net.na[e] === node;
    append(path, slice(net, e, forward ? 0 : lengthOf(net, e), forward ? lengthOf(net, e) : 0));
    length += lengthOf(net, e);
    node = forward ? net.nb[e] : net.na[e];
  }
  const lenT = lengthOf(net, target.edge);
  append(path, slice(net, target.edge, goal.atStart ? 0 : lenT, target.m));
  length += goal.atStart ? target.m : lenT - target.m;
  return { length, path };
}

/**
 * Puntos de la red junto a una estación (o una posición): en cada tramo a menos de `maxM`, su punto más
 * cercano; sólo los que están a menos de `spreadM` más que el más cercano de todos (el primero).
 * @returns {Array<{ edge: number, m: number, lon: number, lat: number, d: number }>}
 */
export function sitesNear(net, lon, lat, maxM = STOP_M, spreadM = STOP_SPREAD_M) {
  const byEdge = new Map();
  nearPieces(net.index, lon, lat, (g) => {
    const p = project(net, g, lon, lat);
    const e = net.lineOf[g];
    if (p.d <= maxM && !(byEdge.get(e)?.d <= p.d)) byEdge.set(e, { g, ...p });
  });
  const near = Math.min(...[...byEdge.values()].map((h) => h.d));
  return [...byEdge.values()].filter((h) => h.d <= near + spreadM).sort((x, y) => x.d - y.d).map((h) => siteAt(net, h.g, h.t, h.d));
}

/**
 * Lo que le queda a un tren hasta su destino, por la vía: desde su posición, pasando por cada parada que
 * le queda. En una estación con varias vías (Nuevos Ministerios: los túneles de Sol y de Recoletos), la
 * de cada parada se elige mirando el viaje entero, no sólo la parada siguiente: el camino de menor coste
 * total (programación dinámica sobre las vías de cada estación). Las paradas fuera de la red (otro país,
 * vía métrica) se saltan: el dibujo acaba en la última de la red. null si el tren no está en la red o
 * algún tramo entre paradas no tiene un camino razonable (LEG_DETOUR).
 * @param {RailNetwork|null} net
 * @param {[number, number]} at  posición del tren [lon, lat]
 * @param {Array<[number, number]>} stops  paradas que le quedan, en orden ([lon, lat])
 * @param {{ factors?: number[] }} [options]  factors: coste por ancho de vía (ver explore)
 * @returns {Array<[number, number]> | null}
 */
export function routeAhead(net, at, stops, { factors } = {}) {
  const start = net && at ? nearestOnRail(net, at[0], at[1], NEAR_M) : null;
  if (!start) return null;
  const layers = [{ point: [start.lon, start.lat], sites: [start] }]; // el tren y, por parada, las vías de la estación
  for (const [lon, lat] of stops ?? []) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const sites = sitesNear(net, lon, lat);
    if (sites.length) layers.push({ point: [lon, lat], sites });
  }
  if (layers.length < 2) return null;
  const capOf = (k) => LEG_DETOUR * meters(...layers[k - 1].point, ...layers[k].point) + LEG_EXTRA_M;
  const maxFactor = Math.max(1, ...(factors ?? []));
  let costs = [0]; // coste mínimo hasta cada vía de la capa anterior
  const back = []; // back[k - 1][j]: vía de la capa k - 1 desde la que se llega mejor a la vía j de la capa k
  for (let k = 1; k < layers.length; k++) {
    const next = layers[k].sites.map(() => Infinity);
    const from = layers[k].sites.map(() => -1);
    layers[k - 1].sites.forEach((u, i) => {
      if (!Number.isFinite(costs[i])) return;
      const { goals } = explore(net, u, layers[k].sites, capOf(k) * maxFactor, factors, true);
      goals.forEach((g, j) => {
        if (g && costs[i] + g.cost < next[j]) {
          next[j] = costs[i] + g.cost;
          from[j] = i;
        }
      });
    });
    if (!next.some(Number.isFinite)) return null;
    costs = next;
    back.push(from);
  }
  const chosen = [];
  chosen[layers.length - 1] = costs.indexOf(Math.min(...costs));
  for (let k = layers.length - 1; k >= 1; k--) chosen[k - 1] = back[k - 1][chosen[k]];
  const path = [layers[0].point];
  for (let k = 1; k < layers.length; k++) {
    const leg = route(net, layers[k - 1].sites[chosen[k - 1]], [layers[k].sites[chosen[k]]], capOf(k), factors);
    if (!leg) return null; // el coste no mide la longitud: más largo que el tope
    append(path, leg.path);
  }
  return path.length > 1 ? path : null;
}

/** Añade puntos a una línea sin repetir el último ni dejar pasos más largos que MAX_STEP_M. */
function append(line, points) {
  for (const p of points) {
    const last = line.at(-1);
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    if (last) {
      const steps = Math.ceil(meters(last[0], last[1], p[0], p[1]) / MAX_STEP_M);
      for (let s = 1; s < steps; s++) line.push([last[0] + ((p[0] - last[0]) * s) / steps, last[1] + ((p[1] - last[1]) * s) / steps]);
    }
    line.push(p);
  }
}

/**
 * Recorrido de un tren pegado a la vía. Cada posición va a una de las vías que tiene cerca y, entre dos
 * posiciones seguidas, se dibuja el camino por la vía si no es mucho más largo que la recta (o, con un
 * hueco de minutos, si le ha dado tiempo: LOOP_DETOUR); si no, la recta. La vía de cada posición se elige
 * con todo el recorrido a la vista (programación dinámica, como Viterbi): el menor coste total de
 * caminos más distancias de las posiciones a su vía. Así un tren no salta a la vía paralela de una
 * estación ni se queda en ella. Donde faltan datos más de GAP_KM, el recorrido se parte.
 * @param {RailNetwork|null} net
 * @param {Array<{ lon: number, lat: number, t?: number }>} track  posiciones en orden (t: ms)
 * @param {{ nearM?: number, factors?: number[] }} [options]  factors: coste por ancho de vía (ver explore)
 * @returns {Array<Array<[number, number]>>} tramos del recorrido ([lon, lat])
 */
export function matchToRail(net, track, { nearM = NEAR_M, factors } = {}) {
  const groups = [];
  let group = [];
  for (const p of track ?? []) {
    if (!Number.isFinite(p?.lon) || !Number.isFinite(p?.lat)) continue;
    const prev = group.at(-1);
    if (prev && meters(prev.lon, prev.lat, p.lon, p.lat) > GAP_KM * 1000) {
      groups.push(group);
      group = [];
    }
    group.push(p);
  }
  if (group.length) groups.push(group);
  return groups.map((positions) => matchGroup(net, positions, nearM, factors));
}

/** Un trozo de recorrido sin huecos de más de GAP_KM (ver matchToRail). */
function matchGroup(net, positions, nearM, factors) {
  const maxFactor = Math.max(1, ...(factors ?? []));
  // Por posición, sus vías cercanas; fuera de la red, ninguna (se queda donde está).
  const layers = positions.map((p) => (net ? sitesNear(net, p.lon, p.lat, nearM, SNAP_SLACK_M) : []));
  const capOf = (k, a, b) => {
    const straight = meters(a.lon, a.lat, b.lon, b.lat);
    const ms = positions[k].t - positions[k - 1].t;
    const loop = ms >= LOOP_GAP_MS ? Math.min(LOOP_DETOUR * straight + DETOUR_EXTRA_M, (LOOP_SPEED * ms) / 1000) : 0;
    return Math.max(DETOUR * straight + DETOUR_EXTRA_M, loop);
  };
  // costs[j]: menor coste hasta la vía j de la posición actual; steps[k][j]: { from, leg } para volver atrás.
  let costs = layers[0].length ? layers[0].map((s) => SNAP_WEIGHT * s.d) : [0];
  const steps = [null];
  for (let k = 1; k < positions.length; k++) {
    const here = layers[k].length ? layers[k] : [null];
    const there = layers[k - 1].length ? layers[k - 1] : [null];
    const next = here.map(() => Infinity);
    const back = here.map(() => null);
    there.forEach((u, i) => {
      if (!Number.isFinite(costs[i])) return;
      const found = u && layers[k].length
        ? explore(net, u, layers[k], capOf(k, u, layers[k][0]) * maxFactor, factors, true)
        : null;
      here.forEach((v, j) => {
        const a = u ?? positions[k - 1];
        const b = v ?? positions[k];
        const cap = capOf(k, a, b);
        const goal = found?.goals[j];
        // Por la vía si cabe en el tope; si no, la recta, que cuesta más que cualquier camino que quepa.
        const byRail = goal && goal.cost <= cap * maxFactor;
        const step = byRail ? goal.cost : (u && v ? cap * maxFactor + 1 : meters(a.lon, a.lat, b.lon, b.lat));
        const total = costs[i] + step + (v ? SNAP_WEIGHT * v.d : 0);
        if (total < next[j]) {
          next[j] = total;
          back[j] = { from: i, rail: byRail ? { goal, via: found.via } : null };
        }
      });
    });
    costs = next;
    steps.push(back);
  }
  // Vía elegida para cada posición, de atrás adelante, y la línea por la vía (o recta) entre ellas.
  const chosen = [];
  chosen[positions.length - 1] = costs.indexOf(Math.min(...costs));
  for (let k = positions.length - 1; k >= 1; k--) chosen[k - 1] = steps[k][chosen[k]].from;
  const at = (k) => layers[k][chosen[k]] ?? null;
  const first = at(0) ?? positions[0];
  const line = [[first.lon, first.lat]];
  for (let k = 1; k < positions.length; k++) {
    const u = at(k - 1);
    const v = at(k);
    const { rail } = steps[k][chosen[k]];
    if (rail) {
      const { length, path } = assemble(net, u, v, rail.goal, rail.via);
      if (length <= capOf(k, u, v)) {
        append(line, path);
        continue;
      }
    }
    const b = v ?? positions[k];
    append(line, [[b.lon, b.lat]]);
  }
  return line;
}
