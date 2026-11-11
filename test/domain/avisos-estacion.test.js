// Los avisos de Renfe de una estación, los mismos en la ficha de la web y en el bot: los que llegan con sus
// coordenadas (a menos de 300 m), una vez cada texto; ninguno en las estaciones de otras redes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTICE_KM, noticesAtStation } from '../../server/domain/avisos-estacion.js';

const MAJADAHONDA = { code: '10005', name: 'Majadahonda', lat: 40.4742885, lon: -3.8462931 };
const aviso = (id, over = {}) => ({
  id, source: 'renfe-avisos', category: 'ferroviario', type: 'aviso', title: 'Aviso Renfe', lat: 40.4742885, lon: -3.8462931,
  description: 'Ascensor de la estación Majadahonda que da acceso a la vía 2 sentido Villalba / Alcalá de Henares, se encuentra fuera de servicio.',
  ...over,
});

test('los de la estación: cerca (con sus coordenadas) y ferroviarios', () => {
  const events = [
    aviso('renfe-aviso:INFO_525469'),
    aviso('lejos', { lat: 40.4466271, lon: -3.6923468, description: 'Ascensor de Nuevos Ministerios fuera de servicio.' }),
    aviso('sin-sitio', { lat: null, lon: null, description: 'Huelga de maquinistas.' }),
    { id: 'obra', category: 'carretera', lat: 40.4742885, lon: -3.8462931, description: 'Obras' },
    aviso('a-200-m', { lat: 40.4760, description: 'Acceso por la calle de la estación cerrado.' }),
  ];
  assert.deepEqual(noticesAtStation(MAJADAHONDA, events).map((e) => e.id), ['renfe-aviso:INFO_525469', 'a-200-m']);
  assert.equal(NOTICE_KM, 0.3);
});

test('el mismo texto dos veces (otro id, otros espacios o mayúsculas), una sola', () => {
  const events = [aviso('a'), aviso('b', { description: `  ${aviso('x').description.toUpperCase()}\r\n` })];
  assert.deepEqual(noticesAtStation(MAJADAHONDA, events).map((e) => e.id), ['a']);
});

test('las estaciones de otras redes (metro, tranvía…) no tienen avisos de Renfe; sin estación o sin sitio, ninguno', () => {
  assert.deepEqual(noticesAtStation({ ...MAJADAHONDA, network: 'Metro Ligero Oeste', networkId: 'mlo' }, [aviso('a')]), []);
  assert.deepEqual(noticesAtStation(null, [aviso('a')]), []);
  assert.deepEqual(noticesAtStation({ name: 'Sin sitio' }, [aviso('a')]), []);
  assert.deepEqual(noticesAtStation(MAJADAHONDA, undefined), []);
});
