// Apagón de un sistema eléctrico aislado (isla, Ceuta, Melilla) a partir de su demanda real frente a
// la programada (e·sios), con dos datos seguidos. Regla pura: sin red ni reloj.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_METRICS, evaluateRules, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';

const NOW = Date.parse('2026-11-02T06:50:00Z');
const MIN = 60_000;
const ctx = (systems) => ({
  now: NOW, vehicles: [], tracks: new Map(), events: [], health: [], kpis: { vehicles: 0 }, kpiHistory: [],
  nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS,
  metrics: { [GRID_METRICS.aislados]: { systems } },
});
// Por omisión, el dato anterior (5 min antes) es igual que el último: dos datos seguidos.
const sys = (name, real, programmed, minutesAgo = 10, id = 'la-palma', recentMax = real, extra = {}) => ({
  id, name, real, programmed, recentMax, readMax: recentMax, at: NOW - minutesAgo * MIN,
  previous: { real, at: NOW - (minutesAgo + 5) * MIN }, ...extra,
});

test('demanda a cero en La Palma → posible apagón total, en la isla y citando a Red Eléctrica', () => {
  const [alert] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 21)]));
  assert.equal(alert.id, 'red-aislada:la-palma');
  assert.equal(alert.severity, 'muy alta');
  assert.equal(alert.title, 'Posible apagón total en La Palma: demanda a 0 MW');
  assert.match(alert.description, /^Real 0 MW a las .+ \(hora peninsular\) frente a 21 MW programados\. Estimación de Radar España/);
  assert.equal(alert.credit, 'Fuente: Red Eléctrica');
  assert.deepEqual([alert.lat, alert.lon], [28.68, -17.86]);
});

test('reposición a medias → caída fuerte (alta); normal o casi normal → nada', () => {
  const [half] = isolatedGridBlackouts(ctx([sys('La Palma', 7.3, 21)]));
  assert.equal(half.severity, 'alta');
  assert.equal(half.title, 'Demanda eléctrica de La Palma un 65 % por debajo de lo esperado');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('Tenerife', 380.2, 383, 10, 'tenerife'), sys('Ceuta', 16, 30, 10, 'ceuta')])).map((a) => a.id), [],
    'Ceuta un 47 % por debajo no llega a la mitad: no avisa');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('Ceuta', 14.9, 30, 10, 'ceuta')])).map((a) => a.severity), ['alta']);
});

test('sin datos fiables no hay alerta: dato viejo, sin programada o sistema minúsculo', () => {
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 70)])), [], 'dato de hace 70 min');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, null)])), [], 'sin programada ni consumo reciente');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('El Hierro', 0, 0.4, 10, 'el-hierro')])), []);
  assert.deepEqual(isolatedGridBlackouts({ ...ctx([]), metrics: {} }), [], 'sin la fuente (sin ESIOS_TOKEN)');
});

test('la regla está en el motor', () => {
  assert.ok(evaluateRules(ctx([sys('Melilla', 0.2, 28, 5, 'melilla')])).some((a) => a.id === 'red-aislada:melilla'));
});

test('si REE reprograma la demanda a 0 tras el apagón, la referencia es lo que consumía en las dos últimas horas', () => {
  const [alert] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 0, 10, 'la-palma', 20.7)]));
  assert.equal(alert.severity, 'muy alta');
  assert.match(alert.description, /frente a 20,7 MW que consumía en las dos últimas horas/);
});

test('el sistema se sitúa por su clave del dominio, no por el nombre que traiga la fuente', () => {
  const [alert] = isolatedGridBlackouts(ctx([{ ...sys('LA PALMA (isla)', 0, 21), id: 'la-palma' }]));
  assert.equal(alert.title, 'Posible apagón total en La Palma: demanda a 0 MW');
  assert.deepEqual([alert.lat, alert.lon], [28.68, -17.86]);
});

test('hacen falta dos datos seguidos por debajo: uno suelto, o dos con un hueco, no avisan', () => {
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 10, 'la-palma', 21, { previous: null })])), [], 'un solo dato');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 10, 'la-palma', 21, { previous: { real: 20.7, at: NOW - 15 * MIN } })])), [],
    'el anterior era normal: puede ser un dato mal medido');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 10, 'la-palma', 21, { previous: { real: 0, at: NOW - 40 * MIN } })])), [],
    'con media hora de hueco no son seguidos');
  const [mixed] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 10, 'la-palma', 21, { previous: { real: 7, at: NOW - 15 * MIN } })]));
  assert.equal(mixed.severity, 'alta', 'para «muy alta» los dos tienen que estar a cero');
});

test('un dato de hace 45 min (e·sios a veces se retrasa) no cierra una alerta abierta', () => {
  assert.equal(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 45)])).length, 1);
});

test('apagón de más de dos horas con la programada a 0: la referencia es lo que consumía antes del corte', () => {
  const [alert] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 0, 10, 'la-palma', 0, { readMax: 20.7 })]));
  assert.equal(alert.severity, 'muy alta');
  assert.match(alert.description, /frente a 20,7 MW que consumía antes del corte/);
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 3, 0, 10, 'la-palma', 3, { readMax: 20.7 })])), [],
    'con esa referencia sólo se dice que sigue a cero: una noche normal también baja de la mitad');
});
