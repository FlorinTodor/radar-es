// Fuentes en pausa: se citan en /legal y salen en el estado de las fuentes, pero no se leen. Hoy, los
// avisos oficiales de seis comunidades; Canarias sigue activa.
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

test('avisos oficiales: Canarias activa; las demás comunidades en pausa, con su motivo; e·sios activa', () => {
  const byId = Object.fromEntries(createSources(deps).map((s) => [s.id, s]));
  assert.equal(byId['emergencias-canarias'].paused, undefined);
  assert.equal(byId['esios-sistemas-aislados'].paused, undefined);
  for (const id of ['emergencias-cataluna', 'emergencias-andalucia', 'emergencias-castilla-la-mancha', 'emergencias-la-rioja', 'emergencias-castilla-y-leon', 'emergencias-illes-balears']) {
    assert.match(byId[id].paused ?? '', /pausa/, id);
  }
});
