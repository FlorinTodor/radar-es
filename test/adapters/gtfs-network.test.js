// Trazados de la red: cada línea guarda los shape_id de los viajes que la siguen, para que el mapa
// encuentre el del tren seleccionado y dibuje lo que le queda.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { buildNetwork } from '../../server/adapters/outbound/network/gtfs-network-catalog.js';

const csv = (rows) => strToU8(rows.join('\n'));

test('cada trazado lleva sus shape_id, también los repetidos que se pintan una sola vez', async () => {
  const zip = zipSync({
    'routes.txt': csv(['route_id,route_short_name,route_long_name,route_type,route_color', 'R4,C4,La Calzada-Bilbao,2,2C2A86']),
    'trips.txt': csv(['route_id,service_id,trip_id,shape_id', 'R4,S,T1,sh_ida', 'R4,S,T2,sh_ida_bis', 'R4,S,T3,sh_vuelta']),
    'shapes.txt': csv(['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
      'sh_ida,43.20,-3.00,1', 'sh_ida,43.21,-2.95,2',
      'sh_ida_bis,43.20,-3.00,1', 'sh_ida_bis,43.21,-2.95,2', // mismo dibujo que sh_ida
      'sh_vuelta,43.21,-2.95,1', 'sh_vuelta,43.20,-3.00,2']),
  });
  const features = await buildNetwork(zip, 'Cercanías Renfe');
  assert.deepEqual(features.map((f) => f.properties.shapes.sort()), [['sh_ida', 'sh_ida_bis'], ['sh_vuelta']]);
  const { color, ...rest } = features[0].properties;
  assert.deepEqual(rest, { network: 'Cercanías Renfe', line: 'C4', mode: 'cercanias', shapes: ['sh_ida', 'sh_ida_bis'] });
  assert.notEqual(color.toLowerCase(), '#2c2a86', 'el azul muy oscuro se aclara para verse en el mapa');
});

test('colores de línea legibles en el mapa oscuro', async () => {
  const { readableColor } = await import('../../server/adapters/outbound/network/gtfs-network-catalog.js');
  assert.equal(readableColor('#000000', 'tranvia'), '#4fb3a9'); // negro (línea 41 de Vitoria): el color de tranvía
  const gris = readableColor('#737277', 'tranvia'); // TG2 de Vitoria
  assert.notEqual(gris, '#737277');
  assert.ok(parseInt(gris.slice(1, 3), 16) > 0x73, 'más claro');
  assert.equal(readableColor('#fab219', 'cercanias'), '#fab219'); // los claros no se tocan
});
