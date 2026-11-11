// Seguir una estación escribiendo su nombre, sin Telegram: /estacion (/station), «/seguir estación …», escrito sin
// orden, la estación que se llama tal cual delante de las líneas en /seguir, la pista de /estacion cuando sólo salen
// líneas, y /estado de una estación por su nombre. Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // martes, 06:00 en Madrid
const CHAT = 1001;
const ST = {
  gu: { code: '70200', name: 'Guadalajara', place: 'Guadalajara', lat: 40.6447, lon: -3.1824 },
  al: { code: '70103', name: 'Alcalá de Henares', place: 'Alcalá De Henares', lat: 40.48908, lon: -3.36625 },
  at: { code: '18000', name: 'Madrid-Atocha Cercanías', place: 'Madrid', lat: 40.40636, lon: -3.68962 },
  pa: { code: '60000', name: 'Madrid-Puerta de Atocha-Almudena Grandes', place: 'Madrid', lat: 40.40644, lon: -3.69089 },
  bs: { code: '71801', name: 'Barcelona-Sants', place: 'Barcelona', lat: 41.3792, lon: 2.1400 },
  ss: { code: 'tmb:1', name: 'Sants Estació', place: 'Barcelona', network: 'Metro de Barcelona (TMB)', networkId: 'tmb', lat: 41.3795, lon: 2.1408 },
  ar: { code: 'mm:2', name: 'Estación del Arte', place: 'Madrid', network: 'Metro de Madrid', networkId: 'metro-madrid', lat: 40.4085, lon: -3.6935 },
};
const CATALOG = Object.values(ST);
const CREDIT = 'Origen de los datos: Renfe Operadora';
const C2 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C2' });
const C7 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C7' });

const vehicles = [
  { id: 'c2', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C2', label: '22000', delay: 0,
    origin: 'Guadalajara', destination: 'Madrid-Chamartín-Clara Campoamor', follow: [numberedServiceKey({ operator: 'Renfe', number: '22000' }), C2] },
  { id: 'c7', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C7', label: '27000', delay: 0,
    origin: 'Alcalá de Henares', destination: 'Madrid-Atocha Cercanías', follow: [numberedServiceKey({ operator: 'Renfe', number: '27000' }), C7] },
];

function setup() {
  let now = T0;
  const world = { vehicles, events: [] };
  const byCode = new Map(CATALOG.map((s) => [s.code, s]));
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, station: (code) => byCode.get(code) ?? null },
    trayectos: { stops: () => null, stations: () => CATALOG },
    store: { load: async () => null, save: async () => {} },
    clock: { now: () => now },
    creditOf: (source) => (source.startsWith('renfe') ? CREDIT : null),
    webUrl: 'https://radarespana.es',
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  const press = (data, chatId = CHAT) => bot.handle({ chatId, callback: data, callbackId: 'q1' });
  return { bot, world, say, press, tick: (ms = 60_000) => { now += ms; return bot.tick(); } };
}
const labels = (r) => r.buttons.map((row) => row[0].text);
const following = (bot) => bot.snapshot().chats.flatMap((c) => c.subs.map((s) => [s.key, s.name]));

test('/estacion sin nombre dice cómo se escribe; con una que se llama así, la sigue y dice de qué avisa', () => {
  const { say, bot } = setup();
  assert.equal(say('/estacion')[0].text, 'Dime la estación: /estacion Sants, /estacion Alcalá de Henares…');
  const [r] = say('/estacion guadalajara');
  assert.match(r.text, /^Hecho: te aviso de Estación Guadalajara\.\n\nAhora:\nEstación Guadalajara: |^Hecho: te aviso de Estación Guadalajara\.\n\nAhora:\nHoy no hay cancelaciones/);
  assert.match(r.text, /De esta estación te aviso de lo que pasa por ella y se cancela o se queda sin datos \(si su operador lo publica\) y, en las de Renfe, de los avisos de la estación/);
  assert.deepEqual(following(bot), [[stopKey('70200'), 'Estación Guadalajara']]);
  assert.match(say('/estacion Guadalajara')[0].text, /^Ya sigues Estación Guadalajara\./, 'la misma, otra vez');
  assert.equal(say('/mis')[0].text, 'Sigues:\n\n1. Estación Guadalajara\n\nPara dejar algo: /dejar (o /dejar y su número).');
});

