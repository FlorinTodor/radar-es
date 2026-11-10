// El bot y el tráfico, sin Telegram: seguir una carretera (con /carretera o desde la web), avisos sólo de lo nuevo y
// una vez, las provincias con sus cortes y accidentes graves, /estado y el parte, los topes, lo que se guarda y las
// métricas. Reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // 06:00 en Madrid
const MIN = 60_000;
const CHAT = 2002;
const CREDITS = { dgt: 'Fuente: DGT (Punto de Acceso Nacional de Tráfico y Movilidad, nap.dgt.es) · Creative Commons Attribution',
  'trafico-euskadi': 'Open Data Euskadi (CC BY 4.0) · Gobierno Vasco y ayuntamientos de Bilbao, Vitoria-Gasteiz y Donostia' };

function setup({ limits } = {}) {
  let now = T0;
  const world = { vehicles: [], events: [] };
  const disk = { value: null };
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, station: () => null },
    store: { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } },
    clock: { now: () => now },
    creditOf: (source) => CREDITS[source] ?? null,
    webUrl: 'https://radarespana.es',
    limits,
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  return { bot, world, disk, say, tick: (ms = MIN) => { now += ms; return bot.tick(); }, at: () => now };
}

// Como las da el adaptador de la DGT (dgt.js).
const dgt = (at, over = {}) => ({
  id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'media', closed: false, road: 'A-7', province: 'Málaga',
  title: 'Accidente · A-7 km 1012.0', description: 'Marbella, Málaga', lat: 36.51, lon: -4.88, start: at, updated: at, ...over,
});

test('/carretera: la sigue (entera o en una provincia), cuenta cómo está y qué avisará; lo que no entiende, lo dice', () => {
  const { say, world, bot } = setup();
  world.events = [dgt(T0 - 5 * MIN, { type: 'roadMaintenance', title: 'Obras · A-7 km 1000.0' })];
  const [r] = say('/carretera a7');
  assert.equal(r.text, 'Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de la A-7; de las obras, sólo si '
    + 'cortan la carretera. Datos de la DGT, del Servei Català de Trànsit y de Tráfico de Euskadi. Si sólo te interesa una provincia, escribe '
    + '/carretera A-7 y su nombre.\n\nAhora:\nAhora no hay cortes, accidentes ni incidencias graves en la A-7.\nAdemás, 1 incidencia más leve '
    + '(obras sin corte, retenciones…), en el mapa.\n\n/mis para ver lo que sigues · /dejar para dejar de seguirlo');
  assert.match(say('/carretera A 7')[0].text, /^Ya sigues Carretera A-7\./);
  assert.match(say('/carretera A-7 en Málaga')[0].text, /^Hecho: te aviso de .* de la A-7 en Málaga; de las obras/);
  assert.equal(say('/mis')[0].text, 'Sigues:\n\n1. Carretera A-7\n2. Carretera A-7 (Málaga)\n\nPara dejar algo: /dejar (o /dejar y su número).');
  assert.match(say('/carretera')[0].text, /^Dime la carretera: \/carretera A-7/);
  assert.match(say('/carretera Málaga')[0].text, /^Dime también la carretera, por ejemplo: \/carretera A-7 Málaga\. Para los avisos de toda la provincia: \/provincia Málaga\.$/);
  assert.match(say('/carretera la del puerto')[0].text, /^No entiendo qué carretera es «la del puerto»/);
  assert.match(say('/datos')[0].text, /Lo que sigues: Carretera A-7; Carretera A-7 \(Málaga\)/);
  assert.match(say('/dejar 2')[0].text, /^Hecho: ya no te aviso de Carretera A-7 \(Málaga\)\.$/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 1 });
});

