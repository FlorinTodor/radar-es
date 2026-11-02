// Fecha de actualización de los trazados de cada red: la licencia del NAP pide conservarla y
// mostrarla junto a los datos (en /legal y en la pestaña Fuentes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { NETWORKS, createGtfsNetworkCatalog } from '../../server/adapters/outbound/network/gtfs-network-catalog.js';
import { madridLocalToMs } from '../../server/adapters/outbound/sources/parse.js';
import { createHttpServer } from '../../server/adapters/inbound/http/http-server.js';
import { renderSources } from '../../public/js/panels.js';

const csv = (rows) => strToU8(rows.join('\n'));
const networkGtfs = () => zipSync({
  'routes.txt': csv(['route_id,route_short_name,route_long_name,route_type,route_color', 'R1,L1,Una línea,1,2E7D32']),
  'trips.txt': csv(['route_id,service_id,trip_id,shape_id', 'R1,S,T1,sh']),
  'shapes.txt': csv(['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence', 'sh,40.40,-3.70,1', 'sh,40.45,-3.65,2']),
});
const quiet = { info() {}, warn() {} };
const [[cercaniasId, cercanias, cercaniasDataset], [ligeroId, ligero]] = NETWORKS;

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'trazados-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('cada red lleva la atribución y la fecha de su horario en el NAP', async (t) => {
  const dir = await tempDir(t);
  const asked = [];
  const nap = {
    enabled: true,
    gtfs: async (id) => { if (id !== cercaniasId && id !== ligeroId) throw new Error('no disponible'); return networkGtfs(); },
    updatedAt: async (dataset, ficheroId) => { asked.push([dataset, ficheroId]); return ficheroId === cercaniasId ? '2026-11-02T06:21:27' : null; },
  };
  const catalog = createGtfsNetworkCatalog({ nap, cache: { bytes: async () => { throw new Error('sin red'); } }, cacheDir: pathToFileURL(`${dir}/`), log: quiet });
  await catalog.load();
  assert.deepEqual(catalog.sources(), [
    { name: cercanias, credit: 'Powered by MITRAMS (Punto de Acceso Nacional) · Origen de los datos: Renfe Operadora', updated: madridLocalToMs('2026-11-02T06:21:27') },
    { name: ligero, credit: 'Powered by MITRAMS (Punto de Acceso Nacional) · Powered by CRTM', updated: null },
  ], 'sólo las redes que se dibujan; sin fecha, null');
  assert.ok(asked.some(([dataset, id]) => dataset === cercaniasDataset && id === cercaniasId), 'pregunta por su conjunto de datos');
  const saved = JSON.parse(await readFile(join(dir, 'trazados-red-v3.json'), 'utf8'));
  assert.equal(saved.updated[cercanias], '2026-11-02T06:21:27', 'la fecha se guarda con los trazados');
});

test('una copia guardada sin fechas las pide al NAP sin rehacer los trazados', async (t) => {
  const dir = await tempDir(t);
  const feature = { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-3.7, 40.4], [-3.6, 40.5]] }, properties: { network: cercanias, line: 'C1' } };
  await writeFile(join(dir, 'trazados-red-v3.json'), JSON.stringify({ type: 'FeatureCollection', features: [feature], builtAt: Date.now(), failed: [] }));
  const nap = {
    enabled: true,
    gtfs: async () => { throw new Error('no debería descargar nada'); },
    updatedAt: async () => '2026-10-30T10:00:00',
  };
  const catalog = createGtfsNetworkCatalog({ nap, cache: {}, cacheDir: pathToFileURL(`${dir}/`), log: quiet });
  await catalog.load();
  assert.deepEqual(catalog.sources().map((s) => [s.name, s.updated]), [[cercanias, madridLocalToMs('2026-10-30T10:00:00')]]);
});

test('/api/lines/sources sirve el origen de los trazados con la caché de los catálogos', async (t) => {
  const list = [{ name: cercanias, credit: 'Powered by MITRAMS · Renfe', updated: 1 }];
  const server = createHttpServer({ query: { lineSources: () => list }, log: { error() {} }, publicDir: '/nonexistent', vendorDirs: {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/lines/sources`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public, max-age=600/);
  assert.deepEqual(await res.json(), list);
});

test('la pestaña Fuentes enseña la fecha de cada trazado', () => {
  const el = { innerHTML: '' };
  renderSources(el, [], [{ name: 'Metro Bilbao', credit: 'Powered by MITRAMS (Punto de Acceso Nacional) · Metro Bilbao', updated: Date.UTC(2026, 10, 1, 7, 34) }]);
  assert.match(el.innerHTML, /Trazados de las líneas/);
  assert.match(el.innerHTML, /Metro Bilbao/);
  assert.match(el.innerHTML, /horario actualizado el 0?1\/11,? 08:34/);
});
