// «Siguiendo»: el estado de lo que alguien sigue (un servicio, una línea o una parada de cualquier tipo de
// vehículo) a partir de sus claves, y su nombre con lo que se sabe de quien las lleva.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_DELAYED_MIN, FOLLOW_LIST_MAX, followName, followStatus, indexByFollow, knownFor } from '../../server/domain/siguiendo.js';
import { lineKey, numberedServiceKey, scheduledServiceKey, stopKey } from '../../server/domain/seguir.js';

const AVANT = numberedServiceKey({ operator: 'Renfe', number: '08058' });
const AVANT_LINE = lineKey({ operator: 'Renfe', line: 'Avant' });
const R16 = lineKey({ operator: 'Renfe', scope: 'Catalunya', line: 'R16' });
const BUS_27 = lineKey({ operator: 'EMT Málaga', line: '27' });
const BUS_RUN = scheduledServiceKey({ operator: 'AMB', line: 'V15', origin: '1234', departure: 7 * 3600 + 32 * 60 });
const METRO = lineKey({ operator: 'Metro Bilbao' });

const avant = (over = {}) => ({
  id: 'renfe-ld:08058', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058',
  delay: 0, origin: 'Valladolid-Campo Grande', destination: 'Madrid-Chamartín-Clara Campoamor', follow: [AVANT, AVANT_LINE], ...over,
});
const bus = (id, delay, over = {}) => ({ id, source: 'emt-malaga', mode: 'bus', operator: 'EMT Málaga', line: '27', label: id, delay, follow: [BUS_27], ...over });
const cancellation = (over = {}) => ({
  id: 'renfe-cancelado:ld:08058', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', severity: 'alta',
  title: 'Avant 08058 cancelado: Valladolid-Campo Grande 06:23 → Madrid-Chamartín-Clara Campoamor', credit: 'Origen de los datos: Renfe Operadora',
  trip: { mode: 'av', operator: 'Renfe', service: 'Avant', line: null, number: '08058', origin: 'Valladolid-Campo Grande', follow: [AVANT, AVANT_LINE] },
  ...over,
});

