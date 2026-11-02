// Atribuciones en la web: el título de cada foto de Commons y «Fuente: AEMET» en las alertas que
// cruzan sus avisos con los trenes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoTitleOf } from '../../public/js/format.js';
import { renderAlerts } from '../../public/js/panels.js';

test('el título de una foto de Commons es el nombre de su fichero, legible', () => {
  assert.equal(photoTitleOf('https://commons.wikimedia.org/wiki/File:Fachada_estaci%C3%B3n_de_Sants.jpg'), 'Fachada estación de Sants');
  assert.equal(photoTitleOf('https://commons.wikimedia.org/wiki/File:Moyua%20geltokia.JPEG'), 'Moyua geltokia');
  assert.equal(photoTitleOf('https://ejemplo.org/otra-cosa'), null);
  assert.equal(photoTitleOf('https://commons.wikimedia.org/wiki/File:%E0%A4%A.jpg'), null, 'un nombre mal codificado no rompe la ficha');
});

test('las alertas por avisos de AEMET citan «Fuente: AEMET»; las demás no', () => {
  const el = { innerHTML: '' };
  const since = Date.now();
  renderAlerts(el, [
    { id: 'meteo:1', type: 'meteo', severity: 'alta', title: 'Aviso naranja por viento · 3 trenes dentro', since },
    { id: 'stopped:1', type: 'stopped', severity: 'media', title: 'Tren detenido', since },
  ], []);
  const [meteo, stopped] = el.innerHTML.split('alert-item').slice(1);
  assert.match(meteo, /Fuente: AEMET/);
  assert.doesNotMatch(stopped, /AEMET/);
});
