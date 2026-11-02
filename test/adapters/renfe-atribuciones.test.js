// Cada fuente de Renfe dice qué se hace con sus datos: los Cercanías, que lo que le queda va por el
// trazado del horario del NAP (dato explotado); los de AV/LD/MD, que se dibujan sobre la red de Adif.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRenfeSources } from '../../server/adapters/outbound/sources/renfe.js';

test('atribución de cada fuente de Renfe con lo que se dibuja con datos de otros', () => {
  const stations = { get: () => undefined, name: () => null };
  const [cercanias, largaDistancia, avisos] = createRenfeSources({ http: {}, cache: {}, stations, log: { warn() {}, info() {} } });
  for (const s of [cercanias, largaDistancia, avisos]) assert.match(s.license, /^Origen de los datos: Renfe Operadora \(CC BY 4\.0; datos modificados/);
  assert.match(cercanias.license, /trazado: Powered by MITRAMS \(dato explotado\)/);
  assert.match(largaDistancia.license, /red de Adif, © Administrador de infraestructuras ferroviarias/);
  assert.doesNotMatch(avisos.license, /MITRAMS|Adif/, 'los avisos no se dibujan con nada de fuera');
});