test('/estacion con varias posibles: una lista como la de /trayecto, y el botón la sigue', () => {
  const { say, press, bot } = setup();
  const [r] = say('/estacion Atocha');
  assert.equal(r.text, 'He encontrado varias estaciones. ¿Cuál quieres seguir?');
  assert.deepEqual(labels(r), ['Madrid-Atocha Cercanías', 'Madrid-Puerta de Atocha-Almudena Grandes']);
  const done = press(r.buttons[1][0].data);
  assert.match(done.replies[0].text, /^Hecho: te aviso de Estación Madrid-Puerta de Atocha-Almudena Grandes\./);
  assert.deepEqual(following(bot), [[stopKey('60000'), 'Estación Madrid-Puerta de Atocha-Almudena Grandes']]);
  // Las de una red de metro, con su red en el botón; primero la que empieza por lo escrito (como en /trayecto).
  assert.deepEqual(labels(say('/estacion Sants')[0]), ['Sants Estació (Barcelona) · Metro de Barcelona (TMB)', 'Barcelona-Sants']);
});

test('«/seguir estación …», «estación de …» sin orden (pregunta aunque sea una) y el nombre que empieza por «Estación»', () => {
  const { say, press, bot } = setup();
  assert.deepEqual(labels(say('/seguir estación Atocha')[0]), ['Madrid-Atocha Cercanías', 'Madrid-Puerta de Atocha-Almudena Grandes']);
  const [ask] = say('la estación de Guadalajara');
  assert.equal(ask.text, '¿Quieres seguir esta estación?');
  assert.deepEqual(labels(ask), ['Guadalajara']);
  assert.match(press(ask.buttons[0][0].data).replies[0].text, /^Hecho: te aviso de Estación Guadalajara\./);
  // «Estación del Arte» es el nombre de una (Metro de Madrid): tal cual, y sin «estación», también.
  assert.match(say('/estacion Estación del Arte')[0].text, /^Hecho: te aviso de Estación Estación del Arte · Metro de Madrid\./);
  assert.match(say('/seguir estación del Arte')[0].text, /^Ya sigues Estación Estación del Arte · Metro de Madrid\./);
  assert.equal(bot.stats().subs, 2);
  assert.match(say('/estacion Villaconejos de Abajo')[0].text,
    /^No encuentro ninguna estación «Villaconejos de Abajo» en el catálogo del radar\. Escribe su nombre como en el mapa/);
  assert.equal(say('/seguir estación')[0].text, 'Dime la estación: /estacion Sants, /estacion Alcalá de Henares…');
});

test('/seguir con el nombre exacto de una estación: la estación primero y luego las líneas que van a ella', () => {
  const { say, press, bot } = setup();
  const [r] = say('/seguir Guadalajara');
  assert.equal(r.text, 'He encontrado varias cosas. ¿Cuál quieres seguir?');
  assert.equal(labels(r)[0], 'Estación Guadalajara');
  assert.match(labels(r)[1], /^Cercanías C2/);
  assert.match(press(r.buttons[0][0].data).replies[0].text, /^Hecho: te aviso de Estación Guadalajara\./);
  assert.deepEqual(following(bot), [[stopKey('70200'), 'Estación Guadalajara']]);
});

test('/seguir con parte del nombre: si sólo salen líneas, no sigue ninguna sin preguntar y dice cómo buscar la estación', () => {
  const { say, bot } = setup();
  const [r] = say('/seguir Atocha');
  assert.match(labels(r)[0], /^Cercanías C7/);
  assert.equal(labels(r).length, 1);
  assert.equal(r.text, '¿Quieres seguir esto?\n\nSi buscas una estación: /estacion Atocha');
  assert.equal(bot.stats().subs, 0, 'una sola línea, pero podía ser la estación: pregunta');
  // Sin líneas que encajen, las estaciones.
  assert.deepEqual(labels(say('/seguir Sants')[0]), ['Sants Estació (Barcelona) · Metro de Barcelona (TMB)', 'Barcelona-Sants']);
  // Una línea con su número sigue yendo directa.
  assert.match(say('/seguir 22000')[0].text, /^Hecho: te aviso de /);
});

