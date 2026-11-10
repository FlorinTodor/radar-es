// Las fichas y «Siguiendo» con la web en inglés: nuestras palabras traducidas y los nombres (estaciones,
// líneas, operadores) tal cual. Cada fichero de test va en su propio proceso: aquí se elige el inglés antes de
// cargar los módulos, como hace el navegador (sus constantes se traducen al cargarlos).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useLang } from '../../public/js/i18n.js';
import { EN } from '../../public/js/i18n/en.js';
import { MODES } from '../../server/domain/modos.js';
import { lineKey, numberedServiceKey, scheduledServiceKey, stopKey } from '../../server/domain/seguir.js';

await useLang('en');
const { followButtonText, followControls, followNameText, followOptions, followStatusText, followingHtml } = await import('../../public/js/siguiendo.js');
const { setTelegram, telegramFollow, telegramLink } = await import('../../public/js/avisar.js');
const { noDelayHtml, punctualityHtml } = await import('../../public/js/puntualidad.js');
const { stopTipHtml, stopsListHtml } = await import('../../public/js/trip-stops.js');

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
// Palabras nuestras en español que no deberían quedar (los nombres de las pruebas no las llevan).
const SPANISH = /\b(de|del|la|las|los|el|con|sin|hoy|parado|retraso|hacia|línea|estación|siguiendo|seguir|circula|cancelad[oa]s?|paradas?|días?)\b/i;
const noSpanish = (s, what) => assert.doesNotMatch(s, SPANISH, `${what}: «${s}»`);

const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const BUS_27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const TRAM_RUN = scheduledServiceKey({ operator: 'Euskotren', line: 'TG1', origin: '99', departure: 13 * 3600 + 10 * 60 });

test('los nombres de los tipos de vehículo del dominio están en el diccionario', () => {
  for (const m of MODES) {
    for (const word of [m.noun, m.nounPlural, m.label]) assert.ok(word in EN, `«${word}» (${m.id})`);
  }
  assert.ok('servicio' in EN);
});

test('los nombres de lo que se sigue: nuestras palabras en inglés, los nombres tal cual', () => {
  assert.equal(followNameText('Autobús 27 · EMT Málaga'), 'Bus 27 · EMT Málaga');
  assert.equal(followNameText('Tranvía TG1 · Euskotren, el de las 13:10, desde Atxuri'), 'Tram TG1 · Euskotren, departing 13:10, from Atxuri');
  assert.equal(followNameText('Línea 710 · ALSA'), 'Line 710 · ALSA');
  assert.equal(followNameText('Servicio · ALSA, el de las 08:05'), 'Service · ALSA, departing 08:05');
  assert.equal(followNameText('Metro Bilbao: toda la red'), 'Metro Bilbao: whole network');
  assert.equal(followNameText('Línea (sin nombre legible) · Renfe'), 'Line (no readable name) · Renfe');
  // Sin palabras nuestras: igual.
  for (const name of ['Cercanías C5 23719', 'Avant · Renfe', 'Cercanías C5 · Renfe (Madrid)', 'Valladolid-Campo Grande', 'Metro 1 · Metro de Madrid']) {
    assert.equal(followNameText(name), name);
  }
});

