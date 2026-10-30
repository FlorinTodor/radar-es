// Las reglas del dominio son funciones puras: se prueban sin red, sin servidor y sin reloj real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, stoppedOutsideStation } from '../../server/domain/alerts/rules.js';
import { reconcileAlerts } from '../../server/domain/alerts/lifecycle.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { recordPositions } from '../../server/domain/tracking.js';

const MIN = 60_000;
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

test('el ciclo de vida conserva "since", detecta escaladas y resuelve lo que desaparece', () => {
  const active = new Map();
  const first = reconcileAlerts(active, [{ id: 'x', severity: 'media' }, { id: 'y', severity: 'baja' }], T0);
  assert.equal(first.opened.length, 2);

  const second = reconcileAlerts(active, [{ id: 'x', severity: 'alta' }], T0 + MIN);
  assert.equal(second.escalated[0].id, 'x');
  assert.equal(active.get('x').since, T0);
  assert.deepEqual(second.resolved.map((a) => a.id), ['y']);
});
