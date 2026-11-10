// «Siguiendo» en el navegador: lo que se guarda (sólo en localStorage, limpio y con tope), los botones de las
// fichas para cualquier tipo de vehículo, y los textos del estado de cada cosa seguida.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_MAX, FOLLOW_STORE_KEY, cleanFollowItems, createFollowStore, followAttention, followControls, followOptions,
  followStatusText, followingHtml,
} from '../../public/js/siguiendo.js';
import { lineKey, numberedServiceKey, scheduledServiceKey, stopKey } from '../../server/domain/seguir.js';

const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const BUS_27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const TRAM_RUN = scheduledServiceKey({ operator: 'Euskotren', line: 'TG1', origin: '99', departure: 13 * 3600 + 10 * 60 });
const STATION = stopKey('71801');

/** Un localStorage de mentira; `broken`, uno que no deja (modo privado estricto). */
function fakeStorage({ broken = false, initial = null } = {}) {
  const data = new Map(initial ? [[FOLLOW_STORE_KEY, initial]] : []);
  return {
    data,
    getItem: (k) => { if (broken) throw new Error('SecurityError'); return data.get(k) ?? null; },
    setItem: (k, v) => { if (broken) throw new Error('QuotaExceededError'); data.set(k, v); },
  };
}

test('se guarda con su clave, su nombre y su tipo; lo último que se marca, primero; y se puede quitar', () => {
  const storage = fakeStorage();
  let t = 1000;
  const store = createFollowStore(storage, () => t++);
  assert.equal(store.add({ key: AVANT, name: 'Avant 08058', mode: 'av' }), true);
  assert.equal(store.add({ key: BUS_27, name: 'Autobús 27 · EMT Málaga', mode: 'bus' }), true);
  assert.equal(store.add({ key: AVANT, name: 'otra vez' }), false, 'ya estaba');
  assert.equal(store.add({ key: 'no es una clave', name: 'x' }), false);
  assert.deepEqual(store.list().map((i) => [i.key, i.kind, i.mode]), [[BUS_27, 'linea', 'bus'], [AVANT, 'servicio', 'av']]);
  // Otra página (o un reinicio del navegador) lo lee igual.
  const again = createFollowStore(storage);
  assert.deepEqual(again.list().map((i) => i.name), ['Autobús 27 · EMT Málaga', 'Avant 08058']);
  assert.equal(store.toggle({ key: AVANT }), false);
  assert.equal(store.has(AVANT), false);
  again.reload();
  assert.equal(again.size, 1, 'reload: lo que ha cambiado otra pestaña');
});

test('sin almacenamiento, o si falla, funciona igual mientras dura la página', () => {
  for (const storage of [null, fakeStorage({ broken: true })]) {
    const store = createFollowStore(storage);
    assert.equal(store.add({ key: BUS_27, name: 'Autobús 27' }), true);
    assert.equal(store.has(BUS_27), true);
  }
  assert.deepEqual(createFollowStore(fakeStorage({ initial: '{no es json' })).list(), []);
});

test('lo guardado se limpia: claves válidas sin repetir, nombres acotados, tipos dados de alta y un tope', () => {
  const raw = { v: 1, items: [
    { key: AVANT, name: '  Avant 08058  ', mode: 'av', at: 5 },
    { key: AVANT, name: 'repetida' },
    { key: '<script>', name: 'mala' },
    { key: BUS_27, name: 'x'.repeat(500), mode: 'nave-espacial' },
    { key: STATION },
    null,
  ] };
  const items = cleanFollowItems(raw);
  assert.deepEqual(items.map((i) => i.key), [AVANT, BUS_27, STATION]);
  assert.equal(items[0].name, 'Avant 08058');
  assert.equal(items[1].name.length, 160);
  assert.equal(items[1].mode, null, 'un tipo que no está en el registro no se guarda');
  assert.equal(items[2].name, STATION, 'sin nombre, la clave');
  const many = Array.from({ length: 100 }, (_, i) => ({ key: lineKey({ operator: 'EMT Málaga', line: String(i) }), name: String(i) }));
  assert.equal(cleanFollowItems(many).length, FOLLOW_MAX);
  const store = createFollowStore(fakeStorage({ initial: JSON.stringify({ items: many }) }));
  assert.equal(store.full, true);
  assert.equal(store.add({ key: AVANT, name: 'Avant' }), false, 'con el tope, no se añade más');
});