test('el nombre de cada clave, con lo que se sabe de quien la lleva', () => {
  assert.equal(followName(AVANT, avant()), 'Avant 08058');
  assert.equal(followName(BUS_27, bus('661', 2)), 'Autobús 27 · EMT Málaga');
  assert.equal(followName(BUS_RUN, { mode: 'bus', operator: 'AMB', line: 'V15', origin: 'Pg. Maragall' }), 'Autobús V15 · AMB, el de las 07:32, desde Pg. Maragall');
  assert.equal(followName(METRO, { mode: 'metro', operator: 'Metro Bilbao', service: 'Metro Bilbao' }), 'Metro Bilbao: toda la red');
  assert.equal(followName(stopKey('71801'), { name: 'Valladolid-Campo Grande' }), 'Valladolid-Campo Grande');
  // Cercanías: con el núcleo de su clave, nunca el municipio donde está el vehículo (area).
  const c4 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' });
  assert.equal(c4, 'l-renfe-Madrid-C4a');
  assert.equal(followName(c4, { mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C4a', area: 'Getafe' }), 'Cercanías C4a · Renfe (Madrid)');
  assert.equal(followName(AVANT_LINE, avant({ area: 'Orihuela' })), 'Avant · Renfe', 'la línea es el propio producto: sin repetirlo');
});

test('un viaje juntado de dos feeds: cada línea con su producto, el de la otra sacado de alsoIn', () => {
  const re = lineKey({ operator: 'Renfe', line: 'Regional Exprés' });
  const trip = { mode: 'md', operator: 'Renfe', service: 'Regional Exprés', line: 'R16', number: '18093',
    alsoIn: [{ as: 'Rodalies R16 18093', follow: ['s-renfe-18093', R16] }] };
  assert.equal(followName(re, trip), 'Regional Exprés · Renfe');
  assert.equal(followName(R16, trip), 'Rodalies R16 · Renfe (Catalunya)', 'no «Regional Exprés R16»');
  // Sin saber de qué feed viene, el tipo de vehículo antes que un producto que no es el suyo.
  assert.equal(followName(R16, { ...trip, alsoIn: [{ as: 'Otra cosa', follow: [R16] }] }), 'Tren R16 · Renfe (Catalunya)');
  assert.deepEqual(knownFor('no-es-una-clave', trip), {});
});

test('índice por clave: vehículos y las incidencias que la llevan en su viaje (o en sí mismas)', () => {
  const generic = { id: 'aviso-1', category: 'ferroviario', type: 'aviso', severity: 'media', title: 'Aviso', follow: [R16] };
  const index = indexByFollow([avant(), bus('661', 2), bus('663', 7)], [cancellation(), generic]);
  assert.equal(index.get(AVANT).vehicles.length, 1);
  assert.equal(index.get(AVANT).events.length, 1);
  assert.equal(index.get(BUS_27).vehicles.length, 2);
  assert.equal(index.get(R16).events[0].id, 'aviso-1');
  assert.equal(index.get('l-nadie'), undefined);
});

test('un servicio: circula, cancelado, con paradas suprimidas, sin datos, retirado o no se ve', () => {
  const state = (entry) => followStatus(AVANT, entry).state;
  assert.equal(state({ vehicles: [avant({ delay: 12 })] }), 'circula');
  assert.equal(state({ events: [cancellation()] }), 'cancelado');
  assert.equal(state({ events: [cancellation({ type: 'parcial' })] }), 'parcial');
  assert.equal(state({ events: [{ ...cancellation(), id: 'renfe-sin-datos:08058', category: 'sin-datos', type: 'sin-datos' }] }), 'sin-datos');
  assert.equal(state({ events: [cancellation({ withdrawn: 123 })] }), 'cancelado-retirado');
  assert.equal(state({}), 'no-se-ve', 'no se sabe si no circula o si su operador no lo publica');
  assert.equal(state(undefined), 'no-se-ve');
  // Si su operador lo da en servicio y también cancelado, se ve y la cancelación va en la lista.
  const both = followStatus(AVANT, { vehicles: [avant()], events: [cancellation()] });
  assert.equal(both.state, 'circula');
  assert.equal(both.events.list[0].id, 'renfe-cancelado:ld:08058');
  assert.equal(both.name, 'Avant 08058');
  assert.equal(both.mode, 'av');
});

test('una línea: cuántos circulan, cuántos dan su retraso y cuántos van con retraso; sus incidencias, las en vigor primero', () => {
  const late = bus('663', FOLLOW_DELAYED_MIN);
  const unknown = bus('664', null, { late: true });
  const noInfo = bus('665', null);
  const s = followStatus(BUS_27, {
    vehicles: [bus('661', 2), late, unknown, noInfo],
    events: [{ id: 'old', category: 'cancelacion', type: 'parcial', title: 'Ya no', withdrawn: 5 }, { id: 'now', category: 'cancelacion', type: 'parcial', title: 'Ahora' }],
  });
  assert.equal(s.state, 'circulan');
  assert.deepEqual([s.vehicles.total, s.vehicles.withDelayInfo, s.vehicles.delayed], [4, 3, 2]);
  assert.equal(s.vehicles.list[0].id, '663', 'primero los que van con más retraso');
  assert.deepEqual(s.events.list.map((e) => e.id), ['now', 'old']);
  assert.deepEqual([s.events.total, s.events.active], [2, 1]);
  assert.equal(s.name, 'Autobús 27 · EMT Málaga');
  assert.equal(followStatus(BUS_27, {}).state, 'ninguno');
  assert.equal(followStatus(BUS_27, {}).name, 'Línea 27 · emtmalaga', 'sin nada que lo nombre, lo que se lee de la clave');
});

test('acotado: una línea con cientos de vehículos da sólo los primeros; una clave que no vale, nada', () => {
  const many = Array.from({ length: 300 }, (_, i) => bus(String(i), i % 30));
  const s = followStatus(BUS_27, { vehicles: many });
  assert.equal(s.vehicles.total, 300);
  assert.equal(s.vehicles.list.length, FOLLOW_LIST_MAX);
  assert.deepEqual(Object.keys(s.vehicles.list[0]).sort(), ['delay', 'destination', 'current', 'id', 'label', 'line', 'mode', 'next', 'operator', 'origin', 'service', 'source'].sort(),
    'sólo lo que hace falta para la lista');
  assert.equal(followStatus('x-nada'), null);
  assert.equal(followStatus(stopKey('71801')).state, 'parada');
});

test('una línea de tren con un autobús que la sustituye en un tramo (misma clave): se llama y es de tipo tren', () => {
  const C3 = lineKey({ operator: 'Renfe', scope: 'Valencia', line: 'C3' });
  const train = (label) => ({ id: `t${label}`, mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C3', label, delay: 0, follow: [C3] });
  const bus = { id: 'b1', mode: 'bus', operator: 'Renfe', service: 'Autobús de Renfe', line: 'C3', label: '9001', delay: null, follow: [C3] };
  const s = followStatus(C3, { vehicles: [bus, train('35001'), train('35003')], events: [] });
  assert.equal(s.mode, 'cercanias');
  assert.equal(s.name, 'Cercanías C3 · Renfe (Valencia)');
  assert.equal(s.vehicles.total, 3, 'el autobús sigue contando entre los de la línea');
  assert.equal(followStatus(C3, { vehicles: [bus], events: [] }).mode, 'bus', 'si sólo se ve el autobús, es lo que hay');
});

test('el número de cancelaciones es el de todas, aunque la lista vaya recortada', () => {
  const C = lineKey({ operator: 'Renfe', line: 'Regional' });
  const events = Array.from({ length: FOLLOW_LIST_MAX + 15 }, (_, i) => ({ id: `c${i}`, category: 'cancelacion', type: 'cancelado', title: `Regional ${i}` }));
  events.push({ id: 'aviso', category: 'ferroviario', title: 'Obras' }, { id: 'vieja', category: 'cancelacion', type: 'cancelado', title: 'Ya no', withdrawn: 1 });
  const s = followStatus(C, { vehicles: [], events });
  assert.equal(s.events.list.length, FOLLOW_LIST_MAX);
  assert.deepEqual([s.events.total, s.events.active, s.events.cancellations], [FOLLOW_LIST_MAX + 17, FOLLOW_LIST_MAX + 16, FOLLOW_LIST_MAX + 15]);
});
