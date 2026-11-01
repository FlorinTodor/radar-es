// Recorrido de un tren pegado a la vía de la red ferroviaria general (los tramos de vía en servicio).
// Las posiciones de los trenes de Larga y Media Distancia de Renfe caen sobre esa red, pero llegan cada
// 20 s y a veces pasan minutos sin llegar (túneles, zonas sin cobertura): unidas con rectas, la línea
// corta por el mar o el monte. Aquí cada posición se lleva al punto más cercano de la red y entre dos
// posiciones seguidas se dibuja el camino más corto por la vía que las une, pasando de un tramo a otro
// por las estaciones y bifurcaciones.
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
// Entre dos posiciones, el camino por la vía no puede ser mucho más largo que la recta: si lo es, la
// vía que las une no está en la red (o una de las dos no es buena) y se dibuja la recta, como antes.
export const DETOUR = 3;
export const DETOUR_EXTRA_M = 1000;
// Más de esto entre dos posiciones seguidas es un rato largo sin datos: no se unen (como TRACK_GAP_KM
// en public/js/map.js, que parte el recorrido en el mismo sitio).
export const GAP_KM = 30;
// Ningún paso de la línea dibujada puede pasar de esto: el mapa la partiría como si faltaran datos.
const MAX_STEP_M = 10_000;

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
 * @param {{ mergeM?: number }} [options]
 * @returns {RailNetwork}
 */
export function buildRailNetwork(lines, { mergeM = MERGE_M } = {}) {
  const clean = [];
  for (const line of lines ?? []) {
    const pts = [];
    for (const p of line ?? []) {
      const lon = p?.[0];
      const lat = p?.[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const last = pts.at(-1);
      if (last && last[0] === lon && last[1] === lat) continue;
      pts.push([lon, lat]);
    }
    if (pts.length > 1) clean.push(pts);
  }
  const net = pack(splitAtJunctions(clean, mergeM));
  linkNodes(net, mergeM);
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
  let k = 0;
  lines.forEach((l, i) => {
    first[i] = k;
    for (let j = 0; j < l.length; j++, k++) {
      lon[k] = l[j][0];
      lat[k] = l[j][1];
      lineOf[k] = i;
      cum[k] = j ? cum[k - 1] + meters(lon[k - 1], lat[k - 1], lon[k], lat[k]) : 0;
    }
  });
  first[lines.length] = n;
  const net = { lon, lat, cum, lineOf, first, edges: lines.length, points: n };
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
        if (line === i) return;
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
    let piece = [l[0]];
    let c = 0;
    for (let j = 1; j < l.length; j++) {
      const from = net.cum[base + j - 1];
      const to = net.cum[base + j];
      while (c < ms.length && ms[c] < to) {
        const t = to > from ? (ms[c] - from) / (to - from) : 0;
        const p = [l[j - 1][0] + t * (l[j][0] - l[j - 1][0]), l[j - 1][1] + t * (l[j][1] - l[j - 1][1])];
        piece.push(p);
        out.push(piece);
        piece = [p];
        c++;
      }
      piece.push(l[j]);
    }
    out.push(piece);
  });
  return out;
}

/**
 * Nudos del grafo: los extremos de tramo a menos de `mergeM` se juntan en uno (unión-búsqueda con una
 * rejilla de extremos). Deja en la red los nudos de cada tramo (na, nb) y, por nudo, sus tramos (adj).
 */
