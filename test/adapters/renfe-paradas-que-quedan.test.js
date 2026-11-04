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

test('línea circular (el C4 de Sevilla, de Santa Justa a Santa Justa): al volver a su estación de origen no empieza otra vez', async () => {
  const { cercaniasFrom, cercaniasNext, stopIndex } = await import('../../server/adapters/outbound/sources/renfe.js');
  const RING = ['SJ', 'PC', 'PP', 'VR', 'SB', 'SJ'];
  // Al salir: Santa Justa es la primera.
  assert.deepEqual(stopsLeft('STOPPED_AT', 'SJ', RING), ['PC', 'PP', 'VR', 'SB', 'SJ']);
  assert.equal(stopIndex(RING, 'SJ'), 0);
  // Tras dejar San Bernardo (posición 4), Santa Justa es la del final: le queda sólo ella, y parado en ella, nada.
  assert.equal(stopIndex(RING, 'SJ', 4), 5);
  assert.deepEqual(stopsLeft('INCOMING_AT', 'SJ', RING, 4), ['SJ']);
  assert.equal(stopsLeft('STOPPED_AT', 'SJ', RING, 4), null);
  assert.equal(cercaniasFrom('STOPPED_AT', 'SJ', RING, 4), 5);
  assert.equal(cercaniasNext('IN_TRANSIT_TO', 'SB', RING, 4), 'SJ');
  // Una parada que no está desde ahí (un dato raro), la primera vez que sale en el viaje.
  assert.equal(stopIndex(RING, 'PC', 4), 1);
  assert.equal(stopIndex(RING, 'X', 4), -1);
});
