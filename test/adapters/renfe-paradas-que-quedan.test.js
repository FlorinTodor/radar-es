// Cercanías: las paradas que le quedan a cada tren, según su estado en el tiempo real de Renfe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopsLeft } from '../../server/adapters/outbound/sources/renfe.js';

const STOPS = ['A', 'B', 'C', 'D'];

test('en camino, stopId es la que acaba de dejar: le quedan las siguientes', () => {
  assert.deepEqual(stopsLeft('IN_TRANSIT_TO', 'B', STOPS), ['C', 'D']);
});

test('parado, en la que está: le quedan las siguientes; llegando, también la de llegada', () => {
  assert.deepEqual(stopsLeft('STOPPED_AT', 'B', STOPS), ['C', 'D']);
  assert.deepEqual(stopsLeft('INCOMING_AT', 'B', STOPS), ['B', 'C', 'D']);
});

test('en su destino, o con una parada que no es de su viaje, nada', () => {
  assert.equal(stopsLeft('STOPPED_AT', 'D', STOPS), null);
  assert.equal(stopsLeft('IN_TRANSIT_TO', 'X', STOPS), null);
  assert.equal(stopsLeft('IN_TRANSIT_TO', 'B', null), null);
});