test('qué se puede seguir de cada ficha, para cualquier tipo de vehículo', () => {
  const avant = { mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058', follow: [AVANT, AVANT_LINE] };
  assert.deepEqual(followOptions(avant).map((o) => [o.kind, o.what, o.name]), [
    ['servicio', 'este tren', 'Avant 08058'], ['linea', 'la línea Avant', 'Avant · Renfe']]);
  const c5 = { mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C5', label: '23719', area: 'Móstoles',
    follow: [numberedServiceKey({ operator: 'Renfe', number: '23719' }), lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C5' })] };
  assert.deepEqual(followOptions(c5).map((o) => [o.key, o.what, o.name]), [
    ['s-renfe-23719', 'este tren', 'Cercanías C5 23719'], ['l-renfe-Madrid-C5', 'la línea C5', 'Cercanías C5 · Renfe (Madrid)']]);
  const bus = { mode: 'bus', operator: 'EMT Málaga', line: '27', label: '661', follow: [BUS_27] };
  assert.deepEqual(followOptions(bus).map((o) => [o.what, o.name, o.mode]), [['la línea 27', 'Autobús 27 · EMT Málaga', 'bus']],
    'un feed sólo con GPS: sólo la línea');
  const tram = { mode: 'tranvia', operator: 'Euskotren', line: 'TG1', origin: 'Atxuri', follow: [TRAM_RUN] };
  assert.deepEqual(followOptions(tram).map((o) => [o.what, o.name]), [['este tranvía', 'Tranvía TG1 · Euskotren, el de las 13:10, desde Atxuri']]);
  const metro = { mode: 'metro', operator: 'Metro Bilbao', service: 'Metro Bilbao', follow: [lineKey({ operator: 'Metro Bilbao' })] };
  assert.equal(followOptions(metro)[0].what, 'toda la red de Metro Bilbao');
  // La ficha de una estación trae su clave sola, no una lista.
  assert.deepEqual(followOptions({ name: 'Valladolid-Campo Grande', follow: STATION }).map((o) => [o.kind, o.what, o.name]),
    [['parada', 'esta estación', 'Valladolid-Campo Grande']]);
  // Un tipo de vehículo nuevo funciona sin tocar nada: sólo hace falta su clave.
  const unknownMode = { mode: 'barco', operator: 'Naviera', line: 'Ría', follow: [lineKey({ operator: 'Naviera', line: 'Ría' })] };
  assert.equal(followOptions(unknownMode)[0].what, 'la línea Ría');
  assert.deepEqual(followOptions({ follow: ['no vale'] }), []);
  assert.deepEqual(followOptions(null), []);
});

test('los botones de una ficha: su estado, sus datos y sin HTML de los nombres', () => {
  const store = createFollowStore(null);
  store.add({ key: BUS_27, name: 'Autobús 27' });
  const html = followControls({ mode: 'bus', operator: 'EMT <b>Málaga</b>', line: '27', follow: [BUS_27] }, store);
  assert.match(html, /data-follow="l-emtmalaga-27"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /★<\/span> Siguiendo la línea 27/);
  assert.doesNotMatch(html, /<b>/, 'el nombre del operador, escapado');
  assert.match(followControls({ mode: 'av', operator: 'Renfe', label: '08058', follow: [AVANT] }, store), /aria-pressed="false"[^>]*>.*☆<\/span> Seguir este tren/s);
  assert.equal(followControls({ follow: [] }, store), '', 'sin claves, ni el recuadro');
});

const status = (over) => ({ key: AVANT, kind: 'servicio', mode: 'av', vehicles: { total: 0, withDelayInfo: 0, delayed: 0, list: [] }, events: { total: 0, active: 0, list: [] }, ...over });
const train = (over = {}) => ({ id: 'renfe-ld:08058', mode: 'av', delay: 12, destination: 'Madrid-Chamartín-Clara Campoamor', next: 'Segovia-Guiomar', ...over });

test('el estado de un servicio, sin inventar: circula, cancelado, sin datos o no se ve', () => {
  const item = { key: AVANT, kind: 'servicio', mode: 'av' };
  assert.deepEqual(followStatusText(item, status({ state: 'circula', vehicles: { total: 1, withDelayInfo: 1, delayed: 1, list: [train()] } })),
    { text: '12 min de retraso · hacia Madrid-Chamartín-Clara Campoamor · próxima parada: Segovia-Guiomar.', sev: 'media' });
  assert.match(followStatusText(item, status({ state: 'circula', vehicles: { total: 1, list: [train({ delay: 0, stopped: true, current: 'Segovia-Guiomar' })] } })).text,
    /^En hora · hacia .* · parado en Segovia-Guiomar\.$/);
  assert.match(followStatusText(item, status({ state: 'circula', vehicles: { total: 1, list: [train({ delay: null })] } })).text, /^Su operador no publica su retraso/);
  const cancelled = { id: 'c', category: 'cancelacion', type: 'cancelado', title: 'Avant 08058 cancelado: Valladolid 06:23 → Madrid' };
  assert.deepEqual(followStatusText(item, status({ state: 'cancelado', events: { total: 1, active: 1, list: [cancelled] } })),
    { text: 'Cancelado: su operador lo da como cancelado.', sev: 'alta' });
  assert.equal(followStatusText(item, status({ state: 'sin-datos' })).sev, 'media');
  assert.equal(followStatusText(item, status({ state: 'no-se-ve' })).text, 'No circula ahora o su operador no lo publica.');
  assert.equal(followStatusText(item, undefined).text, 'Consultando…');
  assert.match(followStatusText(item, { error: true }).text, /No se ha podido consultar/);
  assert.match(followStatusText({ kind: 'parada' }, undefined).text, /abrir su ficha/);
});

test('el estado de una línea, con el nombre de su tipo de vehículo y sus incidencias', () => {
  const item = { key: BUS_27, kind: 'linea', mode: 'bus' };
  const cancel = { id: 'x', category: 'cancelacion', type: 'parcial', title: 'Línea 27: no para en Alameda' };
  assert.deepEqual(followStatusText(item, status({ key: BUS_27, kind: 'linea', mode: 'bus', state: 'circulan',
    vehicles: { total: 12, withDelayInfo: 12, delayed: 3, list: [] }, events: { total: 1, active: 1, list: [cancel] } })),
  { text: '12 autobuses circulando · 3 con 5 min de retraso o más · 1 cancelación.', sev: 'alta' });
  assert.equal(followStatusText(item, status({ key: BUS_27, kind: 'linea', mode: 'bus', state: 'circulan', vehicles: { total: 1, withDelayInfo: 0, delayed: 0, list: [] } })).text,
    '1 autobús circulando · su operador no publica retrasos.');
  assert.equal(followStatusText({ kind: 'linea', mode: 'metro' }, status({ kind: 'linea', mode: null, state: 'ninguno' })).text,
    'Ningún metro circula ahora o su operador no lo publica.', 'sin vehículos, el tipo de lo guardado');
});

test('la lista: lo que se sigue, su estado, sus cancelaciones, la atribución y si hay que encender una capa', () => {
  const items = [{ key: AVANT, kind: 'servicio', name: 'Avant <08058>', mode: 'av' }, { key: BUS_27, kind: 'linea', name: 'Autobús 27', mode: 'bus' }];
  const statuses = new Map([
    [AVANT, status({ state: 'cancelado', events: { total: 1, active: 1, list: [{ id: 'c1', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', title: 'Cancelado', credit: 'Origen de los datos: Renfe Operadora' }] } })],
    [BUS_27, status({ key: BUS_27, kind: 'linea', mode: 'bus', state: 'circulan', vehicles: { total: 2, withDelayInfo: 0, delayed: 0, list: [{ id: 'b', source: 'emt-malaga', operator: 'EMT Málaga' }] } })],
  ]);
  const html = followingHtml(items, statuses, {
    sourceCredit: (id) => (id === 'emt-malaga' ? 'Fuente: EMT Málaga' : null),
    needsLayer: (item) => (item.mode === 'bus' ? 'Autobús' : null),
  });
  assert.match(html, /Avant &lt;08058&gt;/);
  assert.match(html, /data-kind="event" data-id="c1"/, 'su cancelación se abre como en Incidencias');
  assert.match(html, /data-follow-remove="l-emtmalaga-27"/);
  assert.match(html, /se encenderá la capa «Autobús»/);
  assert.match(html, /Datos: Origen de los datos: Renfe Operadora · Fuente: EMT Málaga/);
  assert.match(html, /sólo en este navegador/);
  assert.match(followingHtml([], new Map()), /Aún no sigues nada/);
  assert.equal(followAttention(items, statuses), 1);
});

test('lista de «Siguiendo»: el botón de Telegram de cada cosa y la explicación, sólo si hay bot', async () => {
  const { followingHtml } = await import('../../public/js/siguiendo.js');
  const items = [{ key: 'l-emtmalaga-27', kind: 'linea', name: 'Autobús 27 · EMT Málaga', mode: 'bus', at: 1 }];
  const sin = followingHtml(items, new Map());
  assert.doesNotMatch(sin, /tg-mini|follow-tg-hint/);
  const con = followingHtml(items, new Map(), { telegram: (item) => `<a class="tg-mini" data-k="${item.key}">Avisos en Telegram</a>` });
  assert.match(con, /<a class="tg-mini" data-k="l-emtmalaga-27">Avisos en Telegram<\/a>/);
  assert.match(con, /follow-tg-hint/);
});
