// Las reglas del dominio son funciones puras: se prueban sin red, sin servidor y sin reloj real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earthquakesNearTrains, evaluateRules, feedHealth, fleetDrop, largeDelays, stoppedOutsideStation } from '../../server/domain/alerts/rules.js';
import { reconcileAlerts } from '../../server/domain/alerts/lifecycle.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { recordPositions } from '../../server/domain/tracking.js';
import { distanceKm } from '../../server/domain/geo.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 0, 18, 18, 0);

const train = (id, lat, lon, extra = {}) => ({
  id, mode: 'av', operator: 'Renfe', service: 'AVE', line: 'AVE', label: id, lat, lon, delay: 0,
  origin: 'Madrid', destination: 'Sevilla', ...extra,
});

const farFromStations = () => ({ station: { name: 'Adamuz' }, km: 4.2 });
const atStation = () => ({ station: { name: 'Córdoba' }, km: 0.2 });

function ctx(overrides) {
  return {
    now: T0, vehicles: [], tracks: new Map(), events: [], metrics: {}, health: [],
    kpis: { vehicles: 0 }, kpiHistory: [], nearestStation: farFromStations, thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

/** Simula que los trenes se reportan en la misma posición durante `minutes`. */
function stationary(vehicles, minutes) {
  const tracks = new Map();
  for (let m = 0; m <= minutes; m += 1) recordPositions(tracks, vehicles, T0 - (minutes - m) * MIN);
  return tracks;
}

test('un tren parado en plena vía más de 8 min genera alerta', () => {
  const v = train('a', 38.0, -4.5);
  const alerts = stoppedOutsideStation(ctx({ vehicles: [v], tracks: stationary([v], 12) }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'detenido');
  assert.equal(alerts[0].severity, 'media');
});

test('un tren parado en una estación no genera alerta', () => {
  const v = train('a', 38.0, -4.5);
  const alerts = stoppedOutsideStation(ctx({ vehicles: [v], tracks: stationary([v], 30), nearestStation: atStation }));
  assert.equal(alerts.length, 0);
});

test('dos trenes detenidos cerca entre sí se agrupan en una alerta de posible bloqueo', () => {
  const vs = [train('a', 38.0, -4.5), train('b', 38.01, -4.51)];
  const alerts = evaluateRules(ctx({ vehicles: vs, tracks: stationary(vs, 15) }));
  const bloqueo = alerts.find((a) => a.type === 'bloqueo');
  assert.ok(bloqueo, 'debería existir una alerta de bloqueo');
  assert.equal(bloqueo.severity, 'muy alta');
  assert.deepEqual(bloqueo.vehicleIds.sort(), ['a', 'b']);
});

test('un GPS congelado con hora conocida se marca como "sin GPS", no como detenido', () => {
  const v = train('a', 38.0, -4.5, { fixTime: T0 - 30 * MIN });
  const alerts = stoppedOutsideStation(ctx({ vehicles: [v], tracks: stationary([v], 30) }));
  assert.deepEqual(alerts.map((a) => a.type), ['sin-gps']);
});

test('un salto brusco de retraso genera alerta', () => {
  const before = train('a', 38.0, -4.5, { delay: 2 });
  const after = train('a', 38.05, -4.4, { delay: 25 });
  const tracks = new Map();
  recordPositions(tracks, [before], T0 - 10 * MIN);
  recordPositions(tracks, [after], T0);
  const alerts = evaluateRules(ctx({ vehicles: [after], tracks }));
  assert.ok(alerts.some((a) => a.type === 'salto-retraso'));
});

test('caída de la demanda eléctrica del 30 % es crítica', () => {
  const alerts = evaluateRules(ctx({ metrics: { ree: { demandMW: 18_000, forecastMW: 26_000, deviation: -0.31 } } }));
  assert.equal(alerts.find((a) => a.type === 'red-electrica')?.severity, 'muy alta');
});

test('aviso rojo con polígono cuenta los trenes que hay dentro', () => {
  const zone = { type: 'Polygon', coordinates: [[[-1, 39], [0, 39], [0, 40], [-1, 40], [-1, 39]]] };
  const events = [{ id: 'dana', category: 'meteo', level: 'rojo', title: 'Aviso rojo por lluvias · Litoral sur de Valencia', geometry: zone, start: T0 - MIN }];
  const vehicles = [train('dentro', 39.5, -0.5), train('fuera', 41, -3)];
  const [alert] = evaluateRules(ctx({ events, vehicles })).filter((a) => a.type === 'meteo');
  assert.equal(alert.severity, 'muy alta');
  assert.deepEqual(alert.vehicleIds, ['dentro']);
  assert.deepEqual(alert.eventIds, ['dana']);
  assert.match(alert.title, /1 trenes dentro/);
});

test('foco de incendio cerca de un tren genera alerta; lejos, no', () => {
  const fire = (id, lat, lon) => ({ id, category: 'incendio', lat, lon, frp: 12, start: T0 - 60 * MIN });
  const vehicles = [train('a', 38.0, -4.5)];
  const near = evaluateRules(ctx({ vehicles, events: [fire('f1', 38.01, -4.5)] })).filter((a) => a.type === 'incendio');
  const far = evaluateRules(ctx({ vehicles, events: [fire('f2', 39.0, -4.5)] })).filter((a) => a.type === 'incendio');
  assert.equal(near.length, 1);
  assert.equal(far.length, 0);
});

test('GDACS: sólo las alertas naranja o roja generan alerta', () => {
  const ev = (id, level) => ({ id, category: 'catastrofe', level, title: id, description: '', lat: 36, lon: -4 });
  const alerts = evaluateRules(ctx({ events: [ev('verde', 'verde'), ev('naranja', 'naranja')] })).filter((a) => a.type === 'catastrofe');
  assert.deepEqual(alerts.map((a) => a.severity), ['alta']);
});

test('el ciclo de vida conserva "since", detecta escaladas y resuelve lo que desaparece', () => {
  const active = new Map();
  const first = reconcileAlerts(active, [{ id: 'x', severity: 'media' }, { id: 'y', severity: 'baja' }], T0);
  assert.equal(first.opened.length, 2);

  const second = reconcileAlerts(active, [{ id: 'x', severity: 'alta' }], T0 + MIN);
  assert.equal(second.escalated[0].id, 'x');
  assert.equal(active.get('x').since, T0);
  assert.deepEqual(second.resolved.map((a) => a.id), ['y']);
});

// ---------- Retrasos grandes: 45 min (media) y 90 min (alta) ----------

test('retrasos: alerta desde 45 min, alta desde 90, y nada por debajo ni sin dato', () => {
  const vehicles = [
    train('d44', 38, -4, { delay: 44 }), train('d45', 38, -4, { delay: 45 }), train('d89', 38, -4, { delay: 89 }),
    train('d90', 38, -4, { delay: 90 }), train('adelantado', 38, -4, { delay: -3 }),
    train('sin-dato', 38, -4, { delay: null }), train('sin-campo', 38, -4, { delay: undefined }),
  ];
  const alerts = largeDelays(ctx({ vehicles }));
  assert.deepEqual(alerts.map((a) => [a.vehicleId, a.severity]), [['d45', 'media'], ['d89', 'media'], ['d90', 'alta']]);
  assert.equal(alerts[0].id, 'retraso:d45');
  assert.equal(alerts[0].type, 'retraso');
});

test('retrasos: la descripción da la próxima parada o, si no hay, dónde está', () => {
  const [next, current, none] = largeDelays(ctx({
    vehicles: [
      train('a', 38, -4, { delay: 60, next: 'Córdoba', current: 'Villanueva' }),
      train('b', 38, -4, { delay: 60, current: 'Villanueva' }),
      train('c', 38, -4, { delay: 60, origin: undefined, destination: undefined }),
    ],
  }));
  assert.equal(next.description, 'Madrid → Sevilla. Próxima parada: Córdoba.');
  assert.equal(current.description, 'Madrid → Sevilla. En Villanueva.');
  assert.equal(none.description, '? → ?.');
});

test('retrasos: sin vehículos no hay alertas', () => {
  assert.deepEqual(largeDelays(ctx({ vehicles: [] })), []);
});

// ---------- Sismos: M ≥ 3,5 en las últimas 3 h; radio 25 km por cada grado por encima de 2 ----------

const KM_PER_DEG_LAT = (6371 * Math.PI) / 180;
const quake = (magnitude, extra = {}) => ({
  id: `q${magnitude}`, category: 'sismo', magnitude, lat: 37.5, lon: -3.5, start: T0 - 10 * MIN, title: `Terremoto M${magnitude}`, ...extra,
});
/** Tren a `km` kilómetros al norte del epicentro. */
const trainNorthOf = (id, e, km) => train(id, e.lat + km / KM_PER_DEG_LAT, e.lon);

test('sismos: el umbral de magnitud es 3,5 y una magnitud desconocida no cuenta', () => {
  const events = [quake(3.4), quake(3.5), quake(undefined, { id: 'sin-magnitud' }), quake(null, { id: 'nula' })];
  assert.deepEqual(earthquakesNearTrains(ctx({ events })).map((a) => a.id), ['sismo:q3.5']);
});

test('sismos: sólo los de las últimas 3 h (el límite exacto cuenta) y con hora conocida', () => {
  const events = [
    quake(4, { id: 'justo', start: T0 - 3 * HOUR }),
    quake(4, { id: 'pasado', start: T0 - 3 * HOUR - 1 }),
    quake(4, { id: 'sin-hora', start: null }),
  ];
  assert.deepEqual(earthquakesNearTrains(ctx({ events })).map((a) => a.id), ['sismo:justo']);
});

test('sismos: otras categorías no generan alerta aunque tengan magnitud', () => {
  assert.deepEqual(earthquakesNearTrains(ctx({ events: [quake(5, { category: 'meteo' })] })), []);
});

test('sismos: cuenta los trenes dentro del radio (M3,5 → 37,5 km) y no los de fuera', () => {
  const e = quake(3.5);
  const dentro = trainNorthOf('dentro', e, 37);
  const fuera = trainNorthOf('fuera', e, 38);
  assert.ok(Math.abs(distanceKm(e.lat, e.lon, dentro.lat, dentro.lon) - 37) < 0.01, 'el tren está donde dice el test');
  const [alert] = earthquakesNearTrains(ctx({ events: [e], vehicles: [dentro, fuera] }));
  assert.deepEqual(alert.vehicleIds, ['dentro']);
  assert.equal(alert.severity, 'alta');
  assert.equal(alert.description, '1 trenes en un radio de 38 km.');
  assert.deepEqual(alert.eventIds, [e.id]);
});

test('sismos: sin trenes cerca es «media», y desde M4,5 «muy alta» aunque no haya trenes', () => {
  const [lejos] = earthquakesNearTrains(ctx({ events: [quake(4.4)], vehicles: [] }));
  assert.equal(lejos.severity, 'media');
  assert.equal(lejos.description, 'Sin trenes en un radio de 60 km.');
  assert.deepEqual(lejos.vehicleIds, []);
  assert.equal(earthquakesNearTrains(ctx({ events: [quake(4.5)], vehicles: [] }))[0].severity, 'muy alta');
});

// ---------- Desaparición de trenes: < 60 % de los que había hace 8-12 min ----------

const sample = (minutesAgo, vehicles) => ({ t: T0 - minutesAgo * MIN, vehicles });

test('flota: alerta si quedan menos del 60 % de los trenes de hace ~10 min', () => {
  const kpiHistory = [sample(10, 100)];
  const [alert] = fleetDrop(ctx({ kpiHistory, kpis: { vehicles: 59 } }));
  assert.equal(alert.type, 'flota');
  assert.equal(alert.severity, 'alta');
  assert.equal(alert.title, 'Desaparecen trenes del mapa: 59 frente a 100 hace 10 min');
  assert.deepEqual(fleetDrop(ctx({ kpiHistory, kpis: { vehicles: 60 } })), [], 'justo el 60 % no avisa');
});

test('flota: con 50 trenes o menos de referencia no se avisa (de madrugada hay pocos)', () => {
  assert.deepEqual(fleetDrop(ctx({ kpiHistory: [sample(10, 50)], kpis: { vehicles: 0 } })), []);
  assert.equal(fleetDrop(ctx({ kpiHistory: [sample(10, 51)], kpis: { vehicles: 30 } })).length, 1);
});

test('flota: la referencia tiene que ser de hace 8 a 12 min (ambos incluidos)', () => {
  const drop = (kpiHistory) => fleetDrop(ctx({ kpiHistory, kpis: { vehicles: 10 } })).length;
  assert.equal(drop([sample(7, 100), sample(13, 100)]), 0, 'muestras fuera de la ventana');
  assert.equal(drop([sample(8, 100)]), 1);
  assert.equal(drop([sample(12, 100)]), 1);
  assert.equal(drop([]), 0, 'sin historial (recién arrancado)');
});

test('flota: sin vehículos ahora ni antes no hay alerta; si antes había, sí', () => {
  assert.deepEqual(fleetDrop(ctx({ kpiHistory: [sample(10, 0)], kpis: { vehicles: 0 } })), []);
  assert.match(fleetDrop(ctx({ kpiHistory: [sample(10, 120)], kpis: { vehicles: 0 } }))[0].title, /0 frente a 120/);
});

// ---------- Salud de las fuentes ----------

const feed = (extra = {}) => ({
  id: 'renfe', name: 'Renfe', kind: 'vehicles', enabled: true, ok: true, lastOk: T0 - 20_000, interval: 20_000,
  sourceTime: T0 - 30_000, error: null, ...extra,
});

test('fuentes: caída es fallar y llevar más de 3 intervalos sin una lectura buena', () => {
  const down = (extra) => feedHealth(ctx({ health: [feed({ ok: false, error: 'HTTP 503', ...extra })] }));
  assert.deepEqual(down({ lastOk: T0 - 60_000 }), [], 'justo 3 intervalos: todavía no');
  const [alert] = down({ lastOk: T0 - 60_001 });
  assert.equal(alert.id, 'fuente:renfe');
  assert.equal(alert.title, 'Renfe: sin respuesta');
  assert.equal(alert.description, 'Último error: HTTP 503');
  assert.equal(down({ lastOk: null }).length, 1, 'nunca ha respondido');
});

test('fuentes: posiciones congeladas más de 10 min, sólo en fuentes de vehículos', () => {
  const stale = (extra) => feedHealth(ctx({ health: [feed(extra)] }));
  assert.deepEqual(stale({ sourceTime: T0 - 10 * MIN }), [], 'justo 10 min: todavía no');
  const [alert] = stale({ sourceTime: T0 - 25 * MIN });
  assert.equal(alert.title, 'Renfe: datos sin actualizar');
  assert.equal(alert.description, 'La fuente no se actualiza desde hace 25 min.');
  assert.deepEqual(stale({ kind: 'events', sourceTime: T0 - 25 * MIN }), [], 'las incidencias pueden no cambiar en horas');
  assert.deepEqual(stale({ sourceTime: null }), [], 'fuente sin hora propia');
});

test('fuentes: gravedad media si son vehículos y baja si no; las desactivadas no avisan', () => {
  const health = [
    feed({ id: 'v', ok: false, lastOk: null }),
    feed({ id: 'e', kind: 'events', ok: false, lastOk: null }),
    feed({ id: 'off', enabled: false, ok: false, lastOk: null }),
  ];
  assert.deepEqual(feedHealth(ctx({ health })).map((a) => [a.id, a.severity]), [['fuente:v', 'media'], ['fuente:e', 'baja']]);
});

test('fuentes: si está caída y además congelada, se dice que no responde', () => {
  const [alert] = feedHealth(ctx({ health: [feed({ ok: false, lastOk: null, sourceTime: T0 - HOUR, error: 'timeout' })] }));
  assert.equal(alert.title, 'Renfe: sin respuesta');
});

test('fuentes: todo en orden, sin alertas', () => {
  assert.deepEqual(feedHealth(ctx({ health: [feed(), feed({ id: 'aemet', kind: 'events', sourceTime: T0 - 5 * HOUR })] })), []);
});
