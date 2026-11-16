import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endedRecord, endedSnapshot, eventShare, isShareId, noteEnded, parseSharePath, restoreEnded, sharePath, shareTime,
  stationShare, vehicleShare,
} from '../../server/domain/compartir.js';

// Lunes 16-11-2026, 11:42 en Madrid (10:42 UTC). Fijo: nada depende del reloj de la máquina.
const NOW = Date.UTC(2026, 10, 16, 10, 42);
const MIN = 60_000;

const accident = {
  id: 'dgt:23477355', source: 'dgt', category: 'carretera', type: 'accident', severity: 'alta', title: 'Accidente · A-7 km 214.0',
  description: 'Málaga, Málaga', road: 'A-7', province: 'Málaga', lat: 36.72, lon: -4.42, start: NOW - 30 * MIN, updated: NOW - 10 * MIN,
};

test('enlaces: ida y vuelta, con los «:» de los ids legibles y lo demás escapado', () => {
  assert.equal(sharePath('incidencia', 'dgt:18811074'), '/incidencia/dgt:18811074');
  const odd = 'rodalies:R1-R2:obras entre sants/clot ¿?';
  const path = sharePath('incidencia', odd);
  assert.ok(!path.slice('/incidencia/'.length).includes('/'), path);
  assert.deepEqual(parseSharePath(path), { kind: 'incidencia', id: odd });
  assert.deepEqual(parseSharePath('/estacion/71801'), { kind: 'estacion', id: '71801' });
  assert.deepEqual(parseSharePath('/vehiculo/renfe-ld:03063'), { kind: 'vehiculo', id: 'renfe-ld:03063' });
});

test('enlaces: lo que no es de compartir o trae un id que no vale, null', () => {
  assert.equal(sharePath('tren', 'x'), null);
  assert.equal(sharePath('incidencia', ''), null);
  assert.equal(sharePath('incidencia', 'a'.repeat(257)), null);
  for (const bad of ['/incidencia/', '/incidencia', '/incidencia/a/b', '/otra/x', '/incidencia/%E0%A4%A', '/incidencia/a%0Ab', '/incidencia/a%E2%80%A8b']) {
    assert.equal(parseSharePath(bad), null, bad);
  }
  assert.equal(isShareId('dgt:1'), true);
  assert.equal(isShareId(42), false);
});

test('horas: peninsular por defecto; en Canarias, la suya y dicho; el año sólo si no es el de ahora', () => {
  assert.equal(shareTime(NOW, { now: NOW }), '16/11, 11:42');
  assert.equal(shareTime(NOW, { now: NOW, canarias: true }), '16/11, 10:42 (hora de Canarias)');
  assert.equal(shareTime(NOW, { now: NOW, canarias: true, lang: 'en' }), '16/11, 10:42 (Canary Islands time)');
  assert.equal(shareTime(Date.UTC(2025, 11, 12, 7, 5), { now: NOW }), '12/12/2025, 08:05');
  assert.equal(shareTime(NOW, { now: NOW, dayOnly: true }), '16/11');
  assert.equal(shareTime(null, { now: NOW }), null);
});

test('incidencia en el directo: qué es, su gravedad, las horas de su fuente y que se ha comprobado ahora', () => {
  const card = eventShare(accident, { now: NOW, credit: 'Fuente: DGT' });
  assert.equal(card.kicker, 'Tráfico · gravedad alta');
  assert.equal(card.title, 'Accidente · A-7 km 214.0');
  assert.deepEqual(card.details, ['Inicio: 16/11, 11:12', 'Última revisión en su fuente: 16/11, 11:32']);
  assert.deepEqual(card.status, { active: true, text: 'Sigue en el directo del radar · comprobado: 16/11, 11:42' });
  assert.equal(card.credit, 'Fuente: DGT');
  assert.equal(card.path, '/incidencia/dgt:23477355');
  assert.deepEqual(card.point, { lon: -4.42, lat: 36.72 });
  assert.match(card.summary, /Málaga, Málaga · Inicio: 16\/11, 11:12/);
});

test('una incidencia que ya no sale en el directo nunca se da por «terminada» ni «retirada por su fuente»', () => {
  const card = eventShare(accident, { now: NOW, endedAt: NOW - 5 * MIN });
  assert.equal(card.status.active, false);
  assert.equal(card.status.text, 'Ya no está en el directo del radar · comprobado: 16/11, 11:37');
  assert.doesNotMatch(card.summary, /termin|retir/i);
});

