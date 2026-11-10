// Cuánto se usa el bot, en conjunto (lo que ve la monitorización): chats, cosas seguidas por tipo, cosas
// distintas, partes diarios y lo más seguido, sin el número de ningún chat; y los totales que se guardan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';
import { USAGE_KINDS, countEvent, emptyTotals, parseTotals, usageOf } from '../../server/domain/seguidos/uso.js';

const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const C4A = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' });
const STOP = stopKey('10600');

const chat = (id, subs = {}, provinces = [], digest = null) => ({
  id,
  subs: new Map(Object.entries(subs).map(([key, s]) => [key, typeof s === 'string' ? { name: s } : s])),
  provinces: new Map(provinces.map((p) => [p, { since: 0, checkedAt: 0 }])),
  digest,
});

test('sin chats: todo a cero, con todos los tipos', () => {
  const u = usageOf([]);
  assert.deepEqual(u, {
    chats: 0, digest: 0, follows: { servicio: 0, linea: 0, parada: 0, provincia: 0 },
    distinct: { servicio: 0, linea: 0, parada: 0, provincia: 0 }, top: [],
  });
  assert.deepEqual(Object.keys(u.follows), USAGE_KINDS);
});

test('cuenta chats, cosas por tipo, cosas distintas y partes; lo más seguido primero', () => {
  const u = usageOf([
    chat(1001, { [AVANT]: 'Avant 08058', [C4A]: 'C4a Cercanías Madrid' }, ['valencia'], '07:30'),
    chat(1002, { [C4A]: 'C4a Cercanías Madrid', [STOP]: 'Estación Valladolid-Campo Grande' }, ['valencia', 'soria']),
    chat(1003, { [C4A]: 'C4a Cercanías Madrid' }),
  ]);
  assert.equal(u.chats, 3);
  assert.equal(u.digest, 1);
  assert.deepEqual(u.follows, { servicio: 1, linea: 3, parada: 1, provincia: 3 });
  assert.deepEqual(u.distinct, { servicio: 1, linea: 1, parada: 1, provincia: 2 });
  assert.deepEqual(u.top, [
    { kind: 'linea', key: C4A, name: 'C4a Cercanías Madrid', chats: 3 },
    { kind: 'provincia', key: 'prov-valencia', name: 'Valencia', chats: 2 },
    { kind: 'servicio', key: AVANT, name: 'Avant 08058', chats: 1 },
    { kind: 'parada', key: STOP, name: 'Estación Valladolid-Campo Grande', chats: 1 },
    { kind: 'provincia', key: 'prov-soria', name: 'Soria', chats: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(u), /100[123]/, 'ni rastro del número de un chat');
});

test('el nombre de verdad gana al provisional; el tope de lo más seguido', () => {
  const u = usageOf([
    chat(1, { [AVANT]: { name: 'un tren de Renfe', guessed: true } }),
    chat(2, { [AVANT]: { name: 'Avant 08058' } }),
    chat(3, { [AVANT]: { name: 'un tren de Renfe', guessed: true }, [C4A]: 'C4a Cercanías Madrid' }),
  ], { top: 1 });
  assert.deepEqual(u.top, [{ kind: 'servicio', key: AVANT, name: 'Avant 08058', chats: 3 }]);
  assert.deepEqual(u.distinct, { servicio: 1, linea: 1, parada: 0, provincia: 0 }, 'las distintas se cuentan todas');
  assert.deepEqual(usageOf([chat(1, { [AVANT]: { name: 'un tren de Renfe', guessed: true } })]).top[0].name, 'un tren de Renfe');
});

test('totales: cuentan sólo lo de sus listas y se leen del disco sin fiarse de lo que haya', () => {
  const t = emptyTotals(1000);
  countEvent(t, 'alta');
  countEvent(t, 'baja', 'bloqueo');
  countEvent(t, 'baja', 'otra cosa');
  countEvent(t, 'aviso', 'parte');
  countEvent(t, 'orden', 'mis');
  countEvent(t, 'orden', 'mis');
  countEvent(t, 'orden', 'constructor');
  countEvent(t, 'orden', '__proto__');
  countEvent(t, 'inventado', 'x');
  assert.deepEqual(t, {
    since: 1000, added: 1, removed: { dejar: 0, baja: 0, bloqueo: 1 }, notices: { aviso: 0, parte: 1 }, commands: { mis: 2, constructor: 1 },
  });
  assert.deepEqual(parseTotals(JSON.parse(JSON.stringify(t)), 5000), t, 'ida y vuelta por JSON, tal cual');
  assert.deepEqual(parseTotals(null, 5000), emptyTotals(5000));
  assert.deepEqual(parseTotals({ since: 0, added: 1.5, removed: 'x', commands: { MIS: 1, ok: 2 } }, 5000),
    { ...emptyTotals(5000), commands: { ok: 2 } });
  for (let i = 0; i < 50; i++) countEvent(t, 'orden', `orden${'abcdefghijklmnopqrstuvwxyz'[i % 26]}${'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26)]}`);
  assert.equal(Object.keys(t.commands).length, 40, 'con un tope de órdenes distintas');
});
