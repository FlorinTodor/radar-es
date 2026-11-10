// «Avísame por Telegram» en las fichas: sólo si hay bot; un enlace por servicio, línea o estación, con el nombre
// del tipo de vehículo del registro; nada que no sea una clave válida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTelegram, telegramFollow, telegramLink } from '../../public/js/avisar.js';

const MODES = [{ id: 'av', noun: 'tren' }, { id: 'bus', noun: 'autobús' }];

test('sin bot, nada', () => {
  setTelegram({}, MODES);
  assert.equal(telegramFollow(['s-renfe-8058'], 'av'), '');
  setTelegram({ telegram: { bot: 'no es un bot' } }, MODES);
  assert.equal(telegramFollow(['s-renfe-8058'], 'av'), '');
});

test('con bot: un botón grande para el servicio y la línea como segunda opción; nombres del registro de tipos', () => {
  setTelegram({ telegram: { bot: 'RadarEspanaBot' } }, MODES);
  const html = telegramFollow(['s-renfe-8058', 'l-renfe-Avant', 'l-renfe-Catalunya-R16'], 'av', { line: 'Avant', service: 'Avant' });
  assert.match(html, /^<div class="tg-cta"><a class="tg-btn" href="https:\/\/t\.me\/RadarEspanaBot\?start=s-renfe-8058" target="_blank" rel="noopener">/);
  assert.match(html, /<strong>Avísame por Telegram<\/strong><small>si este tren se cancela o va con retraso<\/small>/);
  assert.match(html, /<a class="tg-alt" href="https:\/\/t\.me\/RadarEspanaBot\?start=l-renfe-Avant" target="_blank" rel="noopener">o de todos los Avant<\/a>/,
    'la primera línea; cuando la «línea» es el producto, «todos los Avant»');
  assert.match(telegramFollow(['s-renfe-23065', 'l-renfe-Madrid-C5'], 'cercanias', { line: 'C5', service: 'Cercanías' }), />o de toda la línea C5</);
  assert.match(telegramFollow(['s-renfe-23065', 'l-renfe-Madrid-C5'], 'cercanias'), />o de toda su línea</, 'sin nombre de línea');
});

test('sólo línea (autobús sin servicio estable), una estación, un tipo que el registro aún no tiene', () => {
  setTelegram({ telegram: { bot: 'RadarEspanaBot' } }, MODES);
  const bus = telegramFollow(['l-emtmalaga-27'], 'bus', { line: '27', service: 'EMT Málaga' });
  assert.match(bus, /start=l-emtmalaga-27"/);
  assert.match(bus, /<small>de las cancelaciones y avisos de la línea 27<\/small>/);
  assert.doesNotMatch(bus, /tg-alt/, 'sin segunda opción');
  assert.match(telegramFollow('p-71801'), /start=p-71801".*de las cancelaciones que pasan por esta estación/);
  assert.match(telegramFollow(['s-amb-V15-0k3x9ab-0732'], 'barco'), /si este servicio se cancela/, 'un tipo que el registro aún no tiene');
  assert.equal(telegramFollow(['"><script>', 'x'], 'av'), '', 'sólo claves válidas');
  assert.equal(telegramFollow(undefined), '');
  assert.doesNotMatch(telegramFollow(['l-x-1'], 'bus', { line: '<b>' }), /<b>/, 'el nombre de la línea, escapado');
});

test('el botón pequeño de «Siguiendo»: sólo con bot y con una clave válida', () => {
  setTelegram({}, MODES);
  assert.equal(telegramLink('l-emtmalaga-27', 'Autobús 27 · EMT Málaga'), '');
  setTelegram({ telegram: { bot: 'RadarEspanaBot' } }, MODES);
  const link = telegramLink('l-emtmalaga-27', 'Autobús 27 · EMT Málaga');
  assert.match(link, /^<a class="tg-mini" href="https:\/\/t\.me\/RadarEspanaBot\?start=l-emtmalaga-27"/);
  assert.match(link, /aria-label="Avisos por Telegram de Autobús 27 · EMT Málaga"/);
  assert.equal(telegramLink('"><x>'), '');
});