test('desde la web (/start c-…): la sigue con su nombre como lo escribe su fuente; una provincia inventada, no', () => {
  const { say, world, bot } = setup();
  world.events = [dgt(T0 - 5 * MIN, { road: 'TE-V-1121', title: 'Obras · TE-V-1121 km 3.0', type: 'roadMaintenance' })];
  assert.match(say('/start c-TEV1121')[0].text, /^Hecho: te aviso de .* de la TE-V-1121;/);
  assert.match(say('/start c-A7-malaga')[0].text, /de la A-7 en Málaga;/);
  assert.match(say('/start c-A7-atlantida')[0].text, /^Hola\. Soy el bot de Radar España/);
  assert.match(say('/start c-HOLA')[0].text, /^Hola\. Soy el bot/);
  assert.deepEqual(bot.stats(), { chats: 1, subs: 2 });
  assert.deepEqual(bot.usage().totals.commands, { enlace: 3, start: 1 }, 'un enlace aunque su provincia no exista');
});

test('rondas: avisa una vez de lo nuevo con su texto tal cual y su fuente; lo de antes, lo leve y lo de otra provincia, no', () => {
  const { say, world, tick, at } = setup();
  const old = dgt(T0 - 3 * 3600_000, { id: 'dgt:viejo', title: 'Accidente · A-7 km 990.0' });
  world.events = [old];
  say('/carretera A-7 Málaga');
  say('/carretera GI-627', 3003);
  assert.deepEqual(tick(), [], 'lo que ya había al seguirla');
  world.events = [old, dgt(at(), { id: 'dgt:2' }), dgt(at(), { id: 'dgt:3' }), // la DGT, la misma dos veces (un número por sentido)
    dgt(at(), { id: 'dgt:4', type: 'roadMaintenance', title: 'Obras · A-7 km 1001.0' }),
    dgt(at(), { id: 'dgt:5', province: 'Cádiz', title: 'Accidente · A-7 km 115.0', description: 'Algeciras, Cádiz', lat: 36.13, lon: -5.45 })];
  const [msg, ...rest] = tick();
  assert.deepEqual(rest, [], 'un mensaje, a quien sigue la A-7 en Málaga');
  assert.equal(msg.chatId, CHAT);
  assert.equal(msg.text, 'Carretera A-7 (Málaga):\n\nAccidente · A-7 km 1012.0 · Marbella, Málaga. Desde las 06:01.\n\n'
    + `${CREDITS.dgt}\n\nMás en https://radarespana.es`);
  assert.deepEqual(tick(), [], 'una vez');
  world.events.push(dgt(at(), { id: 'dgt:2', closed: true, description: 'Marbella, Málaga · Carretera cortada', severity: 'muy alta' }));
  assert.match(tick()[0].text, /^Carretera A-7 \(Málaga\):\n\nAccidente · A-7 km 1012\.0 · Marbella, Málaga · Carretera cortada\. Gravedad: muy alta\./,
    'si pasa a cortar la carretera, se avisa otra vez');
  // Tráfico de Euskadi: su texto, sin tocar.
  world.events = [{ id: 'euskadi:378636', source: 'trafico-euskadi', category: 'carretera', type: 'accident', severity: 'baja', closed: false,
    road: 'GI-627', title: 'Alcance · GI-627 km 38.0', description: 'Accidente · Arrasate/Mondragón · sentido EIBAR (POR MALTZAGA)',
    lat: 43.07, lon: -2.46, start: at() }];
  const [eus] = tick();
  assert.equal(eus.chatId, 3003);
  assert.equal(eus.text, 'Carretera GI-627:\n\nAlcance · GI-627 km 38.0 · Accidente · Arrasate/Mondragón · sentido EIBAR (POR MALTZAGA). Desde las 06:04.\n\n'
    + `${CREDITS['trafico-euskadi']}\n\nMás en https://radarespana.es`);
});

