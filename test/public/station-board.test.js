// Ficha de estación: qué trenes están en ella y cuáles van hacia ella, sus avisos y sus líneas,
// con lo que ya llega en directo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationBoard } from '../../public/js/station-board.js';

const OVIEDO = { code: '15211', name: 'Oviedo', lat: 43.3663577, lon: -5.854838 };
const tren = (id, extra) => ({ id, mode: 'cercanias', line: 'C1', lat: 43.36, lon: -5.85, ...extra });
const linea = (line, coords, network = 'Cercanías Renfe') => ({ properties: { line, network, color: '#f00', mode: 'cercanias' }, geometry: { type: 'LineString', coordinates: coords } });

test('separa los trenes parados en la estación de los que van hacia ella, por hora de llegada', () => {
  const vehicles = [
    tren('parado', { stopped: true, current: 'Oviedo', platform: '2' }),
    tren('tarde', { next: 'Oviedo', nextEta: '2026-11-01T13:50:00', lat: 43.5, lon: -5.66 }),
    tren('pronto', { next: 'Oviedo', nextEta: '2026-11-01T13:41:00', lat: 43.4, lon: -5.8 }),
    tren('otra', { next: 'Gijón', nextEta: '2026-11-01T13:40:00' }),
    tren('mismo nombre lejos', { stopped: true, current: 'Oviedo', lat: 40.4, lon: -3.7 }),
  ];
  const b = stationBoard(OVIEDO, { vehicles, events: [], lines: [] });
  assert.deepEqual(b.stopped.map((v) => v.id), ['parado']);
  assert.deepEqual(b.arriving.map((v) => v.id), ['pronto', 'tarde']);
});

test('los avisos de Renfe son los de su estación', () => {
  const events = [
    { id: 'a', category: 'ferroviario', lat: 43.3664, lon: -5.8549, description: 'Ascensor fuera de servicio' },
    { id: 'b', category: 'ferroviario', lat: 43.54, lon: -5.66 },
    { id: 'c', category: 'carretera', lat: 43.3664, lon: -5.8549 },
  ];
  assert.deepEqual(stationBoard(OVIEDO, { vehicles: [], events, lines: [] }).notices.map((e) => e.id), ['a']);
});

test('las líneas que pasan por la estación, una vez cada una y en orden', () => {
  const pasa = [[-5.87, 43.3664], [-5.84, 43.3664]];
  const lines = [linea('C3', pasa), linea('C1', pasa), linea('C1', pasa), linea('C5', [[-5.70, 43.30], [-5.60, 43.30]])];
  assert.deepEqual(stationBoard(OVIEDO, { vehicles: [], events: [], lines }).lines.map((l) => l.line), ['C1', 'C3']);
});

test('metro y tranvía a menos de 300 m salen como conexiones, no como líneas de la estación', () => {
  const metro = (line, lat) => ({ properties: { line, network: 'Metro', color: '#00f', mode: 'metro' }, geometry: { type: 'LineString', coordinates: [[-5.87, lat], [-5.84, lat]] } });
  const b = stationBoard(OVIEDO, { vehicles: [], events: [], lines: [metro('L1', 43.3664), metro('L2', 43.3680), metro('L9', 43.3720)] }); // ~0, ~180 y ~630 m
  assert.deepEqual(b.connections.map((l) => l.line), ['L1', 'L2']);
  assert.equal(b.lines.length, 0);
});

test('el buscador de estaciones no distingue tildes ni mayúsculas y pone primero las que empiezan así', async () => {
  const { filterStations } = await import('../../public/js/panels.js');
  const st = [
    { code: '1', name: 'Castellón de la Plana', place: 'Castellón' },
    { code: '2', name: 'Valencia-Cabanyal', place: 'Valencia' },
    { code: '3', name: 'Cabañas', place: 'Castellon' },
  ];
  assert.deepEqual(filterStations(st, 'castellon').map((s) => s.code), ['1', '3']);
  assert.deepEqual(filterStations(st, 'CABAN').map((s) => s.code), ['3', '2']);
  assert.equal(filterStations(st, '  ').length, 0);
  assert.deepEqual(filterStations([{ code: '60000', name: 'Madrid-Puerta de Atocha-Almudena Grandes', place: 'Madrid' }], 'atocha almudena').map((s) => s.code), ['60000']);
});
