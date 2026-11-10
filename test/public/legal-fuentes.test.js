// Todas las fuentes del servidor citadas en /legal, en el HTML que se sirve (sin depender de JavaScript):
// cada una lleva su atribución y cada titular de los datos sale nombrado en la página, también cada
// operador de los grupos de horarios del NAP. Si se añade una fuente o un operador sin citarlo, falla.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const legal = fold(readFileSync(new URL('../../public/legal.html', import.meta.url), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));

// Lo que no es el nombre de quien da los datos, dentro de una atribución.
const NOT_A_NAME = /posicion estimada|^tipo de vehiculo|datos en bruto|formato adaptado|uso informativo|^cc by|creative commons|llicencia|no apto|filtrado|sin alterar|^trazado|datos de nasa|dato explotado|horario gtfs|^\d|https?:/;
const PREFIX = /^(powered by|fuente:|origen de los datos:|font de les dades:|informacion obtenida del|obra derivada de|©)\s*/;

/** Titulares de los datos que nombra una atribución: «Powered by MITRAMS (…) · Metro de Sevilla · …» → [MITRAMS, Metro de Sevilla]. */
function holders(license) {
  return license.split(/ · |\. /).map((part) => fold(part).trim().replace(PREFIX, '').replace(/\s*\(.*$/, '').replace(/:.*$/, '').trim())
    .filter((name) => name.length > 2 && !NOT_A_NAME.test(name))
    .flatMap((name) => name.split(/, (?=[a-z])/));
}

test('cada fuente lleva su atribución y quien da sus datos sale nombrado en /legal', () => {
  const sources = createSources(deps);
  assert.ok(sources.length > 40);
  const missing = [];
  for (const s of sources) {
    assert.ok(s.license?.trim(), `${s.id} sin atribución`);
    for (const name of holders(s.license)) if (!legal.includes(name)) missing.push(`${s.id}: «${name}»`);
    for (const op of Object.keys(s.operatorLicenses ?? {})) if (!legal.includes(fold(op))) missing.push(`${s.id}: operador «${op}»`);
  }
  assert.deepEqual(missing, [], 'sin citar en public/legal.html');
});
