// Apagón de un sistema eléctrico aislado (isla, Ceuta, Melilla) a partir de su demanda real frente a
// la programada (e·sios). Regla pura: sin red ni reloj.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';

const NOW = Date.parse('2026-11-02T06:50:00Z');
const MIN = 60_000;
const ctx = (systems) => ({
  now: NOW, vehicles: [], tracks: new Map(), events: [], health: [], kpis: { vehicles: 0 }, kpiHistory: [],
  nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS,
  metrics: { 'esios-sistemas-aislados': { systems } },
});
const sys = (name, real, programmed, minutesAgo = 10, id = 8798, recentMax = real) => ({ id, name, real, programmed, recentMax, at: NOW - minutesAgo * MIN });

test('demanda a cero en La Palma → posible apagón total, en la isla y citando a Red Eléctrica', () => {
  const [alert] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 21)]));
  assert.equal(alert.id, 'red-aislada:8798');
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
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('Tenerife', 380.2, 383, 10, 8797), sys('Ceuta', 16, 30, 10, 12)])).map((a) => a.id), [],
    'Ceuta un 47 % por debajo no llega a la mitad: no avisa');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('Ceuta', 14.9, 30, 10, 12)])).map((a) => a.severity), ['alta']);
});

test('sin datos fiables no hay alerta: dato viejo, sin programada o sistema minúsculo', () => {
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, 21, 45)])), [], 'dato de hace 45 min');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('La Palma', 0, null)])), [], 'sin programada ni consumo reciente');
  assert.deepEqual(isolatedGridBlackouts(ctx([sys('El Hierro', 0, 0.4, 10, 8800)])), []);
  assert.deepEqual(isolatedGridBlackouts({ ...ctx([]), metrics: {} }), [], 'sin la fuente (sin ESIOS_TOKEN)');
});

test('la regla está en el motor', () => {
  assert.ok(evaluateRules(ctx([sys('Melilla', 0.2, 28, 5, 49)])).some((a) => a.id === 'red-aislada:49'));
});

test('si REE reprograma la demanda a 0 tras el apagón, la referencia es lo que consumía en las dos últimas horas', () => {
  const [alert] = isolatedGridBlackouts(ctx([sys('La Palma', 0, 0, 10, 8798, 20.7)]));
  assert.equal(alert.severity, 'muy alta');
  assert.match(alert.description, /frente a 20,7 MW que consumía en las dos últimas horas/);
});
