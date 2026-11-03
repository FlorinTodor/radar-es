// Vías del IGN: se descargan por cuadrículas (las que no caben en una respuesta o fallan, en cuatro), un
// tramo que llega en dos cuadrículas cuenta una vez, se guardan en disco una vez al mes y, si el IGN falla,
// se sigue con la copia guardada.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFileCache } from '../../server/adapters/outbound/http/file-cache.js';
import { createIgnRailNetwork, readRailwayLinks } from '../../server/adapters/outbound/network/ign-rail-network.js';

const quiet = { info() {}, warn() {}, error() {} };
/** Respuesta del WFS con estos tramos: [id, [[lon, lat], …]] (el GML da «lat lon»). */
const gml = (links, returned = links.length) => `<?xml version="1.0"?><wfs:FeatureCollection numberMatched="unknown" numberReturned="${returned}">${
  links.map(([id, pts]) => `<wfs:member><tn-ra:RailwayLink xmlns:tn-ra="http://inspire.ec.europa.eu/schemas/tn-ra/4.0" gml:id="${id}">`
    + `<net:centrelineGeometry><gml:LineString gml:id="${id}_G" srsName="http://www.opengis.net/def/crs/EPSG/0/4258">`
    + `<gml:posList>${pts.map(([lon, lat]) => `${lat} ${lon}`).join(' ')}</gml:posList></gml:LineString></net:centrelineGeometry>`
    + '</tn-ra:RailwayLink></wfs:member>').join('')}</wfs:FeatureCollection>`;
const bbox = (url) => new URL(url).searchParams.get('BBOX').split(',').slice(0, 4).map(Number); // s, w, n, e

test('lee los tramos del GML en [lon, lat], redondeados a 5 decimales, como los leería Number', () => {
  const read = (xml) => {
    const out = [];
    const returned = readRailwayLinks(xml, (id, line, points) => out.push({ id, line: Array.from(line.subarray(0, points * 2)) }));
    return { out, returned };
  };
  const { out, returned } = read(gml([['L1', [[-3.7, 40.4], [-3.69, 40.41]]], ['L2', [[-3.6, 40.5], [-3.59, 40.5]]]]));
  assert.equal(returned, 2);
  assert.deepEqual(out.map((l) => l.id), ['L1', 'L2']);
  assert.deepEqual(out[0].line, [-3.7, 40.4, -3.69, 40.41]);
  // Muchas cifras, enteros, signo, exponente y algo que no es un número (ese punto se salta).
  const raw = '40.123456789012 -3.987654321098 41 2 -0.000004999 0.5e1 x 1 39.5 -0.1234567890123456789';
  const xml = `<wfs:FeatureCollection numberReturned="1"><tn-ra:RailwayLink gml:id="R"><gml:posList>${raw}</gml:posList></tn-ra:RailwayLink></wfs:FeatureCollection>`;
  const v = raw.split(' ').map(Number);
  const expected = [];
  for (let i = 0; i + 1 < v.length; i += 2) if (Number.isFinite(v[i]) && Number.isFinite(v[i + 1])) expected.push(Math.round(v[i + 1] * 1e5) / 1e5, Math.round(v[i] * 1e5) / 1e5);
  assert.deepEqual(read(xml).out[0].line, expected);
});