test('qué se puede seguir de cada ficha y su botón', () => {
  const avant = { mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058', follow: [AVANT, AVANT_LINE] };
  assert.deepEqual(followOptions(avant).map((o) => o.what), ['this train', 'line Avant']);
  const tram = { mode: 'tranvia', operator: 'Euskotren', line: 'TG1', origin: 'Atxuri', follow: [TRAM_RUN] };
  assert.deepEqual(followOptions(tram).map((o) => o.what), ['this tram']);
  const metro = { mode: 'metro', operator: 'Metro Bilbao', service: 'Metro Bilbao', follow: [lineKey({ operator: 'Metro Bilbao' })] };
  assert.equal(followOptions(metro)[0].what, 'the whole Metro Bilbao network');
  assert.equal(followOptions({ mode: 'bus', follow: stopKey('7180') })[0].what, 'this stop');
  assert.equal(text(followButtonText('this train', false)), '☆ Follow this train');
  assert.equal(text(followButtonText('this train', true)), '★ Following this train');
  const controls = followControls(tram, { has: () => false });
  assert.match(controls, /aria-label="Follow in “Following”"/);
  assert.match(controls, /title="Tram TG1 · Euskotren, departing 13:10, from Atxuri"/);
  assert.match(controls, /data-follow-name="Tranvía TG1 · Euskotren, el de las 13:10, desde Atxuri"/, 'se guarda el nombre del dominio');
});

test('el estado de lo que se sigue, en inglés', () => {
  const vehicle = { delay: 12, destination: 'Atocha', next: 'Getafe', mode: 'cercanias' };
  const running = followStatusText({ kind: 'servicio' }, { state: 'circula', vehicles: { total: 1, list: [vehicle] } });
  assert.equal(running.text, '12 min late · to Atocha · next stop: Getafe.');
  const line = followStatusText({ kind: 'linea', mode: 'bus' }, {
    state: 'circulan', mode: 'bus', vehicles: { total: 7, withDelayInfo: 7, delayed: 2, list: [] },
    events: { active: 3, cancellations: 1, list: [] },
  });
  assert.equal(line.text, '7 buses running · 2 at least 5 min late · 1 cancellation and 2 notices.');
  assert.equal(followStatusText({ kind: 'linea', mode: 'tranvia' }, { state: 'ninguno', mode: 'tranvia', vehicles: { total: 0 } }).text,
    'No tram running now, or its operator does not publish it.');
  for (const state of ['cancelado', 'parcial', 'sin-datos', 'cancelado-retirado', 'no-se-ve', 'raro']) {
    noSpanish(followStatusText({ kind: 'servicio' }, { state }).text, state);
  }
  noSpanish(followStatusText({ kind: 'parada' }).text, 'parada');
  noSpanish(followStatusText({ kind: 'servicio' }).text, 'consultando');
  noSpanish(followStatusText({ kind: 'servicio' }, { error: true }).text, 'error');
});

test('la lista «Siguiendo» en inglés, con los títulos del servidor pasados por tx y las atribuciones tal cual', () => {
  assert.match(text(followingHtml([], new Map())), /^You are not following anything yet\. Open the card/);
  const items = [{ key: BUS_27, kind: 'linea', mode: 'bus', name: 'Autobús 27 · EMT Málaga' }];
  const status = { state: 'circulan', mode: 'bus', vehicles: { total: 2, withDelayInfo: 0, delayed: 0, list: [{ source: 'emt-malaga' }] },
    events: { active: 5, cancellations: 0, list: [{ id: 'e1', title: 'EMT Málaga · Desvío', source: 'emt-malaga' }] } };
  const html = followingHtml(items, new Map([[BUS_27, status]]), {
    sourceCredit: () => 'Origen de los datos: EMT Málaga', needsLayer: () => 'Autobús', telegram: () => '',
  });
  const t = text(html);
  assert.match(t, /^What you follow · tap one to see it on the map Line · Bus × Bus 27 · EMT Málaga 2 buses running · its operator does not publish delays · 5 notices\./);
  assert.match(t, /EMT Málaga · Desvío and 4 more/, 'el aviso de la fuente, tal cual');
  assert.match(t, /To show it on the map, the “Bus” layer will be turned on\./);
  assert.match(t, /Data: Origen de los datos: EMT Málaga/, 'la atribución, con sus palabras');
  assert.match(html, /aria-label="Unfollow Bus 27 · EMT Málaga" title="Unfollow"/);
});

test('el botón de Telegram dice que el bot habla en español', () => {
  setTelegram({ telegram: { bot: 'RadarEspanaBot' } }, [{ id: 'av', noun: 'tren' }, { id: 'bus', noun: 'autobús' }]);
  const service = text(telegramFollow([AVANT, AVANT_LINE], 'av', { service: 'Avant' }));
  assert.equal(service, 'Alert me on Telegram (in Spanish) if this train is cancelled or delayed or about all Avant services');
  assert.match(text(telegramFollow([BUS_27], 'bus')), /about cancellations and notices for line 27$/);
  assert.match(text(telegramFollow([stopKey('7180')], 'bus')), /about cancellations its operator publishes at this station$/);
  assert.match(telegramLink(BUS_27, 'Autobús 27 · EMT Málaga'), /aria-label="Telegram alerts for Bus 27 · EMT Málaga \(the bot writes in Spanish\)"/);
  setTelegram({}, []);
});

test('las paradas del viaje, en inglés', () => {
  const stops = [
    { name: 'Atxuri', time: '13:10', passed: true },
    { name: 'Bolueta', time: '13:20', eta: '13:24', passed: false, here: true },
    { name: 'Durango', time: '13:50', eta: '13:55', passed: false },
  ];
  assert.match(text(stopsListHtml({ stops }, { open: true })), /^Stops · 1 of 3 left Atxuri 13:10 Bolueta stopped here · 13:20 · expected 13:24 Durango 13:50 · expected 13:55$/);
  assert.match(text(stopsListHtml({ stops: stops.map((s) => ({ ...s, passed: true, here: false })) })), /^Stops · already arrived at Durango/);
  assert.match(stopsListHtml({ stops: [...stops, { name: 'Bilbao', passed: false }], partial: true }), /aria-label="stops the source does not give"/);
  assert.equal(text(stopTipHtml({ name: 'Durango', i: 2, next: 1, when: '13:50' }, 3)), 'Durango Destination · next stop · 13:50');
  assert.equal(text(stopTipHtml({ name: 'Bolueta', i: 1, skipped: 1 }, 3)), 'Bolueta skipped');
});

test('la puntualidad, en inglés', () => {
  const day = (n) => new Date(Date.UTC(2026, 10, 10 + n)).toISOString().slice(0, 10);
  const service = text(punctualityHtml({
    kind: 'servicio', days: [{ day: day(-1), status: 'tarde', delay: 12, max: 15 }, { day: day(0), status: 'en-curso', delay: 6, max: 6 }],
    recent: { days: 11, late: 7, cancelled: 1 }, now: { day: day(0), delay: 6 }, firstSeen: day(-1),
  }));
  assert.match(service, /^Punctuality Today it is running \+6 min late\. It arrived 5 min or more late on 7 of the last 10 days it ran\. Cancelled on 1 day\. The radar has tracked it since Mon 9 Nov\./);
  assert.match(service, /\+ 5 min or more late … in progress$/);
  const line = punctualityHtml({ kind: 'linea', mode: 'cercanias', days: [{ day: day(0), samples: 200, lateShare: 0.18, vehicles: 34, cancelled: 3 }],
    summary: { samples: 400, lateShare: 0.1 } }, { nounPlural: () => 'trenes' });
  assert.match(text(line), /^Punctuality Its line\. Today, 18% of readings 5 min or more late \(34 trains with data\)\. 3 cancellations today\. Previous days: 10%\./);
  assert.match(line, /title="Tue 10 Nov: 18% of readings 5 min or more late \(34 trains\), 3 cancellations"/);
  noSpanish(text(noDelayHtml()), 'sin retraso');
});
