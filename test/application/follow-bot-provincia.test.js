// El bot, con lo nuevo de una provincia y de una estación: los posibles apagones de las islas (alertas del motor de
// alertas), los focos de calor por satélite para quien los pide (/provincia Granada incendios) y los avisos de Renfe
// de una estación seguida, sin repetir un aviso que ya le llega por su línea. Sin Telegram y con reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { GRID_METRICS, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { lineKey, stopKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T10:00:00Z'); // 11:00 en Madrid
const MIN = 60_000;
const HOUR = 3600_000;
const CHAT = 1001;
const RENFE = 'Origen de los datos: Renfe Operadora';
const FIRMS = 'NASA FIRMS (LANCE, ESDIS) · Datos de NASA sin restricciones de uso · No apto para decisiones tácticas';
const C5 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C5' });
const MAJADAHONDA = { code: '10005', name: 'Majadahonda', lat: 40.4742885, lon: -3.8462931 };

function setup() {
  let now = T0;
  const world = { vehicles: [], events: [], alerts: [] };
  const disk = { value: null };
  const bot = makeFollowBot({
    read: {
      vehicles: () => world.vehicles, events: () => world.events, alerts: () => world.alerts,
      station: (code) => (code === MAJADAHONDA.code ? MAJADAHONDA : null),
    },
    store: { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } },
    clock: { now: () => now },
    creditOf: (source) => ({ 'renfe-avisos': RENFE, firms: FIRMS })[source] ?? null,
    webUrl: 'https://radarespana.es',
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  return { bot, world, disk, say, tick: (ms = MIN) => { now += ms; return bot.tick(); }, at: () => now };
}

/** La alerta de verdad de la regla de los apagones de un sistema aislado, con su demanda (MW). */
function gridAlert(id, name, real, programmed, now) {
  const systems = [{ id, name, real, programmed, recentMax: programmed, readMax: programmed, at: now - 10 * MIN, previous: { real, at: now - 15 * MIN } }];
  return isolatedGridBlackouts({ now, metrics: { [GRID_METRICS.aislados]: { systems } }, thresholds: DEFAULT_THRESHOLDS })
    .map((a) => ({ ...a, since: now }));
}
const foco = (lat, lon, frp, start) => ({ id: `firms:${lat}:${lon}:${start}`, source: 'firms', category: 'incendio', type: 'foco', frp, confidence: 'alta', lat, lon, start });
const ascensor = (over = {}) => ({
  id: 'renfe-aviso:INFO_525469', source: 'renfe-avisos', category: 'ferroviario', type: 'aviso', title: 'Aviso Renfe', lat: 40.4742885, lon: -3.8462931,
  description: 'Ascensor de la estación Majadahonda que da acceso a la vía 2 sentido Villalba / Alcalá de Henares, se encuentra fuera de servicio.',
  ...over,
});

test('apagón en una isla: llega a quien sigue su provincia, una vez, citando a Red Eléctrica; si pasa a total, otra; si vuelve a medias, no', () => {
  const { say, world, tick, at } = setup();
  const [r] = say('/provincia Santa Cruz de Tenerife');
  assert.match(r.text, /También te aviso de los posibles apagones que se ven en la demanda eléctrica de cada isla \(una estimación de Radar España con datos de Red Eléctrica\)\./);
  assert.match(r.text, /Si quieres también los focos de calor que detecta el satélite \(posibles incendios, sin confirmar\): \/provincia Santa Cruz de Tenerife incendios$/);
  say('/provincia Granada', 2002);
  world.alerts = gridAlert('la-palma', 'La Palma', 7, 21, at());
  const [half] = tick();
  assert.equal(half.chatId, CHAT, 'sólo a quien sigue la provincia de la isla');
  assert.match(half.text, /^Avisos en Santa Cruz de Tenerife:\n\nDemanda eléctrica de La Palma un 67 % por debajo de lo esperado\. Real 7 MW a las .+\(hora peninsular\).+Estimación de Radar España con datos de Red Eléctrica: confírmalo con los avisos oficiales\.\n\nFuente: Red Eléctrica\n\nMás en https:\/\/radarespana\.es$/s);
  assert.deepEqual(tick(), [], 'una vez');
  world.alerts = gridAlert('la-palma', 'La Palma', 0, 21, at());
  assert.match(tick()[0].text, /Posible apagón total en La Palma: demanda a 0 MW/, 'empeora: otro aviso');
  world.alerts = gridAlert('la-palma', 'La Palma', 7, 21, at());
  assert.deepEqual(tick(), [], 'vuelve a medias: no es un aviso nuevo');
  world.alerts = [];
  assert.deepEqual(tick(), []);
  assert.match(say('/estado')[0].text, /Ahora no hay avisos naranja o rojo de AEMET/);
});

test('focos de calor: sólo a quien los pide en su provincia, uno por zona y día, y siempre como detección sin confirmar', () => {
  const { say, world, tick, at, bot } = setup();
  const [r] = say('/provincia Granada incendios');
  assert.match(r.text, /^Hecho: te aviso en Granada de los avisos naranja y rojo de AEMET/);
  assert.match(r.text, /Focos de calor por satélite: ahora ninguno de los que aviso \(confianza alta y potencia alta\)\./);
  assert.match(r.text, /También te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio confirmado\. Para quitarlos: \/provincia Granada sin incendios$/);
  say('/provincia Granada', 2002);
  world.events = [foco(37.05, -3.35, 44.6, at() - HOUR), foco(37.06, -3.35, 20, at() - HOUR), foco(37.07, -3.35, 12, at() - HOUR)];
  const out = tick();
  assert.equal(out.length, 1, 'quien no los ha pedido, nada');
  assert.equal(out[0].chatId, CHAT);
  assert.equal(out[0].text, 'Avisos en Granada:\n\nPosible incendio: 3 focos de calor juntos, el más fuerte de 45 MW; el último, detectado el 10/11, 10:00. '
    + 'Es una detección por satélite, no un incendio confirmado: también puede ser una quema agrícola o una fuente de calor industrial. '
    + `Dónde: https://www.openstreetmap.org/?mlat=37.0500&mlon=-3.3500#map=13/37.0500/-3.3500\n\n${FIRMS}\n\nMás en https://radarespana.es`);
  // Crece por la tarde: el mismo aviso. Pasa otra vez el satélite al rato y no ve nada: tampoco se repite.
  world.events.push(foco(37.08, -3.36, 90, at() + HOUR));
  assert.deepEqual(tick(2 * HOUR), []);
  const growing = world.events;
  world.events = [];
  assert.deepEqual(tick(4 * HOUR), []);
  world.events = growing;
  assert.deepEqual(tick(), [], 'vuelve en la misma zona el mismo día: no se repite');
  assert.match(say('/estado')[0].text, /Avisos en Granada \(con focos de calor\):\nPosible incendio: 4 focos de calor juntos, el más fuerte de 90 MW/);
  assert.match(say('/estado', 2002)[0].text, /^Avisos en Granada:\nAhora no hay avisos naranja o rojo/, 'a quien no los pidió, tampoco en /estado');
  assert.match(say('/estado Granada incendios', 2002)[0].text, /Posible incendio/, 'salvo que los pida');
  // Al día siguiente sigue ardiendo: otro aviso.
  const tomorrow = Date.parse('2026-11-11T13:00:00Z');
  world.events = [...growing, foco(37.06, -3.35, 60, tomorrow - HOUR)];
  const next = tick(tomorrow - at());
  assert.equal(next.length, 1);
  assert.match(next[0].text, /Posible incendio: un foco de calor de 60 MW, detectado el 11\/11, 13:00\./);
  assert.deepEqual(bot.stats(), { chats: 2, subs: 2 });
});

test('/provincia … incendios en una que ya se sigue los añade; «sin incendios» los quita; se guardan y se ven en /mis y /datos', async () => {
  const { say, world, tick, at, bot, disk } = setup();
  say('/provincia Granada');
  world.events = [foco(37.05, -3.35, 44.6, at() - HOUR)];
  assert.deepEqual(tick(), []);
  const [on] = say('/provincia Granada incendios');
  assert.match(on.text, /^Hecho: en Granada ahora también te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio confirmado\. Para quitarlos: \/provincia Granada sin incendios\n\nAhora:\n.*Posible incendio: un foco de calor de 45 MW/s);
  assert.deepEqual(tick(), [], 'lo que ya había al pedirlos se cuenta en la respuesta, no se avisa');
  assert.match(say('/provincia granada focos')[0].text, /^Ya sigues los avisos de Granada \(con focos de calor\)\./);
  assert.match(say('/mis')[0].text, /\n1\. Avisos en Granada \(con focos de calor\)\n/);
  assert.match(say('/datos')[0].text, /- Provincias: Granada \(con focos de calor\)/);
  await bot.save();
  assert.deepEqual(disk.value.chats[0].provinces.map((p) => [p.id, p.fires]), [['granada', true]]);
  await bot.load();
  assert.match(say('/mis')[0].text, /Avisos en Granada \(con focos de calor\)/, 'tras un reinicio, igual');
  assert.match(say('/provincia Granada sin incendios')[0].text, /^Hecho: en Granada ya no te aviso de los focos de calor; del resto de sus avisos, sí\.$/);
  assert.match(say('/provincia Granada sin incendios')[0].text, /^En Granada no te aviso de los focos de calor/);
  assert.match(say('/provincia Jaén sin incendios')[0].text, /^No sigues Jaén\./);
  await bot.save();
  assert.equal(disk.value.chats[0].provinces[0].fires, undefined);
  world.events.push(foco(38.0, -3.0, 70, at()));
  assert.deepEqual(tick(), [], 'sin focos, no llegan');
  assert.match(say('/provincia Narnia incendios')[0].text, /^No conozco la provincia «Narnia»/);
});

test('estación seguida: los avisos de Renfe de la estación, con su texto tal cual y su atribución; el mismo, una vez aunque también siga su línea', () => {
  const { say, world, tick } = setup();
  world.events = [ascensor({ id: 'ya-estaba', description: 'Acceso por la calle Doctor Calero cerrado.' })];
  const [r] = say(`/start ${stopKey(MAJADAHONDA.code)}`);
  assert.match(r.text, /Avisos de Renfe en la estación:\n- Aviso Renfe: Acceso por la calle Doctor Calero cerrado\.\n\nOrigen de los datos: Renfe Operadora/);
  say(`/start ${C5}`);
  world.events.push(ascensor({ description: `${ascensor().description}\r\n` }), ascensor({ id: 'repetido' }),
    ascensor({ id: 'renfe-aviso:linea', title: 'Aviso Renfe · C5', description: 'Por obras, los trenes de la C5 no paran en Majadahonda esta noche.', follow: [C5] }),
    ascensor({ id: 'lejos', lat: 40.4466271, lon: -3.6923468, description: 'Ascensor de Nuevos Ministerios fuera de servicio.' }));
  const out = tick();
  assert.equal(out.length, 1, 'el aviso de la C5 en Majadahonda llega una vez');
  assert.equal(out[0].text, 'Estación Majadahonda:\n\n'
    + '- Aviso Renfe: Ascensor de la estación Majadahonda que da acceso a la vía 2 sentido Villalba / Alcalá de Henares, se encuentra fuera de servicio.\n'
    + '- Aviso Renfe · C5: Por obras, los trenes de la C5 no paran en Majadahonda esta noche.\n\n'
    + `${RENFE}\n\nMás en https://radarespana.es`);
  assert.deepEqual(tick(), [], 'una vez');
  assert.match(say('/estado')[0].text, /Avisos de Renfe en la estación:\n- Aviso Renfe: Acceso por la calle Doctor Calero cerrado\.\n- Aviso Renfe: Ascensor de la estación Majadahonda/);
});

test('el parte de la mañana cuenta los apagones, los focos (si se piden) y los avisos de la estación', () => {
  const { say, world, tick, at } = setup();
  say('/provincia Las Palmas incendios');
  say(`/start ${stopKey(MAJADAHONDA.code)}`);
  say('/parte 11:05');
  world.alerts = gridAlert('gran-canaria', 'Gran Canaria', 0, 400, at());
  world.events = [ascensor(), foco(28.0, -15.6, 33, at())];
  let parte = [];
  for (let i = 0; i < 10 && !parte.some((m) => m.text.startsWith('Parte')); i++) parte = tick();
  const text = parte.find((m) => m.text.startsWith('Parte')).text;
  assert.match(text, /Avisos en Las Palmas \(con focos de calor\):\nPosible apagón total en Gran Canaria.*\nPosible incendio: un foco de calor de 33 MW.*actividad volcánica/s);
  assert.match(text, /Estación Majadahonda:\n.*Avisos de Renfe en la estación:\n- Aviso Renfe: Ascensor de la estación Majadahonda/s);
  assert.match(text, /Fuente: Red Eléctrica/);
  assert.match(text, /NASA FIRMS/);
  assert.match(text, /Origen de los datos: Renfe Operadora/);
});
