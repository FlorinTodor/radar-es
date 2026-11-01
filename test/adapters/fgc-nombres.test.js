// FGC: su API de posiciones sólo da códigos de estación ("PE → ML", «Próxima AL»); los nombres salen
// del stops.txt de su GTFS (el mismo que da los trazados de sus líneas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { createFgcSource, fgcStations } from '../../server/adapters/outbound/sources/fgc.js';

const STOPS = 'stop_lat,stop_lon,stop_name,stop_id,wheelchair_boarding,location_type,parent_station,platform_code\n'
  + '41.3747199,2.148458333,Barcelona - Plaça Espanya,PE,0,1,,\n'
  + '41.3747199,2.148458333,Barcelona - Plaça Espanya,PE1,0,0,PE,1\n'
  + '41.35306747,2.085251402,Almeda,AL,0,1,,\n'
  + '41.349,2.046,Molí Nou - Ciutat Cooperativa,ML,0,1,,\n';
const record = { lin: 'L8', ut: '1c2cc4fd0375', geo_point_2d: { lat: 41.3545, lon: 2.0945 }, origen: 'PE', desti: 'ML', estacionat_a: null,
  properes_parades: '{"parada": "AL"};{"parada": "CO"}', en_hora: 'True', tipus_unitat: '213' };
const http = { json: async () => ({ results: [record] }) };

test('nombres de estación por código; los andenes (con estación madre) no cuentan', () => {
  const stations = fgcStations(strToU8(STOPS));
  assert.deepEqual(stations.get('PE'), { name: 'Barcelona - Plaça Espanya', at: [2.148458333, 41.3747199] });
  assert.equal(stations.get('AL').name, 'Almeda');
  assert.equal(stations.has('PE1'), false);
});

test('el tren lleva origen, destino y próxima con su nombre; los códigos que falten se quedan como están', async () => {
  const nap = { enabled: true, gtfs: async (id) => (id === 1571 ? zipSync({ 'stops.txt': strToU8(STOPS) }) : null) };
  const { vehicles: [v] } = await createFgcSource({ http, nap }).fetch();
  assert.equal(v.origin, 'Barcelona - Plaça Espanya');
  assert.equal(v.destination, 'Molí Nou - Ciutat Cooperativa');
  assert.equal(v.next, 'Almeda');
  assert.equal(v.current, null);
  assert.deepEqual(v.end, [2.046, 41.349], 'dónde acaba: lo que le queda se dibuja hasta ahí');
});

test('sin el GTFS (sin clave del NAP o si falla), los códigos', async () => {
  const sinClave = await createFgcSource({ http, nap: { enabled: false } }).fetch();
  assert.equal(sinClave.vehicles[0].origin, 'PE');
  assert.equal(sinClave.vehicles[0].end, null);
  const warnings = [];
  const falla = await createFgcSource({ http, nap: { enabled: true, gtfs: async () => { throw new Error('NAP caído'); } }, log: { warn: (m) => warnings.push(m) } }).fetch();
  assert.equal(falla.vehicles[0].next, 'AL');
  assert.match(warnings[0], /NAP caído/);
});
