import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortAlerts } from '../../server/domain/alerts/lifecycle.js';

const T0 = Date.UTC(2026, 0, 18, 18, 0);
const alert = (id, severity, since) => ({ id, severity, since });

test('sortAlerts: primero las más graves y, a igual gravedad, las más recientes', () => {
  const sorted = sortAlerts([
    alert('baja', 'baja', T0),
    alert('alta-antigua', 'alta', T0 - 60_000),
    alert('muy-alta', 'muy alta', T0 - 3_600_000),
    alert('media', 'media', T0),
    alert('alta-nueva', 'alta', T0),
  ]);
  assert.deepEqual(sorted.map((a) => a.id), ['muy-alta', 'alta-nueva', 'alta-antigua', 'media', 'baja']);
});

test('sortAlerts: acepta los valores de un Map y no toca el original', () => {
  const active = new Map([['x', alert('x', 'media', T0)], ['y', alert('y', 'muy alta', T0)]]);
  assert.deepEqual(sortAlerts(active.values()).map((a) => a.id), ['y', 'x']);
  const list = [alert('a', 'baja', T0), alert('b', 'alta', T0)];
  sortAlerts(list);
  assert.deepEqual(list.map((a) => a.id), ['a', 'b']);
});

test('sortAlerts: sin alertas devuelve una lista vacía', () => {
  assert.deepEqual(sortAlerts([]), []);
  assert.deepEqual(sortAlerts(new Map().values()), []);
});

test('sortAlerts: a igual gravedad, los cortes de luz van primero aunque sean más antiguos', () => {
  const sorted = sortAlerts([
    { ...alert('lluvia-nueva', 'alta', T0), type: 'meteo' },
    { ...alert('corte-la-palma', 'alta', T0 - 3_600_000), type: 'apagon' },
    { ...alert('lluvia-otra', 'alta', T0 - 60_000), type: 'meteo' },
    { ...alert('isla-a-cero', 'muy alta', T0 - 7_200_000), type: 'red-electrica' },
    { ...alert('bloqueo', 'muy alta', T0), type: 'bloqueo' },
  ]);
  assert.deepEqual(sorted.map((a) => a.id), ['isla-a-cero', 'bloqueo', 'corte-la-palma', 'lluvia-nueva', 'lluvia-otra'],
    'la gravedad manda; dentro de cada gravedad, primero los cortes de luz');
});