test('/estado de una estación por su nombre', () => {
  const { say } = setup();
  const both = say('/estado estación Atocha')[0].text;
  assert.match(both, /^Estación Madrid-Atocha Cercanías:\nHoy no hay cancelaciones en vigor ni servicios sin datos que pasen por Madrid-Atocha Cercanías\./);
  assert.match(both, /\n\nEstación Madrid-Puerta de Atocha-Almudena Grandes:\n/);
  const alcala = say('/estado Alcalá de Henares')[0].text;
  assert.match(alcala, /^Estación Alcalá de Henares:\n/, 'la que se llama así, delante');
  assert.match(alcala, /\n\nCercanías C7/, 'y las líneas');
  assert.match(say('/estado Guadalajara')[0].text, /^Avisos en Guadalajara:\n/, 'el nombre de una provincia es la provincia, como antes');
  assert.match(say('/estado Sants')[0].text, /^Estación Sants Estació · Metro de Barcelona \(TMB\):\n[\s\S]*\n\nEstación Barcelona-Sants:\n/, 'sin líneas, las que tienen esas palabras');
  assert.equal(say('/estado estación de Villaconejos')[0].text, 'No encuentro ninguna estación así en el catálogo del radar.');
});

test('en inglés: /station, «Sants station» y la estación, con su nombre tal cual', () => {
  const { say, bot } = setup();
  const [r] = say('/station Sants');
  assert.equal(r.text, 'I found several stations. Which one do you want to follow?');
  assert.deepEqual(labels(r), ['Sants Estació (Barcelona) · Metro de Barcelona (TMB)', 'Barcelona-Sants']);
  assert.match(say('/station Guadalajara')[0].text, /^Done: I'll alert you about Guadalajara station\.[\s\S]*For this station I'll alert you about services through it/);
  assert.equal(say('Sants station')[0].text, 'I found several stations. Which one do you want to follow?');
  assert.equal(say('/follow station')[0].text, 'Tell me the station: /station Sants, /station Alcalá de Henares…');
  assert.equal(bot.usage().totals.commands.estacion, 2, 'se cuenta como /estacion');
});

test('una cancelación que pasa por la estación seguida por su nombre llega en la ronda', () => {
  const { say, world, tick } = setup();
  say('/estacion Guadalajara');
  tick();
  world.events = [{
    id: 'renfe-cancelado:c:22100', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', credit: CREDIT,
    title: 'Cercanías C2 22100 cancelado: Guadalajara → Madrid-Chamartín-Clara Campoamor',
    trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C2', number: '22100', follow: [C2],
      stops: [{ name: 'Guadalajara', time: '07:10', lat: 40.6447, lon: -3.1824 }, { name: 'Madrid-Chamartín-Clara Campoamor', time: '08:05' }] },
  }];
  const [m] = tick();
  assert.match(m.text, /^Estación Guadalajara:\n/);
  assert.match(m.text, /22100/);
  assert.match(m.text, /Origen de los datos: Renfe Operadora/);
});

test('una de metro o tranvía se llama con su red: hay nombres repetidos, y una sola con un nombre puede ser de otra ciudad', () => {
  const { say } = setup();
  assert.match(say('/estacion Sants Estació')[0].text, /^Hecho: te aviso de Estación Sants Estació · Metro de Barcelona \(TMB\)\./);
  assert.match(say('/mis')[0].text, /\n1\. Estación Sants Estació · Metro de Barcelona \(TMB\)\n/);
  say('/language english');
  assert.match(say('/following')[0].text, /\n1\. Sants Estació station · Metro de Barcelona \(TMB\)\n/, 'en inglés, la red tal cual');
});
