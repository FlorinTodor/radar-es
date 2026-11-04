// Hasta cuándo se muestra cada incidencia: el fin previsto de las obras de la DGT, una hora sin noticias
// de una fuente de tráfico caída y dos días los terremotos (ver domain/carreteras.js y domain/sismos.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDgtSource, parseDgt } from '../../server/adapters/outbound/sources/dgt.js';
import { createSctSource, createTraficoEuskadiSource } from '../../server/adapters/outbound/sources/trafico-autonomico.js';
import { createIgnSismosSource } from '../../server/adapters/outbound/sources/ign-sismos.js';
import { createEmscSismosSource } from '../../server/adapters/outbound/sources/emsc-sismos.js';
import { inForce } from '../../server/domain/model.js';
import { roadExpires } from '../../server/domain/carreteras.js';
import { quakeExpires } from '../../server/domain/sismos.js';

const NOW = Date.parse('2026-11-04T16:20:00Z');
const HOUR = 3600_000;

// Registro DATEX II como los del fichero real de la DGT del 4-nov-2026, recortado.
const record = ({ id, cause, start, end, version, road, km }) => `
  <sit:situation id="s${id}"><sit:situationRecord id="${id}" version="1">
    <sit:situationRecordVersionTime>${version}</sit:situationRecordVersionTime>
    <sit:validity><com:validityStatus>active</com:validityStatus><com:validityTimeSpecification>
      <com:overallStartTime>${start}</com:overallStartTime>${end ? `<com:overallEndTime>${end}</com:overallEndTime>` : ''}
    </com:validityTimeSpecification></sit:validity>
    <sit:cause><sit:causeType>${cause}</sit:causeType></sit:cause>
    <sit:locationReference><loc:supplementaryPositionalDescription><loc:roadInformation><loc:roadName>${road}</loc:roadName></loc:roadInformation></loc:supplementaryPositionalDescription>
      <loc:tpegLinearLocation><loc:from><loc:pointCoordinates><loc:latitude>40.1</loc:latitude><loc:longitude>-3.2</loc:longitude></loc:pointCoordinates>
        <loc:_tpegNonJunctionPointExtension><loc:extendedTpegNonJunctionPoint><lse:kilometerPoint>${km}</lse:kilometerPoint></loc:extendedTpegNonJunctionPoint></loc:_tpegNonJunctionPointExtension>
      </loc:from></loc:tpegLinearLocation></sit:locationReference>
  </sit:situationRecord></sit:situation>`;
const DATEX = `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="d2" xmlns:sit="sit" xmlns:com="com" xmlns:loc="loc" xmlns:lse="lse">
  <com:publicationTime>2026-11-04T17:17:19.584+01:00</com:publicationTime>
  ${record({ id: 'obra', cause: 'roadMaintenance', start: '2025-11-10T10:56:00.000+01:00', end: '2026-11-05T20:00:00.000+01:00', version: '2025-11-10T10:56:48.000+01:00', road: 'A-67', km: 192.3 })}
  ${record({ id: 'acabada', cause: 'roadMaintenance', start: '2026-09-01T08:00:00.000+02:00', end: '2026-09-21T00:00:00.000+02:00', version: '2026-09-01T08:00:00.000+02:00', road: 'N-332', km: 12 })}
  ${record({ id: 'accidente', cause: 'accident', start: '2026-11-04T16:05:26.000+01:00', version: '2026-11-04T16:10:00.000+01:00', road: 'A-3', km: 80 })}
</d2:payload>`;

test('DGT: las obras con su fin previsto y su última revisión; la que ya pasó su fin no se muestra', () => {
  const { events } = parseDgt(DATEX, NOW);
  const byId = Object.fromEntries(events.map((e) => [e.id.replace('dgt:', ''), e]));

  assert.equal(byId.obra.end, Date.parse('2026-11-05T20:00:00+01:00'));
  assert.equal(byId.obra.updated, Date.parse('2025-11-10T10:56:48+01:00'));
  assert.equal(byId.obra.expires, NOW + HOUR, 'su fin está lejos: vale mientras la DGT la siga publicando');

  assert.equal(byId.acabada.expires, byId.acabada.end, 'acabó el 21-sep');
  assert.equal(inForce(byId.acabada, NOW), false, 'aunque la DGT la siga publicando');

  assert.equal(byId.accidente.end, null, 'los accidentes no traen fin');
  assert.equal(byId.accidente.expires, NOW + HOUR);
  assert.deepEqual(events.filter((e) => inForce(e, NOW)).map((e) => e.id), ['dgt:obra', 'dgt:accidente']);
});

