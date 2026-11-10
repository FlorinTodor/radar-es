// Redes de tranvía cuyo horario en el NAP declara alguna línea con otro tipo: el T2 del Trambaix llegaba como
// tren (route_type 2) y salía en el mapa como «Cercanías / Rodalies»; la línea 4 del TRAM d'Alacant, como
// metro. Con el fichero del NAP, todas sus líneas salen como tranvía en los vehículos, los trazados y las
// estaciones, y la atribución lo dice. Las demás redes siguen con el tipo que declaran.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { NETWORK_MODE, modeFixNote, modeOf } from '../../server/adapters/outbound/gtfs/gtfs-modes.js';
import { parseSchedule, unpackSchedule, packSchedule } from '../../server/adapters/outbound/gtfs/gtfs-schedule.js';
import { buildNetwork } from '../../server/adapters/outbound/network/gtfs-network-catalog.js';
import { STATION_NETWORKS, buildStations } from '../../server/adapters/outbound/stations/network-station-catalog.js';

const TRAM_BAIX = 1329;
const csv = (rows) => strToU8(`${rows.join('\n')}\n`);

// Como el routes.txt del Trambaix: el T2 con route_type 2.
const routes = csv(['route_id,agency_id,route_short_name,route_long_name,route_type,route_color',
  '1,1,T1,Bon Viatge-Francesc Macià,0,FF0D0D', '2,1,T2,Llevant_Les Planes-Francesc Macià,2,80FF80', '9,1,B9,Autobús,3,']);

test('modeOf: las redes de TRAM, todas como tranvía; las demás y los autobuses, como dicen', () => {
  assert.equal(modeOf(2), 'cercanias');
  assert.equal(modeOf(2, TRAM_BAIX), 'tranvia');
  assert.equal(modeOf('1', 1167), 'tranvia', "la línea 4 del TRAM d'Alacant, declarada como metro");
  assert.equal(modeOf(0, 1330), 'tranvia');
  assert.equal(modeOf(3, TRAM_BAIX), null, 'un autobús en su horario sigue fuera');
  assert.equal(modeOf(2, 1130), 'cercanias', 'Cercanías Renfe no cambia');
  assert.equal(modeOf(1, 1328), 'metro', 'Metro de Barcelona no cambia');
  assert.deepEqual([...NETWORK_MODE.keys()].sort(), [1167, 1329, 1330]);
});

test('la atribución de esas redes dice que se corrige el tipo; la de las demás, nada', () => {
  assert.match(modeFixNote(TRAM_BAIX), /todas sus líneas como tranvía/);
  assert.equal(modeFixNote(1130), '');
  assert.equal(modeFixNote(null), '');
});

test('vehículos: el T2 del horario de TRAM Baix circula como tranvía', async () => {
  const zip = zipSync({
    'agency.txt': csv(['agency_id,agency_name', '1,TRAM']),
    'routes.txt': routes,
    'trips.txt': csv(['route_id,service_id,trip_id', '1,S,V1', '2,S,V2']),
    'calendar.txt': csv(['service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date', 'S,1,1,1,1,1,1,1,20260101,20271231']),
    'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon', 'A,Francesc Macià,41.392,2.143', 'B,Montesa,41.370,2.065']),
    'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence',
      'V1,12:55:00,12:55:00,A,1', 'V1,13:05:00,13:05:00,B,2', 'V2,12:55:00,12:55:00,B,1', 'V2,13:05:00,13:05:00,A,2']),
  });
  const days = { today: { ymd: '20261110', weekday: 1 }, yesterday: { ymd: '20261109', weekday: 0 } };
  const modes = async (feed) => {
    const s = unpackSchedule(packSchedule(await parseSchedule(zip, null, days, feed)).value);
    return [...new Set(s.trips.map((t) => `${t.route.line}:${t.route.mode}`))].sort();
  };
  assert.deepEqual(await modes({ ficheroId: TRAM_BAIX }), ['T1:tranvia', 'T2:tranvia']);
  assert.deepEqual(await modes({ ficheroId: 9999 }), ['T1:tranvia', 'T2:cercanias'], 'sin corrección, el tipo del fichero');
});

test('trazados: el T2 de TRAM Baix se dibuja como tranvía', async () => {
  const zip = zipSync({
    'routes.txt': routes,
    'trips.txt': csv(['route_id,service_id,trip_id,shape_id', '1,S,V1,sh1', '2,S,V2,sh2']),
    'shapes.txt': csv(['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
      'sh1,41.392,2.143,1', 'sh1,41.380,2.100,2', 'sh2,41.392,2.143,1', 'sh2,41.370,2.065,2']),
  });
  const features = await buildNetwork(zip, 'TRAM Baix');
  assert.deepEqual(features.map((f) => `${f.properties.line}:${f.properties.mode}`).sort(), ['T1:tranvia', 'T2:tranvia']);
});

test('estaciones: las del T2 son de tranvía', async () => {
  const zip = zipSync({
    'routes.txt': routes,
    'trips.txt': csv(['route_id,service_id,trip_id', '2,S,V2']),
    'stops.txt': csv(['stop_id,stop_name,stop_lat,stop_lon,location_type', 'B,Montesa,41.370,2.065,0']),
    'stop_times.txt': csv(['trip_id,arrival_time,departure_time,stop_id,stop_sequence', 'V2,12:55:00,12:55:00,B,1']),
  });
  const net = STATION_NETWORKS.find((n) => n.ficheroId === TRAM_BAIX);
  const [montesa] = await buildStations(zip, net);
  assert.equal(montesa.name, 'Montesa');
  assert.equal(montesa.mode, 'tranvia');
  assert.deepEqual(montesa.lines.map((l) => l.line), ['T2']);
});
