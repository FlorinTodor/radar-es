// Catálogo de estaciones de Renfe: la lista oficial (Latin-1, ';') aporta dirección, provincia y
// ancho métrico; los GTFS, los nombres bien escritos y si la estación es accesible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { RENFE_FILES, createRenfeStationCatalog } from '../../server/adapters/outbound/stations/renfe-station-catalog.js';

const latin1 = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const CSV = latin1([
  '"CODIGO";"DESCRIPCION";"LATITUD";"LONGITUD";"DIRECION";"CP";"POBLACION";"PROVINCIA";"PAIS";"CERCANIAS";"ANCHO MÉTRICO";"COMUN"',
  '"15211";"OVIEDO";"43.3663577";"-5.8548380";"Calle Uría  S/N";"33012";"OVIEDO";"ASTURIAS";"ESPAÑA";"SI";"NO";""',
  '"05100";"LLANES";"43.4195";"-4.7553";"Avda. La Estación";"33500";"LLANES";"ASTURIAS";"ESPAÑA";"NO";"SI";""',
].join('\r\n'));
const gtfs = (rows) => zipSync({ 'stops.txt': strToU8(['stop_id,stop_name,stop_lat,stop_lon,wheelchair_boarding', ...rows].join('\n')) });

test('cada estación lleva dirección, provincia, ancho métrico y accesibilidad', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'estaciones-'));
  try {
    const files = {
      [RENFE_FILES.stations]: CSV,
      [RENFE_FILES.cercanias]: gtfs(['15211,Oviedo,43.3663577,-5.8548380,1', '99999,Sólo en GTFS,43.1,-5.1,2']),
      [RENFE_FILES.largaDistancia]: gtfs([]),
    };
    const catalog = createRenfeStationCatalog({
      cache: { bytes: async (url) => files[url] },
      cacheDir: pathToFileURL(`${dir}/`),
      log: { info() {}, warn() {} },
    });
    await catalog.load();
    assert.deepEqual(catalog.get('15211'), {
      code: '15211', name: 'Oviedo', place: 'Oviedo', province: 'Asturias', address: 'Calle Uría S/N', postalCode: '33012',
      lat: 43.3663577, lon: -5.854838, cercanias: true, metricGauge: false, accessible: true, accessibleSource: 'Renfe',
    });
    assert.equal(catalog.get('05100').metricGauge, true);
    assert.equal(catalog.get('05100').accessible, null);
    assert.equal(catalog.get('99999').accessible, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('se quitan las estaciones repetidas sin horarios, pero no las distintas que están cerca', async () => {
  const { withoutDuplicates } = await import('../../server/adapters/outbound/stations/renfe-station-catalog.js');
  const st = (code, name, lat, lon) => ({ code, name, lat, lon });
  const list = [
    st('18000', 'Madrid-Atocha Cercanías', 40.4066191, -3.6894391),
    st('98000', 'Madrid - Atocha Cercanías', 40.406528, -3.689373), // misma estación, sin horarios
    st('15211', 'Oviedo', 43.3663577, -5.854838),
    st('99173', 'Oviedo-Tur', 43.3669, -5.8541), // tren turístico, a 71 m
    st('13200', 'Bilbao-Intermod. Abando Indalecio Prieto', 43.2614, -2.9278),
    st('05451', 'Bilbao la Concordia', 43.2603, -2.9258), // otra estación, a 176 m
  ];
  const scheduled = new Set(['18000', '15211', '13200']);
  assert.deepEqual(withoutDuplicates(list, scheduled).map((s) => s.code), ['18000', '15211', '13200', '05451']);
});