test('DGT: si deja de responder, lo último que publicó sale del mapa a la hora; si vuelve, cuenta desde la nueva lectura', async () => {
  let t = NOW;
  const source = createDgtSource({ http: { text: async () => DATEX }, now: () => t });
  const first = await source.fetch();
  const accident = (r) => r.events.find((e) => e.id === 'dgt:accidente');
  assert.equal(inForce(accident(first), NOW + HOUR - 1), true, 'la DGT cae: aún se muestra a los 59 min');
  assert.equal(inForce(accident(first), NOW + HOUR), false, 'una hora sin noticias: fuera');

  t = NOW + 30 * 60_000;
  assert.equal(accident(await source.fetch()).expires, t + HOUR, 'cada lectura la renueva');
});

test('DGT: el hilo de cálculo recibe la hora de la lectura (la función pura no mira el reloj)', async () => {
  const runs = [];
  const pool = { run: async (task, args) => { runs.push([task, args[1]]); return parseDgt(...args); } };
  const { events } = await createDgtSource({ http: { text: async () => DATEX }, pool, now: () => NOW }).fetch();
  assert.deepEqual(runs, [['dgt', NOW]]);
  assert.equal(events.find((e) => e.id === 'dgt:accidente').expires, NOW + HOUR);
});

test('roadExpires: el fin previsto o una hora sin volver a leerla, lo que llegue antes', () => {
  assert.equal(roadExpires(null, NOW), NOW + HOUR);
  assert.equal(roadExpires(undefined, NOW), NOW + HOUR);
  assert.equal(roadExpires(NOW + 10 * 60_000, NOW), NOW + 10 * 60_000, 'acaba en diez minutos');
  assert.equal(roadExpires(NOW - 1, NOW), NOW - 1, 'ya acabó');
});

test('Cataluña y Euskadi no dan el fin: se muestran mientras su fuente las publique, y una hora si se cae', async () => {
  const gml = `<wfs:FeatureCollection xmlns:wfs="wfs" xmlns:gml="gml" xmlns:cite="cite"><gml:featureMember><cite:mct2_v_afectacions_data>
    <cite:identificador>123</cite:identificador><cite:descripcio_tipus>Obres</cite:descripcio_tipus><cite:nivell>2</cite:nivell>
    <cite:carretera>C-17</cite:carretera><cite:pk_inici>10</cite:pk_inici><cite:data>Wed, 04 Nov 2026 08:00:00 GMT</cite:data>
    <cite:geom><gml:Point><gml:coordinates>2.2,41.6</gml:coordinates></gml:Point></cite:geom>
  </cite:mct2_v_afectacions_data></gml:featureMember></wfs:FeatureCollection>`;
  const sct = await createSctSource({ http: { text: async () => gml }, now: () => NOW }).fetch();
  assert.deepEqual(sct.events.map((e) => [e.id, e.expires]), [['sct:123', NOW + HOUR]]);

  const asked = [];
  const json = async (url) => {
    asked.push(url);
    return { totalPages: 1, incidences: [{ incidenceId: 'e1', incidenceType: 'Accidente', startDate: '2026-11-04T17:05:26', latitude: 43.2, longitude: -2.9, incidenceLevel: 'Amarillo', road: 'AP-8' }] };
  };
  const eus = await createTraficoEuskadiSource({ http: { json }, now: () => NOW }).fetch();
  assert.match(asked[0], /\/byDate\/2026\/11\/04\?_page=1$/, 'el día de la lectura, en hora de Madrid');
  assert.deepEqual(eus.events.map((e) => [e.id, e.expires]), [['euskadi:e1', NOW + HOUR]]);
});

test('Terremotos: se muestran dos días, también si su fuente deja de responder', async () => {
  // La capa «Terremotos últimos 10 días» del IGN (ign-sismos.js), en GeoJSON.
  const quake = (evid, fecha) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-7.127, 36.4941] },
    properties: { fecha, info: `http://www.ign.es/web/ign/portal/ultimos-terremotos/-/ultimos-terremotos/getDetails?evid=${evid}`, 'localización': 'GOLFO DE CÁDIZ', magnitud: 3.5, profundidad: 10 } });
  const doc = { type: 'FeatureCollection', features: [quake('es2026vieja', '26/10/2026 17:29:07'), quake('es2026nueva', '04/11/2026 10:00:00')] };
  const { events } = await createIgnSismosSource({ http: { json: async () => doc } }).fetch();
  const [vieja, nueva] = events;
  assert.equal(nueva.expires, Date.parse('2026-11-04T10:00:00Z') + 48 * HOUR);
  assert.equal(inForce(vieja, NOW), false, 'el del 26-oct ya no sale (la capa del IGN trae diez días)');
  assert.equal(inForce(nueva, NOW), true);
  assert.equal(inForce(nueva, Date.parse('2026-11-06T10:00:00Z')), false, 'a las 48 h sale del mapa');
  assert.equal(quakeExpires(0), 48 * HOUR);

  let asked = null;
  const emsc = createEmscSismosSource({ http: { json: async (url) => { asked = url; return { features: [] }; } }, now: () => NOW });
  await emsc.fetch();
  assert.equal(new URL(asked).searchParams.get('starttime'), '2026-11-02T16:20:00', 'al EMSC sólo se le piden esos dos días');
});
