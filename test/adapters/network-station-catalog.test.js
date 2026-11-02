// Estaciones de las redes que no son de Renfe, a partir de sus GTFS del NAP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { NETWORK_CODE, buildStations, readable, withNetworkExtras } from '../../server/adapters/outbound/stations/network-station-catalog.js';

const csv = (rows) => strToU8(rows.join('\n'));
const RED = { id: 'prueba', name: 'Metro de Prueba' };

/** GTFS con metro (L1, L3), un tranvía y un autobús, como el de TMB o el de Sevilla con TUSSAM. */
const gtfs = () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_long_name,route_type,route_color',
    'L1,L1,Hospital-Fondo,1,CE1126', 'L3,L3,Zona Universitària-Trinitat,1,', 'T1,T1,Tranvía,0,', 'B7,7,Autobús,3,000000']),
  'trips.txt': csv(['route_id,service_id,trip_id', 'L1,S,v1', 'L3,S,v3', 'T1,S,vt', 'B7,S,vb']),
  'stop_times.txt': csv(['trip_id,stop_sequence,stop_id,arrival_time',
    'v1,1,cat-l1,08:00:00', 'v1,2,uni,08:03:00',
    'v3,1,cat-l3,08:00:00', 'v3,2,uni,08:04:00',
    'vt,1,ES:Red:StopPlace:77:,08:00:00',
    'vb,1,bus-1,08:00:00', 'vb,2,cat-l1,08:05:00']),
  'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding',
    // Catalunya: estación con dos andenes (L1 y L3) y un acceso; el acceso no es una estación.
    'catalunya,Catalunya,41.3870,2.1700,1,,0',
    'cat-l1,Catalunya L1,41.3871,2.1701,0,catalunya,1',
    'cat-l3,Catalunya L3,41.3869,2.1699,0,catalunya,1',
    'acc,Acceso Rambla,41.3872,2.1702,2,catalunya,',
    // Universitat: dos paradas sueltas con el mismo nombre (un sentido cada una).
    'uni,Universitat,41.3860,2.1640,0,,2',
    'uni-b,UNIVERSITAT,41.3861,2.1641,0,,',
    // Sin servicio en el horario: no sale.
    'cerrada,Estación cerrada,41.40,2.18,1,,',
    // Parada de autobús: no sale.
    'bus-1,Pl. Catalunya (bus),41.3875,2.1705,0,,',
    // Tranvía con un stop_id largo, como los de Euskotren.
    'ES:Red:StopPlace:77:,PINAR DE CHAMARTIN,41.39,2.19,0,,1']),
});

test('estaciones con servicio ferroviario, sin autobuses ni accesos, con sus líneas', async () => {
  const list = await buildStations(gtfs(), RED);
  assert.deepEqual(list.map((s) => s.name).sort(), ['Catalunya', 'Pinar de Chamartin', 'Universitat']);
  const cat = list.find((s) => s.name === 'Catalunya');
  assert.equal(cat.code, 'prueba:catalunya', 'la fila de estación, no la de un andén');
  assert.deepEqual([cat.lat, cat.lon], [41.387, 2.17], 'las coordenadas tal cual las publica el operador');
  assert.deepEqual(cat.lines.map((l) => l.line), ['L1', 'L3'], 'el autobús que para en un andén no cuenta');
  assert.equal(cat.lines[1].color, '#8a7fd1', 'sin color en el GTFS, el de su modo, como en /api/lines');
  assert.equal(cat.accessible, true, 'la estación no dice nada y sus dos andenes dicen que sí');
  assert.equal(cat.mode, 'metro');
  assert.equal(cat.network, 'Metro de Prueba');
  assert.equal(cat.networkId, 'prueba');
});

test('los andenes y sentidos con el mismo nombre son una sola estación', async () => {
  const list = await buildStations(gtfs(), RED);
  assert.equal(list.filter((s) => s.name.toLowerCase() === 'universitat').length, 1);
  assert.equal(list.find((s) => s.name === 'Universitat').accessible, false);
});

test('código corto y válido, y nombres en mayúsculas legibles', async () => {
  const tram = (await buildStations(gtfs(), RED)).find((s) => s.mode === 'tranvia');
  assert.equal(tram.code, 'prueba:77', '«ES:Red:StopPlace:77:» → «77»');
  assert.match(tram.code, NETWORK_CODE);
  assert.equal(readable('PINAR DE CHAMARTIN'), 'Pinar de Chamartin');
  assert.equal(readable('Sants Estació'), 'Sants Estació', 'lo que no viene en mayúsculas no se toca');
  assert.equal(readable('L\'Illa'), 'L\'Illa');
  assert.equal(readable('Terrassa  Estació del nord '), 'Terrassa Estació del nord');
});

test('la accesibilidad del operador manda; la de Wikidata sólo si el GTFS no dice nada', () => {
  const stations = [
    { code: 'prueba:a', network: 'Metro de Prueba', accessible: true },
    { code: 'prueba:b', network: 'Metro de Prueba', accessible: null },
    { code: 'prueba:c', network: 'Metro de Prueba', accessible: null },
  ];
  const extras = new Map([['prueba:a', { accessible: false }], ['prueba:b', { accessible: 'partial', opened: 1995 }]]);
  const [a, b, c] = withNetworkExtras(stations, extras);
  assert.deepEqual([a.accessible, a.accessibleSource], [true, 'Metro de Prueba']);
  assert.deepEqual([b.accessible, b.accessibleSource, b.opened], ['partial', 'Wikidata', 1995]);
  assert.deepEqual([c.accessible, c.accessibleSource], [null, null]);
});
