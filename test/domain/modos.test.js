// Registro de tipos de vehículo (domain/modos.js): el único sitio donde se dan de alta. Lo que el cliente
// y el GTFS ya tenían por su cuenta tiene que ir alineado con él: si se añade un tipo y no se toca, falla aquí.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, isMode, modeIds, modeInfo, modeNoun } from '../../server/domain/modos.js';
import { modeOf } from '../../server/adapters/outbound/gtfs/gtfs-modes.js';
import { MODE_LABEL } from '../../public/js/format.js';
import { MODE_ITEMS, MODES_OFF_BY_DEFAULT } from '../../public/js/panels.js';

const FAMILIES = ['ferrocarril', 'carretera', 'agua', 'aire', 'otros'];

test('cada tipo: id único, nombre, cómo se llama un vehículo y su familia', () => {
  assert.equal(new Set(modeIds()).size, MODES.length);
  for (const m of MODES) {
    assert.match(m.id, /^[a-z]+$/, m.id);
    assert.ok(m.label && m.noun && m.nounPlural, m.id);
    assert.ok(FAMILIES.includes(m.family), `${m.id}: ${m.family}`);
    assert.ok(Object.isFrozen(m), 'nadie lo cambia en marcha');
  }
  assert.equal(modeInfo('bus').family, 'carretera');
  assert.equal(isMode('barco'), false);
  assert.equal(modeNoun('bus'), 'autobús');
  assert.equal(modeNoun('bus', true), 'autobuses');
  assert.equal(modeNoun('barco'), 'vehículo', 'uno que aún no está dado de alta');
});

test('el cliente usa los mismos tipos, en el mismo orden y con los mismos nombres', () => {
  assert.deepEqual(MODE_ITEMS, modeIds());
  assert.deepEqual(Object.fromEntries(MODES.map((m) => [m.id, m.label])), MODE_LABEL);
  assert.deepEqual(MODES_OFF_BY_DEFAULT, MODES.filter((m) => m.offByDefault).map((m) => m.id));
});

test('los tipos que salen del GTFS (route_type) están dados de alta', () => {
  const types = [...Array(13).keys(), ...Array.from({ length: 15 }, (_, i) => 100 * (i + 1)), 109, 401, 405, 900, 1300, 1400];
  for (const t of types) {
    const mode = modeOf(t);
    if (mode !== null) assert.ok(isMode(mode), `route_type ${t} → ${mode}`);
  }
});
