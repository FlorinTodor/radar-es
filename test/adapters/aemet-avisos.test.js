// AEMET: avisos en CAP. El nombre del fenómeno sale de <event> («Aviso de tormentas de nivel amarillo»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAemetAvisosSource } from '../../server/adapters/outbound/sources/aemet-avisos.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
const RSS = '<rss><channel><item><link>https://www.aemet.es/es/eltiempo/prediccion/avisos/cap1.xml</link></item></channel></rss>';
const cap = (event) => `<alert><identifier>a</identifier><msgType>Alert</msgType><info><language>es-ES</language><event>${event}</event>`
  + '<expires>2099-01-01T00:00:00+01:00</expires><parameter><valueName>AEMET-Meteoalerta nivel</valueName><value>amarillo</value></parameter>'
  + '<area><areaDesc>Zona de prueba</areaDesc><polygon>40,-3 40,-2 41,-2 40,-3</polygon></area></info></alert>';
const typeOf = async (event) => {
  const http = { text: async (url) => (url.endsWith('RSS.xml') ? RSS : cap(event)) };
  return (await createAemetAvisosSource({ http, log }).fetch()).events[0]?.type;
};

test('AEMET: el fenómeno sale del <event> sin «Aviso de» ni «de nivel …»', async () => {
  assert.equal(await typeOf('Aviso de tormentas de nivel amarillo'), 'tormentas');
  assert.equal(await typeOf('Aviso por lluvias de nivel naranja'), 'lluvias');
  assert.equal(await typeOf('Aviso de temperaturas máximas de nivel rojo'), 'temperaturas máximas');
  assert.equal(await typeOf('Aviso de nevadas  de nivel amarillo'), 'nevadas');
});

test('AEMET: un <event> con un tramo enorme de espacios no deja colgado el servidor', async () => {
  // Antes, /\s+de nivel \w+$/ volvía a recorrer el tramo de espacios desde cada uno (cuadrático): con
  // estos ~200 KB tardaba más de medio minuto. Ahora el nombre se recorta y se juntan los espacios antes.
  assert.equal(await typeOf(`tormentas${' '.repeat(200_000)}x`), 'tormentas');
  assert.equal(await typeOf(`Aviso de tormentas${' \t'.repeat(100_000)}de nivel amarillo`), 'tormentas');
  assert.ok((await typeOf(`tormentas ${'x '.repeat(100_000)}`)).length <= 200);
});
