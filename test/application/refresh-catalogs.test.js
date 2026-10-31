import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRefreshCatalogs } from '../../server/application/use-cases/refresh-catalogs.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('espera a las estaciones y después lanza los trazados sin esperarlos', async () => {
  const steps = [];
  let finishNetwork;
  const stations = { load: async () => { steps.push('estaciones'); return 900; } };
  const network = { load: () => { steps.push('trazados'); return new Promise((resolve) => { finishNetwork = resolve; }); } };
  await makeRefreshCatalogs({ stations, network, log: { warn() {} } })();
  assert.deepEqual(steps, ['estaciones', 'trazados'], 'los trazados empiezan cuando las estaciones están listas');
  finishNetwork(120); // seguían cargándose cuando el caso de uso ya había terminado
});

test('un fallo de los trazados se registra y no rompe la recarga', async () => {
  const warnings = [];
  const refresh = makeRefreshCatalogs({
    stations: { load: async () => 900 },
    network: { load: async () => { throw new Error('NAP caído'); } },
    log: { warn: (msg) => warnings.push(msg) },
  });
  await refresh();
  await flush();
  assert.deepEqual(warnings, ['[líneas] NAP caído']);
});
