// El directo se entera de los cambios por el caso de uso, no por el bus: aquí se comprueba qué
// recibe quien escucha con cada evento de la aplicación.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWatchSituation } from '../../server/application/use-cases/watch-situation.js';

/** Bus mínimo con el contrato de EventPublisherPort. */
function fakeBus() {
  const handlers = new Map();
  return {
    publish: (topic, payload) => (handlers.get(topic) ?? []).forEach((h) => h(payload)),
    subscribe(topic, handler) {
      handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
      return () => handlers.set(topic, handlers.get(topic).filter((h) => h !== handler));
    },
    count: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
  };
}

const query = {
  sourcePayload: (id, { buses }) => (id === 'vacia' ? null : { id, buses }),
  resolvedAlerts: () => Array.from({ length: 40 }, (_, i) => ({ id: `r${i}` })),
};

function listen(events, options) {
  const got = { source: [], health: 0, alerts: [] };
  const unwatch = makeWatchSituation({ events, query })(options, {
    onSource: (p) => got.source.push(p),
    onHealthChange: () => got.health++,
    onAlerts: (p) => got.alerts.push(p),
  });
  return { got, unwatch };
}

test('una fuente leída envía sus datos (con o sin autobuses) y avisa de que cambia el estado', () => {
  const bus = fakeBus();
  const conBuses = listen(bus, { buses: true });
  const sinBuses = listen(bus, { buses: false });
  bus.publish('source.updated', { id: 'renfe' });
  assert.deepEqual(conBuses.got.source, [{ id: 'renfe', buses: true }]);
  assert.deepEqual(sinBuses.got.source, [{ id: 'renfe', buses: false }]);
  assert.equal(conBuses.got.health, 1);
});

test('una fuente sin datos no envía nada, pero el estado sí cambia; un fallo sólo cambia el estado', () => {
  const bus = fakeBus();
  const { got } = listen(bus, {});
  bus.publish('source.updated', { id: 'vacia' });
  bus.publish('source.failed', { id: 'dgt' });
  assert.deepEqual(got.source, []);
  assert.equal(got.health, 2);
});

test('las alertas llegan con los indicadores y las 30 últimas resueltas', () => {
  const bus = fakeBus();
  const { got } = listen(bus, {});
  bus.publish('alerts.updated', { alerts: [{ id: 'a' }], kpis: { vehicles: 10 }, changed: 1 });
  assert.equal(got.alerts.length, 1);
  assert.deepEqual(got.alerts[0].alerts, [{ id: 'a' }]);
  assert.deepEqual(got.alerts[0].kpis, { vehicles: 10 });
  assert.equal(got.alerts[0].resolved.length, 30);
  assert.equal(got.alerts[0].resolved[0].id, 'r0');
});

test('al dejar de escuchar se borran las tres suscripciones', () => {
  const bus = fakeBus();
  const { got, unwatch } = listen(bus, {});
  assert.equal(bus.count(), 3);
  unwatch();
  assert.equal(bus.count(), 0);
  bus.publish('source.updated', { id: 'renfe' });
  assert.deepEqual(got.source, []);
});