function linkNodes(net, mergeM) {
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
          if (meters(net.lon[v], net.lat[v], net.lon[w], net.lat[w]) <= mergeM) parent[find(i)] = find(j);
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
  net.bytes = [net.lon, net.lat, net.cum, net.lineOf, net.first, net.na, net.nb, net.adjOffsets, net.adj,
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
 * Camino más corto por la vía entre dos sitios de la red (de nearestOnRail), si no pasa de `capM`
 * metros: Dijkstra entre los nudos, empezando por los dos extremos del tramo de `a` y acabando al
 * entrar por un extremo en el tramo de `b`. Si los dos están en el mismo tramo, vale también el trozo
 * de tramo entre ellos.
 * @returns {{ length: number, path: Array<[number, number]> } | null}
 */
export function railRoute(net, a, b, capM) {
  const lenA = lengthOf(net, a.edge);
  const lenB = lengthOf(net, b.edge);
  let best = a.edge === b.edge ? Math.abs(b.m - a.m) : Infinity;
  let entry = -1; // nudo por el que se entra en el tramo de b (-1: el trozo directo, mismo tramo)
  let entryAtStart = true; // se entra en el tramo de b por su inicio (o por su final)
  const dist = new Map();
  const via = new Map(); // nudo → tramo por el que se llega; -1/-2: desde a, por el inicio/final de su tramo
  const done = new Set();
  const queue = heap();
  const reach = (node, d, from) => {
    if (d <= capM && d < best && d < (dist.get(node) ?? Infinity)) {
      dist.set(node, d);
      via.set(node, from);
      queue.push(d, node);
    }
  };
  reach(net.na[a.edge], a.m, -1);
  reach(net.nb[a.edge], lenA - a.m, -2);
  while (queue.size) {
    const [d, node] = queue.pop();
    if (d >= best) break;
    if (done.has(node)) continue;
    done.add(node);
    if (node === net.na[b.edge] && d + b.m < best) {
      best = d + b.m;
      entry = node;
      entryAtStart = true;
    }
    if (node === net.nb[b.edge] && d + lenB - b.m < best) {
      best = d + lenB - b.m;
      entry = node;
      entryAtStart = false;
    }
    for (let k = net.adjOffsets[node]; k < net.adjOffsets[node + 1]; k++) {
      const e = net.adj[k];
      reach(net.na[e] === node ? net.nb[e] : net.na[e], d + lengthOf(net, e), e);
    }
  }
  if (!(best <= capM)) return null;
  if (entry < 0) return { length: best, path: slice(net, a.edge, a.m, b.m) };

  // Tramos del camino, de atrás adelante, desde el nudo de entrada hasta el de salida del tramo de a.
  const edges = [];
  let node = entry;
  while (via.get(node) >= 0) {
    const e = via.get(node);
    edges.push(e);
    node = net.na[e] === node ? net.nb[e] : net.na[e];
  }
  const path = slice(net, a.edge, a.m, via.get(node) === -1 ? 0 : lenA);
  for (const e of edges.reverse()) {
    const forward = net.na[e] === node;
    append(path, slice(net, e, forward ? 0 : lengthOf(net, e), forward ? lengthOf(net, e) : 0));
    node = forward ? net.nb[e] : net.na[e];
  }
  append(path, slice(net, b.edge, entryAtStart ? 0 : lenB, b.m));
  return { length: best, path };
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
 * Recorrido de un tren pegado a la vía: cada posición, a su punto de la red (si está cerca), y entre dos
 * posiciones seguidas el camino por la vía si no es mucho más largo que la recta; si no, la recta.
 * Donde faltan datos más de GAP_KM, el recorrido se parte.
 * @param {RailNetwork|null} net
 * @param {Array<{ lon: number, lat: number }>} track  posiciones en orden
 * @param {{ nearM?: number }} [options]
 * @returns {Array<Array<[number, number]>>} tramos del recorrido ([lon, lat])
 */
export function matchToRail(net, track, { nearM = NEAR_M } = {}) {
  const parts = [];
  let part = [];
  let prev = null; // posición anterior
  let prevSite = null; // su punto en la red, si lo tenía
  for (const p of track ?? []) {
    if (!Number.isFinite(p?.lon) || !Number.isFinite(p?.lat)) continue;
    if (prev && meters(prev.lon, prev.lat, p.lon, p.lat) > GAP_KM * 1000) {
      if (part.length) parts.push(part);
      part = [];
      prevSite = null;
    }
    const site = net ? nearestOnRail(net, p.lon, p.lat, nearM) : null;
    const here = site ? [site.lon, site.lat] : [p.lon, p.lat];
    const route = prevSite && site
      ? railRoute(net, prevSite, site, DETOUR * meters(prevSite.lon, prevSite.lat, site.lon, site.lat) + DETOUR_EXTRA_M)
      : null;
    append(part, route ? route.path : [here]);
    prev = p;
    prevSite = site;
  }
  if (part.length) parts.push(part);
  return parts;
}