test('provincias: también sus cortes y accidentes graves; no los leves, ni las obras, ni lo viejo que reaparece tras una caída', () => {
  const { say, world, tick, at } = setup();
  assert.match(say('/provincia Málaga')[0].text,
    /También de los cortes de carretera y de los accidentes graves \(no de las obras ni de las retenciones\)\..*\n\nAhora:\n.*\nCarreteras: ahora no hay cortes ni accidentes graves\.$/s);
  tick();
  world.events = [
    dgt(at(), { id: 'dgt:leve' }),
    dgt(at(), { id: 'dgt:obra', type: 'roadMaintenance', closed: true, title: 'Obras · MA-20 km 3.0', description: 'Málaga, Málaga · Carretera cortada' }),
    dgt(at() - 2 * 86400_000, { id: 'dgt:viejo', type: 'environmentalObstruction', severity: 'muy alta', closed: true, road: 'A-7150',
      title: 'Fenómeno meteorológico o ambiental · A-7150 km 1.2', description: 'Casares, Málaga · Carretera cortada' }),
  ];
  assert.deepEqual(tick(), []);
  world.events.push(dgt(at(), { id: 'dgt:corte', type: 'infrastructureDamageObstruction', severity: 'muy alta', closed: true, road: 'MA-7402',
    title: 'Daños en la infraestructura · MA-7402 km 10.0', description: 'Ronda, Málaga · Carretera cortada', lat: 36.73, lon: -5.35 }));
  const [msg] = tick();
  assert.match(msg.text, /^Avisos en Málaga:\n\nDaños en la infraestructura · MA-7402 km 10\.0 · Ronda, Málaga · Carretera cortada\. Gravedad: muy alta\. Desde las 06:02\.\n\nFuente: DGT/,
    'cerca de Cádiz, pero la DGT dice Málaga');
  const [status] = say('/estado');
  assert.match(status.text, /Carreteras: 2 cortes o accidentes graves\.\n- Daños en la infraestructura · MA-7402.*\n- Fenómeno meteorológico o ambiental · A-7150 km 1\.2 · Casares, Málaga · Carretera cortada\. Gravedad: muy alta\. Desde el 8\/11\/2026\./,
    'en /estado sale todo lo que hay ahora, también lo viejo');
});

test('/estado y el parte: la carretera seguida, entera; y /estado de una carretera sin seguirla; /seguir A-7 sugiere /carretera', () => {
  const { say, world, tick } = setup();
  world.events = [dgt(T0 - 5 * MIN)];
  assert.match(say('/estado A-7')[0].text, /^Carretera A-7:\nAhora hay 1 corte, accidente o incidencia grave en la A-7:\n- Accidente · A-7 km 1012\.0 · Marbella, Málaga\. Desde las 05:55\.\n\nFuente: DGT/);
  assert.match(say('/seguir A-7')[0].text, /^No encuentro ningún vehículo ni línea así\. Si es una carretera, para sus cortes y accidentes: \/carretera A-7$/);
  say('/carretera A-7');
  say('/parte 06:10');
  const parts = tick(10 * MIN);
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /^Parte de las 06:10:\n\nCarretera A-7:\nAhora hay 1 corte, accidente o incidencia grave en la A-7:/);
});

test('topes, lo que se guarda y las métricas: una carretera cuenta como una cosa más', async () => {
  const { say, bot, disk } = setup({ limits: { subsPerChat: 2 } });
  say('/carretera A-7');
  say('/provincia Soria');
  assert.match(say('/carretera AP-7')[0].text, /^Ya sigues 2 cosas, el máximo/);
  await bot.save({ always: true });
  assert.deepEqual(disk.value.chats[0].subs.map((s) => [s.key, s.name]), [['c-A7', 'Carretera A-7']]);
  const usage = bot.usage();
  assert.equal(usage.follows.carretera, 1);
  assert.deepEqual(usage.top.find((t) => t.kind === 'carretera'), { kind: 'carretera', key: 'c-A7', name: 'Carretera A-7', chats: 1 });
  assert.equal(usage.totals.commands.carretera, 2);
  // Otro servidor con el mismo disco: la carretera sigue; una clave mal escrita o de una provincia que no existe, fuera.
  disk.value.chats[0].subs.push({ key: 'c-A7-atlantida', name: 'x', since: T0, checkedAt: T0 }, { key: 'c-hola', name: 'y', since: T0, checkedAt: T0 });
  const other = setup();
  other.disk.value = disk.value;
  assert.equal(await other.bot.load(), 1);
  assert.equal(other.say('/mis')[0].text, 'Sigues:\n\n1. Carretera A-7\n2. Avisos en Soria\n\nPara dejar algo: /dejar (o /dejar y su número).');
});
