// Pestaña «Estaciones»: buscador con las de Renfe y las de las demás redes, y filtro por red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterStations, stationKey, stationNetworks } from '../../public/js/panels.js';

const STATIONS = [
  { code: '71801', name: 'Barcelona-Sants', place: 'Barcelona' },
  { code: 'tmb:P.1', name: 'Sants Estació', network: 'Metro de Barcelona (TMB)', networkId: 'tmb' },
  { code: 'fgc:PC', name: 'Barcelona - Plaça Catalunya', network: 'FGC', networkId: 'fgc' },
  { code: 'mlm:1', name: 'Pinar de Chamartin', network: 'Metro Ligero y Tranvía de Madrid', networkId: 'mlm' },
];
const codes = (list) => list.map((s) => s.code);

test('busca en todas las redes; primero las que empiezan por lo buscado', () => {
  assert.deepEqual(codes(filterStations(STATIONS, 'sants')), ['tmb:P.1', '71801']);
  assert.deepEqual(codes(filterStations(STATIONS, 'fgc')), ['fgc:PC'], 'también por el nombre de la red');
  assert.deepEqual(codes(filterStations(STATIONS, '')), [], 'sin búsqueda ni red, nada');
});

test('con una red elegida, sólo las suyas; sin palabras, todas las de esa red', () => {
  assert.deepEqual(codes(filterStations(STATIONS, '', 'tmb')), ['tmb:P.1']);
  assert.deepEqual(codes(filterStations(STATIONS, 'barcelona', 'renfe')), ['71801']);
  assert.deepEqual(codes(filterStations(STATIONS, 'sants', 'fgc')), []);
});

test('el selector: Renfe primero y después las demás redes por orden alfabético', () => {
  assert.deepEqual(stationNetworks(STATIONS), [['renfe', 'Renfe'], ['fgc', 'FGC'], ['tmb', 'Metro de Barcelona (TMB)'], ['mlm', 'Metro Ligero y Tranvía de Madrid']]);
});

test('los trenes se cuentan por nombre sin tildes ni mayúsculas (el Metro Ligero publica «PINAR DE CHAMARTIN»)', () => {
  assert.equal(stationKey('PINAR DE CHAMARTIN'), stationKey('Pinar de Chamartín'));
  assert.equal(stationKey('Terrassa  Estació del nord'), stationKey('Terrassa Estació del Nord'));
});
