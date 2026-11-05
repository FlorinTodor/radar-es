// KPIs de la flota vigilada: cuántos trenes hay, cuántos van con retraso y la mediana.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeKpis, median } from '../../server/domain/kpis.js';

test('mediana: la del medio, o la media de las dos del medio; sin valores, null', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([10, 2, 4, 8]), 6);
  const values = [3, 1, 2];
  median(values);
  assert.deepEqual(values, [3, 1, 2], 'no reordena la lista que recibe');
});

test('KPIs: «con retraso» es de 5 min en adelante y los trenes sin dato de retraso no cuentan para él', () => {
  const v = (mode, delay) => ({ mode, delay });
  const kpis = computeKpis([v('av', 4), v('av', 5), v('cercanias', 30), v('cercanias', null), v('metro', undefined), v('md', -3)], 1000);
  assert.deepEqual(kpis, {
    t: 1000,
    vehicles: 6,
    byMode: { av: 2, cercanias: 2, metro: 1, md: 1 },
    delayed: 2,
    withDelayInfo: 4,
    medianDelay: 4.5,
    maxDelay: 30,
  });
});

test('KPIs sin trenes o sin ningún dato de retraso: ceros y nulls, no NaN ni -Infinity', () => {
  assert.deepEqual(computeKpis([], 5), { t: 5, vehicles: 0, byMode: {}, delayed: 0, withDelayInfo: 0, medianDelay: null, maxDelay: null });
  const kpis = computeKpis([{ mode: 'metro', delay: null }], 5);
  assert.equal(kpis.medianDelay, null);
  assert.equal(kpis.maxDelay, null);
});

test('KPIs con 200.000 trenes con retraso: el máximo sale igual (Math.max(...retrasos) agotaba la pila)', () => {
  const vehicles = Array.from({ length: 200_000 }, (_, i) => ({ mode: 'cercanias', delay: i % 50 }));
  vehicles[123_456].delay = 95;
  const kpis = computeKpis(vehicles, 1000);
  assert.equal(kpis.maxDelay, 95);
  assert.equal(kpis.withDelayInfo, 200_000);
});
