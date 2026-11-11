// La carretera de cada incidencia de tráfico (y, la de la DGT, su provincia), tal como la dan sus fuentes: el bot de
// Telegram avisa por ellas a quien sigue una carretera o una provincia. El título y la descripción no cambian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDgt } from '../../server/adapters/outbound/sources/dgt.js';
import { createSctSource, createTraficoEuskadiSource } from '../../server/adapters/outbound/sources/trafico-autonomico.js';

const NOW = Date.parse('2026-11-10T21:00:00Z');

// Un registro DATEX II como los del fichero real de la DGT, recortado: con municipio y provincia.
const DATEX = `<?xml version="1.0" encoding="UTF-8"?>
<d2:payload xmlns:d2="d2" xmlns:sit="sit" xmlns:com="com" xmlns:loc="loc" xmlns:lse="lse">
  <com:publicationTime>2026-11-10T22:00:00.000+01:00</com:publicationTime>
  <sit:situation id="s1"><sit:situationRecord id="r1" version="1">
    <sit:situationRecordVersionTime>2026-11-10T21:55:00.000+01:00</sit:situationRecordVersionTime>
    <sit:severity>highest</sit:severity>
    <sit:validity><com:validityTimeSpecification><com:overallStartTime>2026-11-10T21:52:00.000+01:00</com:overallStartTime></com:validityTimeSpecification></sit:validity>
    <sit:cause><sit:causeType>accident</sit:causeType></sit:cause>
    <sit:roadOrCarriagewayOrLaneManagementType>roadClosed</sit:roadOrCarriagewayOrLaneManagementType>
    <sit:locationReference><loc:supplementaryPositionalDescription><loc:roadInformation><loc:roadName>A-4</loc:roadName></loc:roadInformation></loc:supplementaryPositionalDescription>
      <loc:tpegLinearLocation><loc:from><loc:pointCoordinates><loc:latitude>40.03</loc:latitude><loc:longitude>-3.6</loc:longitude></loc:pointCoordinates>
        <loc:_tpegNonJunctionPointExtension><loc:extendedTpegNonJunctionPoint><lse:kilometerPoint>49.2</lse:kilometerPoint>
          <lse:municipality>Aranjuez</lse:municipality><lse:province>Madrid</lse:province></loc:extendedTpegNonJunctionPoint></loc:_tpegNonJunctionPointExtension>
      </loc:from></loc:tpegLinearLocation></sit:locationReference>
  </sit:situationRecord></sit:situation>
  <sit:situation id="s2"><sit:situationRecord id="r2" version="1">
    <sit:validity><com:validityTimeSpecification><com:overallStartTime>2026-11-10T21:00:00.000+01:00</com:overallStartTime></com:validityTimeSpecification></sit:validity>
    <sit:cause><sit:causeType>obstruction</sit:causeType></sit:cause>
    <sit:locationReference><loc:pointByCoordinates><loc:pointCoordinates><loc:latitude>40.5</loc:latitude><loc:longitude>-3.7</loc:longitude></loc:pointCoordinates></loc:pointByCoordinates></sit:locationReference>
  </sit:situationRecord></sit:situation>
</d2:payload>`;

test('DGT: la carretera y la provincia de cada incidencia, sin cambiar su título ni su descripción', () => {
  const [accident, unnamed] = parseDgt(DATEX, NOW).events;
  assert.equal(accident.road, 'A-4');
  assert.equal(accident.province, 'Madrid');
  assert.equal(accident.closed, true);
  assert.equal(accident.severity, 'muy alta');
  assert.equal(accident.title, 'Accidente · A-4 km 49.2');
  assert.equal(accident.description, 'Aranjuez, Madrid · Carretera cortada');
  assert.equal(unnamed.road, null, 'sin carretera, null');
  assert.equal(unnamed.province, null);
});

