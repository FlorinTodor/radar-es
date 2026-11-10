// «Avisarme por Telegram» en las fichas: sólo si hay bot; un enlace por servicio, línea o estación, con el nombre
// del tipo de vehículo del registro; nada que no sea una clave válida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTelegram, telegramFollow } from '../../public/js/avisar.js';

const MODES = [{ id: 'av', noun: 'tren' }, { id: 'bus', noun: 'autobús' }];

test('sin bot, nada', () => {
  setTelegram({}, MODES);
  assert.equal(telegramFollow(['s-renfe-8058'], 'av'), '');
  setTelegram({ telegram: { bot: 'no es un bot' } }, MODES);
  assert.equal(telegramFollow(['s-renfe-8058'], 'av'), '');
});

test('con bot: el servicio y la línea (el primero de cada), la estación; nombres del registro de tipos', () => {
  setTelegram({ telegram: { bot: 'RadarEspanaBot' } }, MODES);
  assert.equal(telegramFollow(['s-renfe-8058', 'l-renfe-Avant', 'l-renfe-51-R16'], 'av'),
    '<p class="tg-follow">Avisarme por Telegram <a href="https://t.me/RadarEspanaBot?start=s-renfe-8058" target="_blank" rel="noopener">de este tren</a>'
    + ' · <a href="https://t.me/RadarEspanaBot?start=l-renfe-Avant" target="_blank" rel="noopener">de su línea</a></p>');
  assert.match(telegramFollow(['l-emtmalaga-27'], 'bus'), /start=l-emtmalaga-27" target="_blank" rel="noopener">de su línea</);
  assert.match(telegramFollow('p-71801'), />de esta estación</);
  assert.match(telegramFollow(['s-amb-V15-0k3x9ab-0732'], 'barco'), />de este servicio</, 'un tipo que el registro aún no tiene');
  assert.equal(telegramFollow(['"><script>', 'x'], 'av'), '', 'sólo claves válidas');
  assert.equal(telegramFollow(undefined), '');
});