test('la tarjeta cambia de versión cuando cambia lo que enseña, y no con lo que no enseña', () => {
  const a = eventShare(accident, { now: NOW });
  assert.equal(eventShare({ ...accident, province: 'Otra' }, { now: NOW }).version, a.version);
  assert.notEqual(eventShare({ ...accident, severity: 'muy alta' }, { now: NOW }).version, a.version);
  assert.notEqual(eventShare(accident, { now: NOW, endedAt: NOW }).version, a.version);
  assert.notEqual(eventShare(accident, { now: NOW, lang: 'en' }).version, a.version);
});

test('en inglés: lo que escribe el radar, traducido; el título de la fuente, tal cual', () => {
  const card = eventShare(accident, { now: NOW, lang: 'en' });
  assert.equal(card.kicker, 'Traffic · high severity');
  assert.equal(card.details[0], 'Start: 16/11, 11:12');
  assert.match(card.status.text, /^Still in the radar's live data/);
});

test('avisos: nivel de AEMET, emisión, ubicación aproximada y Canarias en su hora', () => {
  const warning = { id: 'aemet:x:0', source: 'aemet-avisos', category: 'meteo', type: 'lluvias', severity: 'media', level: 'naranja',
    title: 'Aviso naranja por lluvias · Gran Canaria', lat: 27.95, lon: -15.6, issued: NOW - 60 * MIN, start: NOW, approx: 'isla' };
  const card = eventShare(warning, { now: NOW });
  assert.equal(card.kicker, 'Aviso meteorológico · nivel naranja');
  assert.equal(card.color, '#ec835a');
  assert.equal(card.approx, true);
  assert.equal(card.details[0], 'Emitido: 16/11, 09:42 (hora de Canarias)');
});

test('una carretera cortada lo dice, salvo que ya lo diga su descripción', () => {
  const closed = { ...accident, closed: true };
  assert.equal(eventShare(closed, { now: NOW }).details[0], 'Carretera cortada');
  assert.notEqual(eventShare({ ...closed, description: 'Málaga · Carretera cortada' }, { now: NOW }).details[0], 'Carretera cortada');
});

test('un tren sin datos: desde cuándo lo echa en falta el radar, como en su ficha', () => {
  const missing = { id: 'renfe-sin-datos:02091', source: 'renfe-avisos', category: 'sin-datos', type: 'sin-datos', severity: 'baja', title: 'AVE 02091 sin datos', seen: NOW - 60 * MIN };
  assert.deepEqual(eventShare(missing, { now: NOW }).details, ['El radar lo echa en falta desde: 16/11, 10:42']);
});

test('cancelación: su viaje en el mapa y desde cuándo la ve el radar', () => {
  const cancel = { id: 'renfe-cancelado:1', source: 'renfe-avisos', category: 'cancelacion', type: 'cancelado', severity: 'alta',
    title: 'Cercanías C4 20257 cancelado', seen: NOW - 20 * MIN, lat: 40.24, lon: -3.77,
    trip: { stops: [{ lon: -3.77, lat: 40.24, name: 'Parla' }, { lon: -3.69, lat: 40.40, name: 'Atocha' }, { lon: null, lat: null }] } };
  const card = eventShare(cancel, { now: NOW });
  assert.deepEqual(card.route, [[-3.77, 40.24], [-3.69, 40.4]]);
  assert.deepEqual(card.details, ['Visto por el radar: 16/11, 11:22']);
});

test('vehículo: su retraso tal como lo publica su operador; la posición estimada, como aproximada', () => {
  const v = { id: 'renfe-ld:03063', mode: 'av', operator: 'Renfe', service: 'AVE', line: 'AVE', label: '03063', lat: 40.9, lon: -2.1,
    delay: 12, origin: 'Madrid', destination: 'Barcelona-Sants', next: 'Zaragoza-Delicias', fixTime: NOW - MIN };
  const card = vehicleShare(v, { now: NOW, credit: 'Origen de los datos: Renfe Operadora' });
  assert.equal(card.title, 'AVE 03063');
  assert.equal(card.kicker, 'Tren · Renfe');
  assert.deepEqual(card.details, ['Retraso: 12 min', 'Próxima parada: Zaragoza-Delicias']);
  assert.equal(card.status.text, 'En circulación · comprobado: 16/11, 11:41');
  const estimated = vehicleShare({ ...v, delay: null, estimated: true }, { now: NOW });
  assert.equal(estimated.approx, true);
  assert.deepEqual(estimated.details, ['Sin datos de retraso', 'Próxima parada: Zaragoza-Delicias', 'Posición estimada por su horario (aprox.)']);
});

test('estación: lo fijo, con la atribución de sus datos', () => {
  const card = stationShare({ code: '71801', name: 'Barcelona-Sants', place: 'Barcelona', province: 'Barcelona', lat: 41.38, lon: 2.14 });
  assert.equal(card.kicker, 'Estación de Renfe');
  assert.equal(card.description, 'Barcelona');
  assert.equal(card.credit, 'Origen de los datos: Renfe Operadora');
  assert.equal(card.status, null);
  const metro = stationShare({ code: 'metrobilbao:7', name: 'Abando', networkId: 'metrobilbao', network: 'Metro Bilbao', mode: 'metro', lat: 43.26, lon: -2.93,
    source: { credit: 'Metro Bilbao · CC BY 4.0' } });
  assert.equal(metro.kicker, 'Estación de Metro Bilbao');
  assert.equal(metro.credit, 'Metro Bilbao · CC BY 4.0');
});

test('terminadas: las que dejan de salir se apuntan una vez, las que vuelven salen, y caducan', () => {
  const ended = new Map();
  const b = { ...accident, id: 'dgt:2' };
  assert.equal(noteEnded(ended, [accident, b], [b], { now: NOW, keepMs: 3600_000, max: 10 }), 1);
  assert.equal(ended.get('dgt:23477355').endedAt, NOW);
  assert.equal(noteEnded(ended, [b], [b], { now: NOW + MIN, keepMs: 3600_000, max: 10 }), 0);
  // Vuelve a salir (su fuente estuvo caída un rato): ya no está entre las terminadas.
  noteEnded(ended, [b], [accident, b], { now: NOW + 2 * MIN, keepMs: 3600_000, max: 10 });
  assert.equal(ended.has('dgt:23477355'), false);
  noteEnded(ended, [accident, b], [], { now: NOW + 3 * MIN, keepMs: 3600_000, max: 10 });
  assert.equal(ended.size, 2);
  noteEnded(ended, [], [], { now: NOW + 3 * MIN + 3600_000, keepMs: 3600_000, max: 10 });
  assert.equal(ended.size, 0);
});

test('terminadas: con el tope, salen las más viejas', () => {
  const ended = new Map();
  for (let i = 0; i < 5; i++) noteEnded(ended, [{ ...accident, id: `dgt:${i}` }], [], { now: NOW + i, keepMs: 3600_000, max: 3 });
  assert.deepEqual([...ended.keys()], ['dgt:2', 'dgt:3', 'dgt:4']);
});

test('lo que se guarda de una terminada: lo que enseña su tarjeta, recortado', () => {
  const snap = endedSnapshot({ ...accident, description: 'x'.repeat(2000), trip: { stops: Array.from({ length: 200 }, (_, i) => ({ lon: i / 100, lat: 40, name: 'P' })) }, extra: 'no' });
  assert.ok(snap.description.length <= 500);
  assert.equal(snap.trip.stops.length, 80);
  assert.equal(snap.extra, undefined);
  assert.equal(snap.trip.stops[0].name, undefined);
});

test('lo guardado vuelve tal cual; lo caducado, lo del futuro y lo que no tiene su forma, fuera', () => {
  const ended = new Map();
  noteEnded(ended, [accident], [], { now: NOW, keepMs: 3600_000, max: 10 });
  const record = JSON.parse(JSON.stringify(endedRecord(ended)));
  record.ended.push({ event: { id: 'x', title: 'y', category: 'inventada' }, endedAt: NOW }, { event: { ...accident, id: 'z' }, endedAt: NOW + 3600_000 }, null, 'basura');
  const back = restoreEnded(record, { now: NOW + MIN, keepMs: 3600_000, max: 10 });
  assert.deepEqual([...back.keys()], ['dgt:23477355']);
  // Una hora después, la de antes ha caducado (y la «del futuro» ya es de ahora).
  assert.deepEqual([...restoreEnded(record, { now: NOW + 3600_000, keepMs: 3600_000, max: 10 }).keys()], ['z']);
  assert.equal(restoreEnded(null, { now: NOW, keepMs: 1, max: 1 }).size, 0);
});

test('totales de uso: lo guardado vuelve; lo que no es un entero positivo, a 0; sin nada, desde ahora', async () => {
  const { emptyShareTotals, restoreShareTotals } = await import('../../server/domain/compartir.js');
  const raw = { since: NOW - 1000, pages: { incidencia: { activa: 5, terminada: -1, desconocida: 'x' } }, cards: { dibujada: 2.5, servida: 7 } };
  const back = restoreShareTotals(raw, NOW);
  assert.equal(back.since, NOW - 1000);
  assert.deepEqual(back.pages.incidencia, { activa: 5, terminada: 0, desconocida: 0 });
  assert.deepEqual(back.cards, { dibujada: 0, servida: 7, rechazada: 0 });
  assert.deepEqual(restoreShareTotals(null, NOW), emptyShareTotals(NOW));
  assert.equal(restoreShareTotals({ since: NOW + 1 }, NOW).since, NOW); // del futuro no
});
