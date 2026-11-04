import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIgnSismosSource } from '../../server/adapters/outbound/sources/ign-sismos.js';
import { ignPlace } from '../../server/adapters/outbound/sources/ign-place.js';

const INFO = 'http://www.ign.es/web/ign/portal/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=';
const feature = (lon, lat, props) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, geometry_name: 'geom', properties: { ultimo: 'false', ...props } });
// Respuesta real de la capa «Terremotos últimos 10 días» del 4-nov-2026, recortada.
const DOC = {
  type: 'FeatureCollection',
  totalFeatures: 'unknown',
  features: [
    feature(-7.4218, 36.6311, { fecha: '25/10/2026 10:37:19', info: `${INFO}es2026uxomc`, 'localización': 'GOLFO DE CÁDIZ', magnitud: 2.7, profundidad: 37 }),
    feature(-2.9721, 36.8114, { fecha: '04/11/2026 15:24:32', info: `${INFO}es2026vqfby`, 'localización': 'SW BERJA.AL', magnitud: 1.7, profundidad: 11 }),
    feature(-7.362, 37.2604, { fecha: '03/11/2026 15:47:27', info: `${INFO}es2026vokig`, 'localización': 'SW VILLABLANCA.H', magnitud: 1.5, profundidad: 0 }),
    feature(-3.5668, 37.0883, { fecha: '04/11/2026 03:23:55', info: `${INFO}es2026vpzza`, intensidad: '             III', 'localización': 'NE GÓJAR.GR', magnitud: 2.5, profundidad: 4 }),
    feature(-9.9333, 36.4823, { fecha: '26/10/2026 01:51:14', info: `${INFO}es2026uysqc`, 'localización': 'SW CABO DE SAN VICENTE', magnitud: 2.6, profundidad: 45 }),
    feature(-3.606, 37.1393, { fecha: '25/10/2026 19:42:12', info: `${INFO}es2026uygli`, intensidad: '             II', 'localización': 'E ARMILLA.GR', magnitud: 1.3, profundidad: 5 }), // pequeño
    feature(-3.6, 37.1, { fecha: '2026-11-04 10:00', info: `${INFO}es2026roto1`, 'localización': 'E GÓJAR.GR', magnitud: 2 }), // fecha rara
    feature(-3.6, 37.1, { fecha: '04/11/2026 10:00:00', info: 'https://otra.web/', 'localización': 'E GÓJAR.GR', magnitud: 2 }), // sin evid
    { type: 'Feature', geometry: null, properties: { fecha: '04/11/2026 10:00:00', info: `${INFO}es2026roto2`, magnitud: 2 } },
  ],
};

test('IGN: los terremotos de su capa de los últimos 10 días, desde magnitud 1,5, con su localización legible', async () => {
  let asked = null;
  const http = { json: async (url) => { asked = url; return DOC; } };
  const source = createIgnSismosSource({ http });
  const { events } = await source.fetch();

  const q = new URL(asked);
  assert.equal(q.origin + q.pathname, 'https://www.ign.es/wms-inspire/geofisica', 'el servicio oficial de visualización INSPIRE');
  assert.equal(q.searchParams.get('LAYERS'), 'Ultimos10dias');
  assert.equal(q.searchParams.get('FORMAT'), 'application/json;type=geojson');
  const [south, west, north, east] = q.searchParams.get('BBOX').split(',').map(Number);
  assert.ok(south < 28 && north > 43 && west < -18 && east > 4, 'en WMS 1.3.0 y EPSG:4326, latitud antes que longitud');
  assert.equal(source.url, asked);

  assert.deepEqual(events.map((e) => e.id), ['ign:es2026uxomc', 'ign:es2026vqfby', 'ign:es2026vokig', 'ign:es2026vpzza', 'ign:es2026uysqc']);
  const [cadiz, berja, villablanca, gojar, sanVicente] = events;
  // El de la captura del 4-nov: el EMSC lo llamaba «Estrecho de Gibraltar».
  assert.equal(cadiz.title, 'Terremoto M2.7 · Golfo de Cádiz');
  assert.equal(cadiz.description, 'Terremoto de magnitud 2.7 a 37 km de profundidad (Golfo de Cádiz), el 25/10/26, 11:37. Localizado por el Instituto Geográfico Nacional (IGN).',
    'la hora del IGN es UTC: en la península, una hora más en invierno (el cambio de hora fue ese mismo día a las 3)');
  assert.equal(cadiz.start, Date.UTC(2026, 9, 25, 10, 37, 19));
  assert.deepEqual([cadiz.lat, cadiz.lon, cadiz.magnitude, cadiz.category, cadiz.type, cadiz.severity], [36.6311, -7.4218, 2.7, 'sismo', 'terremoto', 'baja']);
  assert.equal(cadiz.url, 'https://www.ign.es/web/ign/portal/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=es2026uxomc');
  assert.equal(cadiz.backup, undefined, 'la fuente principal');
  // En tierra, en Almería (el EMSC: «Estrecho de Gibraltar»), y en Huelva (el EMSC: «Portugal»).
  assert.equal(berja.title, 'Terremoto M1.7 · al suroeste de Berja (Almería)');
  assert.match(berja.description, /^Terremoto de magnitud 1\.7 a 11 km de profundidad, al suroeste de Berja \(Almería\), el 4\/11\/26, 16:24\./);
  assert.equal(villablanca.title, 'Terremoto M1.5 · al suroeste de Villablanca (Huelva)');
  assert.match(villablanca.description, /^Terremoto de magnitud 1\.5, al suroeste/, 'profundidad 0: no se sabe, no se dice');
  assert.equal(gojar.title, 'Terremoto M2.5 · al noreste de Gójar (Granada)');
  assert.match(gojar.description, /\(IGN\)\. Se sintió con intensidad III\.$/);
  assert.equal(sanVicente.title, 'Terremoto M2.6 · al suroeste del cabo de San Vicente');
});

