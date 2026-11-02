// Repositorio en memoria: lo que devuelve es para leer, y el histórico de KPIs no se puede cambiar
// desde fuera (las reglas y /api/kpis reciben una copia).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPort, PORT_MEMBERS } from '../../server/application/ports.js';
import { createInMemorySituation } from '../../server/adapters/outbound/persistence/in-memory-situation.js';

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

test('pushKpiSample guarda como mucho las muestras que le dice quien las toma', () => {
  const situation = createInMemorySituation();
  for (let t = 1; t <= 5; t++) situation.pushKpiSample({ t, vehicles: t }, 3);
  assert.deepEqual(situation.kpiHistory().map((k) => k.t), [3, 4, 5], 'salen las más antiguas');
});
