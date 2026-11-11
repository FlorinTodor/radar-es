// JSON por trozos (lo que guarda el bot): el mismo texto que JSON.stringify, en varios trozos si es grande.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonChunks } from '../../server/adapters/outbound/persistence/json-chunks.js';

const all = async (gen) => {
  const out = [];
  for await (const piece of gen) out.push(piece);
  return out;
};

test('el mismo texto que JSON.stringify, también con lo que éste se salta o cambia', async () => {
  const values = [
    { version: 1, offset: 0, chats: [], seen: [], totals: { added: 0 } },
    { a: undefined, b: () => 1, c: Symbol('x'), d: null, e: NaN, f: -0, g: Infinity, h: 'comillas " y \\ y \n y ñ', i: [undefined, () => 1, NaN] },
    { date: new Date(Date.UTC(2026, 10, 11)), nested: { deep: { deeper: [1, { x: undefined }] } }, toJSON: undefined },
    { custom: { toJSON: () => 'propio' }, list: [{ toJSON: () => 42 }] },
    [1, 'dos', [3, [4]], { cinco: 5 }, null],
    'texto suelto',
    42,
    null,
    Object.assign(Object.create(null), { sinPrototipo: true }),
    [, 'hueco'], // eslint-disable-line no-sparse-arrays
    // toJSON que no da nada (fuera en un objeto, null en una lista) y que usa su clave, como en JSON.stringify.
    { a: { toJSON: () => undefined }, b: 1, list: [{ toJSON: () => undefined }, 2] },
    { clave: { toJSON: (k) => `soy ${k}` }, list: [{ toJSON: (k) => `en ${k}` }], hondo: { x: [{ toJSON: (k) => k }] } },
    { toJSON: () => ({ todo: 'cambiado', list: [1] }) },
    { lista: Object.assign([1, 2], { toJSON: () => 'lista propia' }) },
  ];
  for (const v of values) assert.equal((await all(jsonChunks(v))).join(''), JSON.stringify(v));
});

test('algo grande sale en varios trozos de más o menos el tamaño pedido', async () => {
  const big = { chats: Array.from({ length: 2000 }, (_, i) => ({ id: i, subs: [{ key: `s-renfe-${i}`, name: 'Avant 08058' }] })), seen: [] };
  const pieces = await all(jsonChunks(big, { chunkChars: 4096 }));
  assert.equal(pieces.join(''), JSON.stringify(big));
  assert.ok(pieces.length > 10, `${pieces.length} trozos`);
  assert.ok(pieces.slice(0, -1).every((p) => p.length >= 4096 && p.length < 4096 + 200));
});