test('IGN: una respuesta sin terremotos o rara no rompe la lectura', async () => {
  for (const doc of [{}, { features: null }, { features: [null, 1, 'x', { geometry: { coordinates: 'x' } }] }, null]) {
    const { events } = await createIgnSismosSource({ http: { json: async () => doc } }).fetch();
    assert.deepEqual(events, []);
  }
});

test('la localización del IGN, legible (localizaciones reales de un año)', () => {
  const cases = {
    'NE GÓJAR.GR': 'al noreste de Gójar (Granada)',
    'GOLFO DE CÁDIZ': 'Golfo de Cádiz',
    'ALBORÁN OESTE': 'Alborán Oeste',
    'ATLÁNTICO-CANARIAS': 'Atlántico-Canarias',
    'CANARY ISLANDS, SPAIN REG': 'Canarias',
    'SW CABO DE SAN VICENTE': 'al suroeste del cabo de San Vicente',
    'N SIDI SLIMANE.MAC': 'al norte de Sidi Slimane (Marruecos)',
    'W VILA REAL.POR': 'al oeste de Vila Real (Portugal)',
    'SE ARICO.ITF': 'al sureste de Arico (Tenerife)',
    'NW GRANADA.GR': 'al noroeste de Granada',
    'SW EL PINAR DE EL HIERRO.IHI': 'al suroeste de El Pinar de El Hierro',
    'NE CHURRIANA DE LA VEGA.GR': 'al noreste de Churriana de la Vega (Granada)',
    'N HUÉRCAL-OVERA.AL': 'al norte de Huércal-Overa (Almería)',
    'N MONTEMOR-O-NOVO.POR': 'al norte de Montemor-o-Novo (Portugal)',
    'SE CALDES D ESTRAC.B': "al sureste de Caldes d'Estrac (Barcelona)",
    'E L AMETLLA DE MAR.T': "al este de L'Ametlla de Mar (Tarragona)",
    'SW VIELHA E MIJARAN.L': 'al suroeste de Vielha e Mijaran (Lleida)',
    'SE BENICASIM/BENICÀSSIM.CS': 'al sureste de Benicasim/Benicàssim (Castellón)',
    'NW FOLGOSO DO COUREL.LU': 'al noroeste de Folgoso do Courel (Lugo)',
    'S ST ETIENNE DE BAIGORRY.FRA': 'al sur de St Etienne de Baigorry (Francia)',
    'SE TABERNAS.XX': 'al sureste de Tabernas', // un sufijo que no conocemos no se pone
    // Cortados a 30 caracteres: ni el sufijo (podría ser otro) ni lo que quede a medias.
    'NW SALVATIERRA DE LOS BARROS.B': 'al noroeste de Salvatierra de los Barros',
    'E SAN SEBASTIÁN DE LA GOMERA.I': 'al este de San Sebastián de La Gomera',
    'SW KARRANTZA HARANA/VALLE DE C': 'al suroeste de Karrantza Harana',
    'SW SAN MARTÍN DE LA VIRGEN DE': 'al suroeste de San Martín de la Virgen',
    'N CASTILBLANCO DE LOS ARROYOS.': 'al norte de Castilblanco de los Arroyos',
    'E ESPARZA DE SALAZAR/ESPARTZA': 'al este de Esparza de Salazar', // 29: el corte cayó en un espacio
  };
  for (const [raw, text] of Object.entries(cases)) assert.equal(ignPlace(raw)?.text, text, raw);
  assert.equal(ignPlace('NE GÓJAR.GR').near, true);
  assert.equal(ignPlace('GOLFO DE CÁDIZ').near, false);
  for (const raw of ['', '   ', null, undefined]) assert.equal(ignPlace(raw), null);
});