test('descarga por cuadrículas, reintenta, guarda la copia y sigue con ella si el IGN falla', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ign-'));
  try {
    let now = Date.parse('2026-11-03T12:00:00Z');
    const asked = [];
    let cut = 1; // la primera respuesta llega cortada
    let down = false;
    const http = {
      bytes: async (url) => {
        asked.push(url);
        if (down) throw new Error('HTTP 503 en servicios.idee.es');
        if (cut-- > 0) throw new TypeError('terminated');
        const [s, w] = bbox(url);
        // La cuadrícula del suroeste dice que no le caben: se parte en cuatro.
        if (w === -4 && s === 40 && bbox(url)[3] === -3.5) return new TextEncoder().encode(gml([], 5000));
        // Un tramo que cruza el borde llega en las dos cuadrículas de al lado.
        const links = [[`T${w},${s}`, [[w + 0.1, s + 0.1], [w + 0.11, s + 0.11]]], ['BORDE', [[-3.51, 40.2], [-3.49, 40.2]]]];
        return new TextEncoder().encode(gml(links));
      },
    };
    const cache = createFileCache({ http, dir: pathToFileURL(`${dir}/`), log: quiet });
    const ign = createIgnRailNetwork({ http, cache, log: quiet, areas: [[-4, 40, -3, 40.5]], tileDeg: 0.5, minLinks: 3, now: () => now, retryMs: 0 });
    assert.equal(ign.pending(), true, 'hasta la primera carga no se sabe si habrá red');
    // Dos cuadrículas de 0,5°; la del oeste se parte en cuatro: 2 + 4 tramos propios y uno compartido.
    assert.equal(await ign.load(), 6);
    assert.equal(ign.pending(), false);
    assert.ok(ign.network().edges >= 6);
    assert.match(ign.credit, /^Obra derivada de IGR-RT 2026 CC-BY 4\.0 scne\.es$/);
    const first = asked.length;

    // Dentro del mes: ni descarga ni vuelve a preparar la red.
    const net = ign.network();
    assert.equal(await ign.load(), 6);
    assert.equal(ign.network(), net);
    assert.equal(asked.length, first);

    // Pasado el mes, el IGN no responde: sigue con la copia guardada.
    now += 31 * 24 * 3600_000;
    down = true;
    const warned = [];
    const again = createIgnRailNetwork({ http, cache, log: { ...quiet, warn: (m) => warned.push(m) }, areas: [[-4, 40, -3, 40.5]], tileDeg: 0.5, minLinks: 3, now: () => now, retryMs: 0 });
    assert.equal(await again.load(), 6);
    assert.match(warned.join(' '), /copia guardada/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('una zona con la que el IGN no da abasto (502) se pide en cuadrículas más pequeñas', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ign-'));
  try {
    const widths = [];
    const http = {
      bytes: async (url) => {
        const [s, w, , e] = bbox(url);
        widths.push(e - w);
        // En la mitad oeste (con muchas vías) sólo responde a las cuadrículas de 0,125°.
        if (w < -3.5 && e - w > 0.2) throw new Error('HTTP 502 en servicios.idee.es');
        return new TextEncoder().encode(gml([[`T${w},${s}`, [[w + 0.01, s + 0.01], [w + 0.02, s + 0.02]]]]));
      },
    };
    const cache = createFileCache({ http, dir: pathToFileURL(`${dir}/`), log: quiet });
    const ign = createIgnRailNetwork({ http, cache, log: quiet, areas: [[-4, 40, -3, 40.5]], tileDeg: 0.5, minLinks: 3, retryMs: 0 });
    // La del este, entera; la del oeste, en 16 de 0,125°.
    assert.equal(await ign.load(), 17);
    assert.ok(widths.includes(0.125));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sin copia y sin IGN no hay red (los trazados se quedan como los publica cada operador)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-ign-'));
  try {
    let asked = 0;
    const http = { bytes: async () => { asked++; throw new Error('HTTP 503 en servicios.idee.es'); } };
    const cache = createFileCache({ http, dir: pathToFileURL(`${dir}/`), log: quiet });
    const ign = createIgnRailNetwork({ http, cache, log: quiet, areas: [[-4, 40, -3.5, 40.5]], retryMs: 0 });
    await assert.rejects(ign.load(), /503/);
    assert.ok(asked <= 8, `se rinde tras unos pocos fallos seguidos, no pide toda la zona en trozos (${asked})`);
    assert.equal(ign.network(), null);
    assert.equal(ign.pending(), false, 'falló: las líneas ya no esperan a la red');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
