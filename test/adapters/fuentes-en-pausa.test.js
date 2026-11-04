// Fuentes en pausa (`paused` en DataSourcePort): se citan en /legal y salen en el estado de las fuentes,
// pero no se leen. Hoy sólo la Comunidad de Madrid: su web no responde a nuestro servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSources } from '../../server/adapters/outbound/sources/index.js';

const noop = () => {};
const deps = {
  http: { json: async () => ({}), bytes: async () => new Uint8Array(), text: async () => '' },
  cache: { bytes: async () => new Uint8Array() },
  stations: { get: () => undefined, name: () => null, nearest: () => null, all: () => [] },
  nap: { enabled: true, gtfs: async () => new Uint8Array(), updatedAt: async () => null },
  log: { warn: noop, info: noop, error: noop },
  geocoder: { locate: async () => null },
  pool: { run: async () => null },
};

test('avisos oficiales y e·sios, activos; Madrid en pausa con su motivo', () => {
  const byId = Object.fromEntries(createSources(deps).map((s) => [s.id, s]));
  for (const id of ['emergencias-canarias', 'emergencias-cataluna', 'emergencias-andalucia', 'emergencias-castilla-la-mancha', 'emergencias-la-rioja',
    'emergencias-castilla-y-leon', 'emergencias-illes-balears', 'emergencias-murcia', 'emergencias-cantabria', 'emergencias-galicia',
    'emergencias-pais-vasco', 'esios-sistemas-aislados']) {
    assert.ok(byId[id], id);
    assert.equal(byId[id].paused, undefined, id);
  }
  assert.match(byId['emergencias-madrid'].paused, /no responda a nuestro servidor/);
});
