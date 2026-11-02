// Lo que se ve en la ficha de una estación, a partir de lo que ya llega en directo: los trenes
// parados en ella y los que van hacia ella (con vía, hora y retraso), los avisos de Renfe de la
// estación, sus líneas y las conexiones con metro y tranvía. Funciones puras: no piden nada al servidor.

// Los trenes dicen su estación por su nombre: los de Renfe, el de su catálogo; los de metro, tranvía
// y las demás redes, el del GTFS de su operador (del que sale también la estación). Se comparan sin
// tildes, mayúsculas ni espacios dobles («PINAR DE CHAMARTIN» del Metro Ligero, «Terrassa  Estació
// del nord» de FGC) y además tienen que estar cerca, por si dos estaciones se llaman igual.
const STOPPED_KM = 3;
const ARRIVING_KM = 80;
const NOTICE_KM = 0.3;  // los avisos de Renfe vienen con las coordenadas de su estación
const LINE_KM = 0.15;   // una línea de tren pasa por la estación si su trazado está a menos de esto
const LINK_KM = 0.3;    // metro y tranvía a menos de esto: se puede hacer transbordo a pie
const MAX_ARRIVING = 10;

const plain = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const km = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * 110.54, (aLon - bLon) * 111.32 * Math.cos((aLat * Math.PI) / 180));

/**
 * @param {{ name: string, lat: number, lon: number, network?: string, lines?: object[] }} station
 *   network y lines: las estaciones de otras redes (su red y las líneas que paran en ella).
 * @param {{ vehicles: object[], events: object[], lines: object[] }} live
 */
export function stationBoard(station, { vehicles, events, lines }) {
  const near = (o, maxKm) => Number.isFinite(o.lat) && Number.isFinite(o.lon) && km(station.lat, station.lon, o.lat, o.lon) <= maxKm;
  const name = plain(station.name);
  const stopped = vehicles.filter((v) => v.stopped && plain(v.current) === name && near(v, STOPPED_KM));
  const arriving = vehicles
    .filter((v) => !v.stopped && plain(v.next) === name && near(v, ARRIVING_KM))
    .sort((a, b) => etaKey(a).localeCompare(etaKey(b)))
    .slice(0, MAX_ARRIVING);
  const around = linesNear(station, lines);
  if (station.network) {
    // Metro, tranvía y demás redes: sus líneas son las que paran en ella (o, mientras llega su ficha,
    // las de su red que pasan por ahí); todo lo demás que está a un paseo, Cercanías incluido, son
    // conexiones. Los avisos de Renfe son de sus estaciones, no de estas.
    const own = (l) => l.network === station.network;
    return {
      stopped, arriving, notices: [],
      lines: station.lines?.map((l) => ({ ...l, network: station.network })) ?? around.filter((l) => own(l) && l.km <= LINE_KM),
      connections: around.filter((l) => !own(l)),
    };
  }
  const notices = events.filter((e) => e.category === 'ferroviario' && near(e, NOTICE_KM));
  return {
    stopped, arriving, notices,
    lines: around.filter((l) => !URBAN.has(l.mode) && l.km <= LINE_KM),
    connections: around.filter((l) => URBAN.has(l.mode)),
  };
}

// La hora de llegada (local, ISO) o, en las posiciones estimadas, los minutos que faltan.
function etaKey(v) {
  if (v.nextEta) return v.nextEta;
  if (Number.isFinite(v.nextInMinutes)) return `~${String(v.nextInMinutes).padStart(4, '0')}`;
  return '~~';
}

const URBAN = new Set(['metro', 'tranvia']);

/** Líneas cuyo trazado pasa a menos de LINK_KM de la estación, una vez cada una y con su distancia. */
function linesNear(station, lines) {
  const found = new Map();
  for (const f of lines) {
    const { line, network, color, mode } = f.properties ?? {};
    const key = `${network}|${line}`;
    if (!line || f.geometry?.type !== 'LineString') continue;
    const d = distanceToLine(station, f.geometry.coordinates);
    if (d <= LINK_KM && d < (found.get(key)?.km ?? Infinity)) found.set(key, { line, network, color, mode, km: d });
  }
  return [...found.values()].sort((a, b) => a.line.localeCompare(b.line, 'es', { numeric: true }));
}

function distanceToLine({ lat, lon }, coords) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  const ky = 110.54;
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = [(coords[i - 1][0] - lon) * kx, (coords[i - 1][1] - lat) * ky];
    const [bx, by] = [(coords[i][0] - lon) * kx, (coords[i][1] - lat) * ky];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
