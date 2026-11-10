// El bot en inglés también en lo que avisa de más: las carreteras (/road), los trayectos (/journey, con sus días en
// inglés), los apagones de las islas, los focos de calor y los avisos de Renfe de una estación. Lo nuestro, en inglés;
// los nombres, lo que publica cada fuente y las atribuciones, tal cual. Sin Telegram y con reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFollowBot } from '../../server/application/use-cases/follow-bot.js';
import { GRID_METRICS, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import { lineKey, numberedServiceKey, stopKey } from '../../server/domain/seguir.js';

const T0 = Date.parse('2026-11-10T05:00:00Z'); // martes, 06:00 en Madrid
const MIN = 60_000;
const CHAT = 1001;
const RENFE = 'Origen de los datos: Renfe Operadora';
const DGT = 'Fuente: DGT (Punto de Acceso Nacional de Tráfico y Movilidad, nap.dgt.es) · Creative Commons Attribution';
const EUSKADI = 'Open Data Euskadi (CC BY 4.0) · Gobierno Vasco y ayuntamientos de Bilbao, Vitoria-Gasteiz y Donostia';
const FIRMS = 'NASA FIRMS (LANCE, ESDIS) · Datos de NASA sin restricciones de uso · No apto para decisiones tácticas';
const CREDITS = { dgt: DGT, 'trafico-euskadi': EUSKADI, firms: FIRMS, 'renfe-avisos': RENFE, 'renfe-ld': RENFE };
const ST = {
  gu: { code: '70200', name: 'Guadalajara', place: 'Guadalajara', lat: 40.6447, lon: -3.1824 },
  al: { code: '70103', name: 'Alcalá de Henares', place: 'Alcalá De Henares', lat: 40.48908, lon: -3.36625 },
  at: { code: '18000', name: 'Madrid-Atocha Cercanías', place: 'Madrid', lat: 40.40636, lon: -3.68962 },
  pa: { code: '60000', name: 'Madrid-Puerta de Atocha-Almudena Grandes', place: 'Madrid', lat: 40.40644, lon: -3.69089 },
  ma: { code: '10005', name: 'Majadahonda', place: 'Majadahonda', lat: 40.4742885, lon: -3.8462931 },
};
const CATALOG = Object.values(ST);
const C2 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C2' });
const stop = (st, extra = {}) => ({ name: st.name, lat: st.lat, lon: st.lon, time: null, eta: null, passed: false, ...extra });
const MD_STOPS = [stop(ST.gu, { time: '06:50' }), stop(ST.al, { time: '07:10' }), stop(ST.at, { time: '07:40' })];
const md = (delay) => ({
  id: 'renfe-ld:18001', source: 'renfe-ld', mode: 'md', operator: 'Renfe', service: 'Media Distancia', line: 'Media Distancia', label: '18001',
  follow: [numberedServiceKey({ operator: 'Renfe', number: '18001' })], lat: 40.7, lon: -3.0, delay, next: 'Guadalajara', stops: true,
});

function setup() {
  let now = T0;
  const world = { vehicles: [], events: [], alerts: [] };
  const disk = { value: null };
  const byCode = new Map(CATALOG.map((s) => [s.code, s]));
  const bot = makeFollowBot({
    read: { vehicles: () => world.vehicles, events: () => world.events, alerts: () => world.alerts, station: (code) => byCode.get(code) ?? null },
    trayectos: { stops: (id) => (id === 'renfe-ld:18001' ? { stops: MD_STOPS } : null), stations: () => CATALOG },
    store: { load: async () => structuredClone(disk.value), save: async (v) => { disk.value = structuredClone(v); } },
    clock: { now: () => now },
    creditOf: (source) => CREDITS[source] ?? null,
    webUrl: 'https://radarespana.es',
  });
  const say = (text, chatId = CHAT) => bot.handle({ chatId, text }).replies;
  const press = (data, chatId = CHAT) => bot.handle({ chatId, callback: data, callbackId: 'q1' });
  return { bot, world, say, press, tick: (ms = MIN) => { now += ms; return bot.tick(); }, at: () => now };
}

// Palabras nuestras en español que no deberían quedar en inglés, quitados antes los nombres, lo que publican las
// fuentes y sus atribuciones (que van tal cual).
const VERBATIM = [RENFE, DGT, EUSKADI, FIRMS, 'Fuente: Red Eléctrica', 'Red Eléctrica', 'Alcalá de Henares', 'Madrid-Atocha Cercanías', 'Madrid-Puerta de Atocha-Almudena Grandes',
  'Media Distancia', 'Marbella, Málaga', 'Obras · BI-631 km 12.0', 'Bilbao', 'Santa Cruz de Tenerife', 'Servei Català de Trànsit', 'Tráfico de Euskadi',
  'Ascensor de la estación Majadahonda que da acceso a la vía 2, se encuentra fuera de servicio.'];
const SPANISH = /\b(de|del|la|las|los|el|con|sin|hoy|ahora|retraso|hacia|línea|estación|sigues|seguir|circula|cancelad[oa]s?|paradas?|que|por|para|aviso|avisos|nada|hecho|parte|órdenes|carretera|trayecto|focos?|incendios?|cortes?)\b|[¿¡«»]/i;
function assertEnglish(text, what = '') {
  let rest = text;
  for (const v of VERBATIM) rest = rest.replaceAll(v, '');
  assert.doesNotMatch(rest, SPANISH, `${what}: «${text}»`);
}

const dgt = (at, over = {}) => ({
  id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'media', closed: false, road: 'A-7', province: 'Málaga',
  title: 'Accidente · A-7 km 1012.0', description: 'Marbella, Málaga', lat: 36.51, lon: -4.88, start: at, updated: at, ...over,
});

test('/road en inglés: seguirla, cómo está, lo que no entiende y sus avisos; lo de la fuente y su atribución, tal cual', () => {
  const { say, world, tick, at } = setup();
  say('/language en');
  world.events = [dgt(T0 - 5 * MIN, { id: 'dgt:obras', type: 'roadMaintenance', title: 'Obras · A-7 km 1000.0' })];
  const [r] = say('/road a7');
  assert.equal(r.text, "Done: I'll alert you about closures, accidents and incidents of high or very high severity on the A-7; about roadworks, only if "
    + 'they close the road. Data from the DGT, the Servei Català de Trànsit and Tráfico de Euskadi. If you only want one province, send /road A-7 '
    + 'and its name.\n\nNow:\nThere are no closures, accidents or serious incidents on the A-7 right now.\nAlso 1 minor incident (roadworks without '
    + 'a closure, traffic queues…), on the map.\n\n/following to see what you follow · /unfollow to stop following it');
  assert.match(say('/road the A-7 in Málaga')[0].text, /^Done: I'll alert you about .* on the A-7 in Málaga; about roadworks/);
  assert.equal(say('/following')[0].text, 'Following:\n\n1. A-7 road\n2. A-7 road (Málaga)\n\nTo unfollow something: /unfollow (or /unfollow and its number).');
  assert.match(say('/road')[0].text, /^Tell me the road: \/road A-7, \/road N-340\./);
  assert.equal(say('/road Málaga')[0].text, 'Tell me the road too, for example: /road A-7 Málaga. For the alerts for the whole province: /province Málaga.');
  assert.match(say('/road the harbour one')[0].text, /^I don't understand which road “the harbour one” is\. Write it as on the road signs: \/road A-7/);
  assert.match(say('A-7')[0].text, /^I can't find any vehicle or line like that\. If it's a road, for its closures and accidents: \/road A-7$/);
  assert.match(say('/status A-7')[0].text, /^A-7 road:\nThere are no closures/);
  assert.match(say('/start en-c-A7', 2002)[0].text, /^Done: I'll alert you about closures/, 'desde la web en inglés');
  say('/carretera A-7', 3003);
  // Un accidente que corta la carretera, de gravedad alta: el título de nuestro servidor, traducido; su lugar, tal cual.
  world.events = [dgt(at(), { severity: 'alta', closed: true }), dgt(at(), { id: 'eus:1', source: 'trafico-euskadi', road: 'A-7', province: null,
    title: 'Obras · BI-631 km 12.0', description: 'Bilbao', type: 'roadMaintenance', closed: true, lat: 43.26, lon: -2.93 })];
  const out = tick();
  const en = out.find((m) => m.chatId === CHAT && m.text.startsWith('A-7 road:')).text;
  assert.match(en, /^A-7 road:\n\n- Accident · A-7 km 1012\.0 · Marbella, Málaga\. Road closed\. Severity: high\. Since 06:00\.\n/);
  assert.match(en, /\n- Obras · BI-631 km 12\.0 · Bilbao\. Road closed\. Since 06:00\.\n/, 'lo de Tráfico de Euskadi, tal cual (su licencia)');
  assert.match(en, new RegExp(`${DGT.replace(/[().]/g, '\\$&')} · ${EUSKADI.replace(/[().]/g, '\\$&')}\\n\\nMore at https://radarespana\\.es/\\?lang=en$`));
  assertEnglish(en, 'aviso de carretera');
  const es = out.find((m) => m.chatId === 3003).text;
  assert.match(es, /^Carretera A-7:\n\n- Accidente · A-7 km 1012\.0 · Marbella, Málaga\. Carretera cortada\. Gravedad: alta\. Desde las 06:00\./, 'en español, igual que siempre');
  assert.match(say('/road A-7')[0].text, /^You already follow A-7 road\.\n\nNow:\nThere are 2 closures, accidents or serious incidents on the A-7 right now:\n- Accident/);
});

test('/journey en inglés: cómo se escribe, los días en inglés, la lista, los errores, cómo va y sus avisos', () => {
  const { say, press, world, tick } = setup();
  say('/language en');
  assert.match(say('/journey')[0].text, /^Tell me the two stations, the time window you leave in and the days:\n\/journey Alcalá de Henares > Atocha 7:00-9:00 Mon-Fri\n\n/);
  assert.match(say('/journey Alcalá > Atocha 7-9 sometimes')[0].text, /^I don't understand the days “sometimes”\. Write them like this: Mon-Fri, Sat-Sun/);
  assert.match(say('/journey Narnia > Atocha 6-9')[0].text, /^I can't find the station “Narnia” in the radar's catalogue\./);
  assert.match(say('/journey Alcalá Atocha 6-9')[0].text, /^Separate the two stations with “>”:\n\/journey /);
  const [list] = say('Alcalá > Atocha from 6 to 9 weekends');
  assert.equal(list.text, 'There are several stations with those names. Which one is your journey?');
  assert.equal(list.buttons[0][0].text, 'Alcalá de Henares → Madrid-Atocha Cercanías');
  assert.match(press(list.buttons[0][0].data).replies[0].text, /^Done: I'll alert you about Alcalá de Henares → Madrid-Atocha Cercanías \(06:00-09:00, on Saturdays and Sundays\)\.\n\nNow:\nToday isn't one of your days: I alert you on Saturdays and Sundays\./);
  world.vehicles = [md(3)];
  const [r] = say('/journey Alcalá de Henares > Madrid-Atocha Cercanías 6:00-9:00 Mon-Fri');
  assert.equal(r.text, "Done: I'll alert you about Alcalá de Henares → Madrid-Atocha Cercanías (06:00-09:00, Monday to Friday).\n\nNow:\n"
    + 'Trains in your time window visible now (time at Alcalá de Henares):\n- 07:10 Media Distancia 18001: running 3 min late. Next stop: Guadalajara.'
    + `\n\n${RENFE}\n\n/following to see what you follow · /unfollow to stop following it`);
  assertEnglish(r.text, '/journey');
  say('/journey Alcalá de Henares > Madrid-Atocha Cercanías 6-9 Mon,Wed,Fri');
  assert.match(say('/following')[0].text, /\n3\. Alcalá de Henares → Madrid-Atocha Cercanías \(06:00-09:00, on Mondays, Wednesdays and Fridays\)\n/);
  assert.match(say('/data')[0].text, /- Following: Alcalá de Henares → Madrid-Atocha Cercanías \(06:00-09:00, on Saturdays and Sundays\); /);
  // Sus avisos en la ronda: la cancelación (el título de nuestro servidor, traducido) y el retraso.
  world.events = [{
    id: 'renfe-cancelado:c:21516', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', credit: RENFE,
    title: 'Cercanías C2 21516 cancelado: Guadalajara → Madrid-Atocha Cercanías',
    trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C2', number: '21516', follow: [numberedServiceKey({ operator: 'Renfe', number: '21516' }), C2],
      stops: [stop(ST.gu, { time: '06:40' }), stop(ST.al, { time: '07:37' }), stop(ST.at, { time: '08:00' })] },
  }];
  world.vehicles = [md(17)];
  const msg = tick().find((m) => m.text.includes('Monday to Friday')).text;
  assert.equal(msg, 'Alcalá de Henares → Madrid-Atocha Cercanías (06:00-09:00, Monday to Friday):\n\n'
    + '- Cercanías C2 21516 cancelled: Guadalajara → Madrid-Atocha Cercanías. It was due through Alcalá de Henares at 07:37.\n'
    + '- Media Distancia 18001, the 07:10 from Alcalá de Henares, is running 17 min late. Next stop: Guadalajara.'
    + `\n\n${RENFE}\n\nMore at https://radarespana.es/?lang=en`);
  assertEnglish(msg.replaceAll('Cercanías', ''), 'aviso del trayecto');
  const status = say('/status').map((m) => m.text).join('\n\n');
  assert.match(status, /\n- 07:10 Media Distancia 18001: running 17 min late\. Next stop: Guadalajara\.\n/);
  assert.match(status, /\n- 07:37 Cercanías C2 21516: cancelled\.\n/);
  assert.match(status, /on Saturdays and Sundays\):\nToday isn't one of your days: I alert you on Saturdays and Sundays\./);
});

test('provincias en inglés: apagones de las islas, focos de calor (pedirlos y quitarlos, «fires» y «no fires») y tráfico', () => {
  const { say, world, tick, at } = setup();
  say('/language en');
  const [canarias] = say('/province Santa Cruz de Tenerife');
  assert.match(canarias.text, /\(emergency plans and power cuts\)\. Also about road closures and serious accidents \(not roadworks or traffic queues\)\. /);
  assert.match(canarias.text, new RegExp(['\\n\\nI also alert you about possible blackouts seen in the electricity demand of each island ',
    '\\(a Radar España estimate with Red Eléctrica data\\)\\. If you also want hotspots detected by satellite \\(possible wildfires, unconfirmed\\): ',
    '\\/province Santa Cruz de Tenerife fires$'].join('')));
  assertEnglish(canarias.text, '/province');
  // El apagón: la alerta de nuestro motor, con las plantillas de la web; la atribución, tal cual.
  const systems = [{ id: 'la-palma', name: 'La Palma', real: 7, programmed: 21, recentMax: 21, readMax: 21, at: at() - 10 * MIN, previous: { real: 7, at: at() - 15 * MIN } }];
  world.alerts = isolatedGridBlackouts({ now: at(), metrics: { [GRID_METRICS.aislados]: { systems } }, thresholds: DEFAULT_THRESHOLDS }).map((a) => ({ ...a, since: at() }));
  const [blackout] = tick();
  assert.match(blackout.text, /^Alerts in Santa Cruz de Tenerife:\n\nLa Palma electricity demand 67% below expected\. Actual 7 MW at .+ \(mainland time\) against 21 MW scheduled\. Radar España estimate with Red Eléctrica data: check it against the official notices\.\n\nFuente: Red Eléctrica\n\nMore at https:\/\/radarespana\.es\/\?lang=en$/s);
  // Los focos: «/province Granada fires»; el aviso, en inglés, con su atribución tal cual.
  const [granada] = say('/province Granada fires');
  assert.match(granada.text, /\nSatellite hotspots: none of the ones I alert about right now \(high confidence and high power\)\.\nRoads: no closures or serious accidents right now\.\n/);
  assert.match(granada.text, /I also alert you about hotspots detected by satellite that may be a wildfire: only the clearest ones, and they are never a confirmed fire\. To remove them: \/province Granada no fires$/);
  assert.match(say('/following')[0].text, /\n2\. Alerts in Granada \(with hotspots\)\n/);
  world.alerts = [];
  world.events = [{ id: 'firms:1', source: 'firms', category: 'incendio', type: 'foco', frp: 44.6, confidence: 'alta', lat: 37.05, lon: -3.35, start: at() }];
  const [fire] = tick();
  assert.match(fire.text, /^Alerts in Granada:\n\nPossible wildfire: a 45 MW hotspot, detected 10\/11, 06:0\d\. It is a satellite detection, not a confirmed fire: it may also be an agricultural burn or an industrial heat source\. Where: https:\/\/www\.openstreetmap\.org\/\?mlat=37\.0500&mlon=-3\.3500#map=13\/37\.0500\/-3\.3500\n\n/);
  assert.match(fire.text, new RegExp(`\\n\\n${FIRMS.replace(/[().]/g, '\\$&')}\\n\\nMore at `));
  assertEnglish(fire.text, 'foco de calor');
  assert.equal(say('/province Granada no fires')[0].text, "Done: in Granada I'll no longer alert you about hotspots; I still will about the rest of its alerts.");
  assert.equal(say('/province Granada without fires')[0].text, "In Granada I don't alert you about hotspots; I do about the rest of its alerts.");
  assert.equal(say('/province Soria no fires')[0].text, "You don't follow Soria. To follow it: /province Soria");
});

test('los avisos de Renfe de una estación en inglés: el título por defecto, traducido; el texto del aviso, tal cual', () => {
  const { say, world, tick } = setup();
  say(`/start en-${stopKey(ST.ma.code)}`);
  world.events = [{ id: 'renfe-aviso:1', source: 'renfe-avisos', category: 'ferroviario', type: 'aviso', title: 'Aviso Renfe', lat: ST.ma.lat, lon: ST.ma.lon,
    description: 'Ascensor de la estación Majadahonda que da acceso a la vía 2, se encuentra fuera de servicio.' }];
  const [m] = tick();
  assert.equal(m.text, 'Majadahonda station:\n\nRenfe notice: Ascensor de la estación Majadahonda que da acceso a la vía 2, se encuentra fuera de servicio.'
    + `\n\n${RENFE}\n\nMore at https://radarespana.es/?lang=en`);
  assert.match(say('/status')[0].text, /\nRenfe notices at the station:\n- Renfe notice: Ascensor de la estación Majadahonda/);
});
