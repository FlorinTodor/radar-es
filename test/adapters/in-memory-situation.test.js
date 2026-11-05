// Repositorio del estado en memoria: lo que leen los casos de uso (vehículos, sucesos, métricas, salud)
// y lo que guardan (alertas activas y resueltas, KPIs y su histórico). Lo que devuelve es para leer:
// el histórico de KPIs no se puede cambiar desde fuera (las reglas y /api/kpis reciben una copia).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPort, PORT_MEMBERS } from '../../server/application/ports.js';
import { createInMemorySituation } from '../../server/adapters/outbound/persistence/in-memory-situation.js';

const source = (id, kind) => ({ id, name: id.toUpperCase(), kind, interval: 60_000, url: `https://${id}.example/datos` });

test('vehículos y sucesos sólo de las fuentes activas con datos, con el id de su fuente', () => {
  const s = createInMemorySituation();
  s.registerSource(source('renfe', 'vehicles'), { enabled: true });
  s.registerSource(source('fgc', 'vehicles'), { enabled: false, reason: 'sin clave' });
  s.registerSource(source('dgt', 'events'), { enabled: true });
  s.registerSource(source('ree', 'metrics'), { enabled: true });
  s.registerSource(source('aemet', 'events'), { enabled: true }); // todavía sin leer
  s.saveResult('renfe', { vehicles: [{ id: 'renfe:1' }, { id: 'renfe:2' }], sourceTime: 900 }, 1000, 12);
  s.saveResult('fgc', { vehicles: [{ id: 'fgc:1' }] }, 1000, 3);
  s.saveResult('dgt', { events: [{ id: 'dgt:1' }] }, 1000, 40);
  s.saveResult('ree', { metrics: { demanda: 25_000 } }, 1000, 8);
  assert.deepEqual(s.vehicles(), [{ id: 'renfe:1', source: 'renfe' }, { id: 'renfe:2', source: 'renfe' }]);
  assert.deepEqual(s.events(), [{ id: 'dgt:1', source: 'dgt' }]);
  assert.deepEqual(s.metrics(), { ree: { demanda: 25_000 } });
});

test('una fuente de vehículos también puede dar sucesos (los viajes que su tiempo real cancela)', () => {
  const s = createInMemorySituation();
  s.registerSource(source('euskotren', 'vehicles'), { enabled: true });
  s.registerSource(source('amb', 'vehicles'), { enabled: false, reason: 'sin clave' });
  s.saveResult('euskotren', { vehicles: [{ id: 'euskotren:1' }], events: [{ id: 'euskotren-cancelado:T1' }] }, 1000, 5);
  s.saveResult('amb', { vehicles: [], events: [{ id: 'amb-cancelado:T1' }] }, 1000, 5);
  assert.deepEqual(s.events(), [{ id: 'euskotren-cancelado:T1', source: 'euskotren' }], 'de las activas');
  assert.deepEqual(s.vehicles(), [{ id: 'euskotren:1', source: 'euskotren' }]);
  assert.equal(s.health().find((h) => h.id === 'euskotren').count, 1, 'cuenta sus vehículos');
});

test('la salud de cada fuente: última lectura buena, último fallo y cuántos datos trajo', () => {
  const s = createInMemorySituation();
  s.registerSource(source('renfe', 'vehicles'), { enabled: true });
  s.saveResult('renfe', { vehicles: [{ id: 'a' }, { id: 'b' }], sourceTime: 900, datasetUpdated: 800 }, 1000, 12);
  s.saveFailure('renfe', new Error('HTTP 503'), 2000);
  const [renfe] = s.health();
  assert.equal(renfe.ok, false);
  assert.equal(renfe.lastOk, 1000, 'conserva cuándo fue la última buena');
  assert.equal(renfe.lastError, 2000);
  assert.equal(renfe.error, 'HTTP 503');
  assert.equal(renfe.count, 2);
  assert.equal(renfe.sourceTime, 900);
  assert.equal(renfe.datasetUpdated, 800);
  assert.equal(renfe.ms, 12);
  assert.equal(s.vehicles().length, 2, 'tras un fallo se siguen enseñando los últimos datos');
  s.saveResult('renfe', { vehicles: [] }, 3000, 5);
  assert.deepEqual([s.health()[0].ok, s.health()[0].error, s.health()[0].count], [true, null, 0]);
});

test('alertas activas: se cambian sólo a través de updateActiveAlerts', () => {
  const s = createInMemorySituation();
  const changes = s.updateActiveAlerts((active) => {
    active.set('a', { id: 'a' });
    return { opened: 1 };
  });
  assert.deepEqual(changes, { opened: 1 }, 'devuelve lo que devuelve la función');
  assert.deepEqual([...s.activeAlerts().keys()], ['a']);
});

test('resueltas: las más recientes primero y como mucho 100', () => {
  const s = createInMemorySituation();
  const batch = (from, n) => Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` }));
  s.addResolved(batch(0, 60));
  s.addResolved([]);
  assert.equal(s.resolvedAlerts().length, 60, 'una lista vacía no cambia nada');
  s.addResolved(batch(60, 60));
  const resolved = s.resolvedAlerts();
  assert.equal(resolved.length, 100);
  assert.equal(resolved[0].id, 'r60', 'las de la última evaluación, delante');
  assert.equal(resolved.at(-1).id, 'r39', 'las 20 más viejas se han ido');
  s.addResolved(batch(200, 150));
  assert.equal(s.resolvedAlerts().length, 100, 'aunque lleguen más de 100 de golpe');
  assert.equal(s.resolvedAlerts()[0].id, 'r200');
});

test('KPIs y su histórico, con tope', () => {
  const s = createInMemorySituation();
  assert.equal(s.kpis(), null);
  const kpis = { vehicles: 3 };
  s.setKpis(kpis);
  assert.equal(s.kpis(), kpis);
  for (let t = 1; t <= 5; t++) s.pushKpiSample({ t }, 3);
  assert.deepEqual(s.kpiHistory().map((k) => k.t), [3, 4, 5]);
  assert.equal(s.kpiHistory().length, 3, 'salen las más antiguas: el tope lo pone quien toma las muestras');
});

test('cumple el puerto SituationRepository', () => {
  assert.doesNotThrow(() => assertPort('SituationRepository', createInMemorySituation(), PORT_MEMBERS.SituationRepository));
});

test('kpiHistory da una copia: cambiarla no toca el histórico guardado', () => {
  const situation = createInMemorySituation();
  situation.pushKpiSample({ t: 1, vehicles: 10 }, 5);
  const copy = situation.kpiHistory();
  copy.push({ t: 2, vehicles: 99 });
  assert.deepEqual(situation.kpiHistory(), [{ t: 1, vehicles: 10 }]);
  copy.length = 0;
  assert.equal(situation.kpiHistory().length, 1);
});