test('Servei Català de Trànsit y Tráfico de Euskadi: su carretera, tal cual', async () => {
  const gml = `<wfs:FeatureCollection xmlns:wfs="wfs" xmlns:gml="gml" xmlns:cite="cite"><gml:featureMember><cite:mct2_v_afectacions_data>
    <cite:identificador>152467501</cite:identificador><cite:descripcio_tipus>Retenció</cite:descripcio_tipus><cite:nivell>2</cite:nivell>
    <cite:carretera>AP-2</cite:carretera><cite:pk_inici>205</cite:pk_inici><cite:descripcio>Calçada tallada</cite:descripcio>
    <cite:geom><gml:Point><gml:coordinates>0.68,41.62</gml:coordinates></gml:Point></cite:geom>
  </cite:mct2_v_afectacions_data></gml:featureMember></wfs:FeatureCollection>`;
  const [sct] = (await createSctSource({ http: { text: async () => gml }, now: () => NOW }).fetch()).events;
  assert.deepEqual([sct.road, sct.closed, sct.title], ['AP-2', true, 'Retención · AP-2 km 205.0']);

  const json = async () => ({ totalPages: 1, incidences: [
    { incidenceId: 'e1', incidenceType: 'Accidente', cause: 'Alcance', startDate: '2026-11-10T21:58:00', latitude: 43.07, longitude: -2.46, incidenceLevel: 'Amarillo', road: 'GI-627', pkStart: 38 },
    { incidenceId: 'e2', incidenceType: 'Obras', startDate: '2026-11-10T08:00:00', latitude: 43.26, longitude: -2.93, incidenceLevel: 'Blanco' },
  ] });
  const [crash, works] = (await createTraficoEuskadiSource({ http: { json }, now: () => NOW }).fetch()).events;
  assert.deepEqual([crash.road, crash.title], ['GI-627', 'Alcance · GI-627 km 38.0']);
  assert.equal(works.road, null, 'las obras de una ciudad, sin carretera');
});

test('Tráfico de Euskadi, las de los ayuntamientos: su nombre (sin «undefined» ni «km 0.0») y fuera las que ya han acabado', async () => {
  // NOW es el 10-11-2026 a las 22:00 en Madrid.
  const json = async () => ({ totalPages: 1, incidences: [
    // Vitoria-Gasteiz: sin causa ni tipo, sólo su nombre.
    { incidenceId: '2903', sourceId: '6', cityTown: 'Vitoria-Gasteiz', startDate: '2026-11-10T21:30', endDate: '2026-11-10T23:00',
      pkStart: '0.0', direction: 'LA PROVINCIA, PLAZA DE', incidenceName: 'Manifestación: Huelga General', latitude: '42.84', longitude: '-2.67' },
    // Bilbao: obra con su nombre, con entidades HTML.
    { incidenceId: 'b1', sourceId: '5', incidenceType: 'Obra', cause: 'Obra', cityTown: 'Bilbao', startDate: '2026-11-01T00:00', endDate: '2026-11-12T00:00',
      pkStart: '0.0', incidenceName: 'OBRAS PARA REMODELACI&#211;N TUNEL KARMELO BERNAOLA', latitude: '43.26', longitude: '-2.93' },
    // Ya acabada.
    { incidenceId: '2904', sourceId: '6', cityTown: 'Vitoria-Gasteiz', startDate: '2026-11-10T19:00', endDate: '2026-11-10T20:00',
      pkStart: '0.0', incidenceName: 'Manifestación', latitude: '42.86', longitude: '-2.67' },
  ] });
  const events = (await createTraficoEuskadiSource({ http: { json }, now: () => NOW }).fetch()).events;
  assert.deepEqual(events.map((e) => e.id), ['euskadi:2903', 'euskadi:b1'], 'la que acabó a las 20:00, fuera');
  const [demo, works] = events;
  assert.equal(demo.title, 'Manifestación: Huelga General');
  assert.equal(demo.description, 'Vitoria-Gasteiz · sentido LA PROVINCIA, PLAZA DE');
  assert.equal(works.title, 'Obra');
  assert.equal(works.description, 'OBRAS PARA REMODELACIÓN TUNEL KARMELO BERNAOLA · Obra · Bilbao');
});
