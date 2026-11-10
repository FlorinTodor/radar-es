// Cancelaciones: qué dice el tiempo real de cada viaje (Renfe repite un viaje en varias entradas), qué
// parte se ha suprimido, desde cuándo lo ve el radar y la incidencia que se arma con todo eso.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANCELLATION_UNCONFIRMED_MS, MISSING_TRAIN_TTL_MS, cancellationEvent, followWithdrawn, missingTrainEvent, noticesAbout, skippedPart, stampSeen, tripChanges,
  withdrawnCancellation,
} from '../../server/domain/cancelaciones.js';

const entity = (tripId, relation, skipped = [], extra = {}) => ({
  tripUpdate: { trip: { tripId, scheduleRelationship: relation, ...extra }, stopTimeUpdate: skipped.map((stopId) => ({ stopId, scheduleRelationship: 'SKIPPED' })) },
});

test('tripChanges junta las entradas de un viaje: cancelado, en servicio y paradas suprimidas sin repetir', () => {
  const feed = { entity: [
    entity('0408712026-11-05', 'SCHEDULED'),
    entity('0408712026-11-05', 'SCHEDULED', ['11208', '11400', '11400']),
    entity('0408712026-11-05', 'CANCELED'),
    entity('0029112026-11-05', 'CANCELED'),
    entity('0029122026-11-05', 'CANCELED'),
    entity('0019012026-11-05', 'SCHEDULED'), // sin nada suprimido: no sale
    { id: 'sin-viaje' },
  ] };
  const byNumber = tripChanges(feed, (id) => id.slice(0, 5));
  assert.deepEqual([...byNumber.keys()], ['04087', '00291']);
  const partial = byNumber.get('04087');
  assert.equal(partial.cancelled, true);
  assert.equal(partial.running, true);
  assert.deepEqual(partial.skipped.map((s) => s.stopId), ['11208', '11400']);
  const whole = byNumber.get('00291');
  assert.deepEqual(whole.tripIds, ['0029112026-11-05', '0029122026-11-05'], 'las dos variantes del mismo tren');
  assert.equal(whole.running, false);
  assert.equal(whole.startDate, null, 'Renfe no dice el día');
});

test('tripChanges: DELETED también es cancelado; la parada suprimida vale por su secuencia; el día si lo dice', () => {
  const feed = { entity: [
    entity('A', 'DELETED', [], { startDate: '20261105' }),
    { tripUpdate: { trip: { tripId: 'B' }, stopTimeUpdate: [{ stopSequence: 3, scheduleRelationship: 'SKIPPED' }, { stopSequence: 4 }] } },
  ] };
  const changes = tripChanges(feed);
  assert.equal(changes.get('A').cancelled, true);
  assert.equal(changes.get('A').startDate, '20261105');
  assert.deepEqual(changes.get('B').skipped, [{ stopId: null, stopSequence: 3 }]);
  assert.equal(changes.get('B').cancelled, false);
});

test('skippedPart: las últimas (termina antes), las primeras (empieza después), intermedias o todas', () => {
  assert.deepEqual(skippedPart(5, [3, 4]), { part: 'final', endsAt: 2 });
  assert.deepEqual(skippedPart(5, [0, 1]), { part: 'inicio', startsAt: 2 });
  assert.deepEqual(skippedPart(5, [2]), { part: 'intermedias' });
  assert.deepEqual(skippedPart(5, [1, 3, 4]), { part: 'intermedias' }, 'no seguidas: no es que termine antes');
  assert.deepEqual(skippedPart(3, [2, 0, 1]), { part: 'todas' });
});

test('stampSeen: las que siguen guardan su hora, las nuevas la de ahora y las que ya no están se olvidan', () => {
  const previous = new Map([['a', 100], ['b', 200]]);
  const { seen, added, removed } = stampSeen(previous, ['a', 'c', 'c'], 900);
  assert.deepEqual([...seen], [['a', 100], ['c', 900]]);
  assert.deepEqual(added, ['c']);
  assert.equal(removed, 1);
});

const STOPS = [
  { name: 'Badajoz', time: 6 * 3600 + 29 * 60, at: [-6.98, 38.89] },
  { name: 'Mérida', time: 7 * 3600 + 4 * 60, at: [-6.34, 38.92] },
  { name: 'Cáceres', time: 7 * 3600 + 40 * 60, at: [-6.37, 39.46] },
  { name: 'Madrid-Chamartín-Clara Campoamor', time: 11 * 3600 + 7 * 60, at: [-3.68, 40.47] },
];
const base = {
  id: 'renfe-cancelado:ld:00291', who: 'Alvia 00291', operator: 'Renfe', mode: 'ld', service: 'Alvia', number: '00291',
  publisher: 'Renfe', feed: 'GTFS-RT de Alta Velocidad, Larga y Media Distancia', feedUrl: 'https://gtfsrt.renfe.com/trip_updates_LD.json',
  credit: 'Origen de los datos: Renfe Operadora', seen: 1000, cancelled: true, running: false,
};
const NOW = 5_000;

test('tren cancelado: de dónde a dónde y a qué hora, quién lo publica, desde cuándo y dónde se ve en el mapa', () => {
  const e = cancellationEvent({ ...base, stops: STOPS }, NOW);
  assert.equal(e.category, 'cancelacion');
  assert.equal(e.type, 'cancelado');
  assert.equal(e.severity, 'alta');
  assert.equal(e.title, 'Alvia 00291 cancelado: Badajoz 06:29 → Madrid-Chamartín-Clara Campoamor');
  assert.equal(e.description, 'Renfe lo da como cancelado en su tiempo real (GTFS-RT de Alta Velocidad, Larga y Media Distancia). '
    + 'Según el horario, salía de Badajoz a las 06:29 y llegaba a Madrid-Chamartín-Clara Campoamor a las 11:07.');
  assert.deepEqual([e.lon, e.lat], [-6.98, 38.89], 'en su origen');
  assert.equal(e.seen, 1000);
  assert.equal(e.expires, NOW + CANCELLATION_UNCONFIRMED_MS);
  assert.equal(e.credit, 'Origen de los datos: Renfe Operadora');
  assert.deepEqual(e.trip.stops.map((s) => s.time), ['06:29', '07:04', '07:40', '11:07']);
  assert.equal(e.trip.departure, '06:29');
  assert.equal(e.trip.arrival, '11:07');
  assert.deepEqual(e.trip.skipped, []);
  assert.equal(e.trip.feedUrl, 'https://gtfsrt.renfe.com/trip_updates_LD.json');
  assert.equal(e.trip.date, null);
});

test('no llega a su destino: sus últimas paradas suprimidas, termina en la anterior', () => {
  const stops = STOPS.map((s, i) => ({ ...s, skipped: i >= 2 }));
  const e = cancellationEvent({ ...base, cancelled: false, running: true, stops }, NOW);
  assert.equal(e.type, 'parcial');
  assert.equal(e.severity, 'media');
  assert.equal(e.title, 'Alvia 00291 no llega a Madrid-Chamartín-Clara Campoamor: termina en Mérida');
  assert.match(e.description, /^Renfe da como suprimidas en su tiempo real \(.+\) estas 2 paradas: Cáceres; Madrid-Chamartín-Clara Campoamor\./);
  assert.deepEqual([e.lon, e.lat], [-6.37, 39.46], 'en la primera parada suprimida');
  assert.equal(e.trip.endsAt, 'Mérida');
  assert.deepEqual(e.trip.stops.map((s) => !!s.skipped), [false, false, true, true]);
});

test('no sale de su origen, o no para en algunas intermedias', () => {
  const first = cancellationEvent({ ...base, cancelled: false, running: true, stops: STOPS.map((s, i) => ({ ...s, skipped: i === 0 })) }, NOW);
  assert.equal(first.title, 'Alvia 00291 no sale de Badajoz: empieza en Mérida');
  const middle = cancellationEvent({ ...base, cancelled: false, running: true, stops: STOPS.map((s, i) => ({ ...s, skipped: i === 1 })) }, NOW);
  assert.equal(middle.title, 'Alvia 00291 no para en Mérida');
  const two = cancellationEvent({ ...base, cancelled: false, running: true, stops: STOPS.map((s, i) => ({ ...s, skipped: i === 1 || i === 2 })) }, NOW);
  assert.equal(two.title, 'Alvia 00291 no para en 2 estaciones');
});

test('si la fuente se contradice, se dice: cancelado y también en servicio', () => {
  const both = cancellationEvent({ ...base, running: true, stops: STOPS }, NOW);
  assert.equal(both.type, 'cancelado');
  assert.match(both.description, /Renfe también publica su retraso o su posición: puede que circule en parte\.$/);
  // Cancelado en una entrada y con paradas suprimidas en otra: circula, sin esas paradas.
  const partial = cancellationEvent({ ...base, running: true, stops: STOPS.map((s, i) => ({ ...s, skipped: i === 3 })) }, NOW);
  assert.equal(partial.type, 'parcial');
  assert.match(partial.description, /Renfe además lo marca como cancelado en otra entrada de su tiempo real\.$/);
  // Todas suprimidas sin decir «cancelado»: no circula.
  const all = cancellationEvent({ ...base, cancelled: false, running: true, stops: STOPS.map((s) => ({ ...s, skipped: true })) }, NOW);
  assert.equal(all.type, 'cancelado');
  assert.match(all.description, /^Renfe da como suprimidas en su tiempo real \(.+\) todas sus paradas\./);
});

test('sin horario del viaje: lo que se sepa, sin inventar horas ni posición', () => {
  const e = cancellationEvent({ ...base, stops: null, origin: 'Badajoz', destination: 'Madrid', skippedNames: [] }, NOW);
  assert.equal(e.title, 'Alvia 00291 cancelado: Badajoz → Madrid');
  assert.equal(e.lat, null);
  assert.equal(e.trip.departure, null);
  assert.equal(e.trip.stops, null);
  const nothing = cancellationEvent({ ...base, stops: null }, NOW);
  assert.equal(nothing.title, 'Alvia 00291 cancelado');
});

test('paradas suprimidas de una línea de autobús en varias expediciones: gravedad baja, cuántas son y el día', () => {
  const stops = [{ name: 'Zona Universitària', at: [2.11, 41.38], skipped: true }, { name: 'Palau Reial', at: [2.12, 41.38] }, { name: 'Fabra i Puig', at: [2.18, 41.43] }];
  const e = cancellationEvent({
    ...base, id: 'amb-bus-suprimidas:129:x', who: 'Línea 129 de AMB', operator: 'AMB', publisher: 'AMB', mode: 'bus', number: null,
    feed: 'GTFS-RT de actualizaciones de viaje', cancelled: false, running: true, stops, trips: 7, date: '20261105',
  }, NOW);
  assert.equal(e.severity, 'baja');
  assert.equal(e.title, 'Línea 129 de AMB no sale de Zona Universitària: empieza en Palau Reial');
  assert.match(e.description, /^AMB da como suprimidas en su tiempo real \(.+\) esta parada en 7 expediciones: Zona Universitària\./);
  assert.equal(e.trip.trips, 7);
  assert.equal(e.trip.date, '2026-11-05');
});

// ---------- Avisos que explican una cancelación ----------

const NOTICES = [
  { id: '1', text: 'Línea C1. Tren con salida prevista a las 17:13h de la estación de Gandia con destino València Nord, hoy no circula.', lines: ['40|C1'] },
  { id: '2', text: "Línia C3. Tren amb eixida prevista a les 17:03h de l'estació de Buñol amb destinació València Sant Isidre, hui no circula.", lines: ['40|C3'] },
  { id: '3', text: 'Tren 15011 Barcelona-Estació de França 14.15 h - Reus 16.03 h iniciará su recorrido con 30 minutos de demora.', lines: ['51|R15'] },
  { id: '4', text: 'A causa de una incidencia en la infraestructura entre Arc de Triomf y El Clot, los trenes circulan con demoras.', lines: ['51|R1', '51|R15'] },
  { id: '5', text: 'Ascensor de la estación de Reus, con acceso a vía 1, fuera de servicio.', lines: ['51|R15'] },
  { id: '6', text: 'Línea C1. Tren con salida prevista a las 18:13h de la estación de Gandia con destino València Nord, hoy no circula.', lines: ['40|C1'] },
];

test('el aviso de un tren: por su hora de salida y su origen (también en valenciano) o por su número; y en su línea', () => {
  assert.equal(noticesAbout({ departure: '17:13', origin: 'Gandia', line: '40|C1' }, NOTICES).notice.id, '1');
  assert.equal(noticesAbout({ departure: '17:03', origin: 'Buñol', line: '40|C3' }, NOTICES).notice.id, '2');
  assert.equal(noticesAbout({ number: '15011', departure: '14:15', origin: 'Barcelona-Estació de França', line: '51|R15' }, NOTICES).notice.id, '3');
  // Otra hora, otro origen u otra línea: no es este tren.
  assert.equal(noticesAbout({ departure: '17:43', origin: 'Gandia', line: '40|C1' }, NOTICES).notice, null);
  assert.equal(noticesAbout({ departure: '17:13', origin: 'Xàtiva', line: '40|C1' }, NOTICES).notice, null);
  assert.equal(noticesAbout({ departure: '17:13', origin: 'Gandia', line: '40|C2' }, NOTICES).notice, null);
  // Los de su línea que no hablan de otro tren ni de una estación.
  const { lineNotices } = noticesAbout({ number: '15011', departure: '14:15', origin: 'Barcelona-Estació de França', line: '51|R15' }, NOTICES);
  assert.deepEqual(lineNotices.map((n) => n.id), ['4']);
  assert.deepEqual(noticesAbout({ departure: '09:00', origin: 'Gandia', line: '40|C1' }, NOTICES).lineNotices, [], 'los dos de la C1 hablan de otros trenes');
});

test('la cancelación cita el aviso de su tren y su motivo, y los de su línea en la ficha', () => {
  const e = cancellationEvent({ ...base, stops: STOPS, notice: { id: '9', text: 'Por una avería, hoy no circula.', url: 'https://renfe.com/x' },
    lineNotices: [{ id: '8', text: 'Obras entre Mérida y Cáceres.' }] }, NOW);
  assert.match(e.description, /Aviso de Renfe sobre este viaje: Por una avería, hoy no circula\.$/);
  assert.deepEqual(e.trip.notice, { text: 'Por una avería, hoy no circula.', url: 'https://renfe.com/x' });
  assert.deepEqual(e.trip.lineNotices, [{ text: 'Obras entre Mérida y Cáceres.' }]);
  const bus = cancellationEvent({ ...base, mode: 'bus', stops: null, skippedNames: ['Plaza Uruguay'], cancelled: false, running: true,
    reason: 'Desvío línea 7: Línea 7 desviada entre las paradas A y B.' }, NOW);
  assert.match(bus.description, /^Desvío línea 7: Línea 7 desviada entre las paradas A y B\. Renfe da como suprimidas/);
  assert.equal(bus.trip.reason, 'Desvío línea 7: Línea 7 desviada entre las paradas A y B.');
});

// ---------- Las que la fuente deja de publicar ----------

const MIDNIGHT = 90_000_000;
const shownOnce = cancellationEvent({ ...base, stops: STOPS }, NOW); // 06:29 → 11:07

test('retirada después de su hora de llegada (lo normal) o antes (puede que circule); la de un viaje que pasa de medianoche', () => {
  const after = withdrawnCancellation(shownOnce, { now: 9_000, clock: '11:30', endOfDay: MIDNIGHT });
  assert.equal(after.withdrawn, 9_000);
  assert.equal(after.expires, MIDNIGHT);
  assert.equal(after.severity, 'baja');
  assert.equal(after.seen, shownOnce.seen);
  assert.equal(after.trip.withdrawnAfterArrival, true);
  assert.match(after.description, /Renfe dejó de publicarlo a las 11:30, después de su hora de llegada: lo hace con los viajes que ya han pasado\.$/);
  const before = withdrawnCancellation(shownOnce, { now: 9_000, clock: '08:00', endOfDay: MIDNIGHT });
  assert.equal(before.trip.withdrawnAfterArrival, false);
  assert.match(before.description, /antes de su hora de llegada: puede que al final circule/);
  const night = { ...shownOnce, trip: { ...shownOnce.trip, departure: '22:40', arrival: '01:10' } };
  assert.equal(withdrawnCancellation(night, { now: 1, clock: '23:50', endOfDay: MIDNIGHT }).trip.withdrawnAfterArrival, false);
  assert.equal(withdrawnCancellation(night, { now: 1, clock: '01:30', endOfDay: MIDNIGHT }).trip.withdrawnAfterArrival, true);
  const unknown = withdrawnCancellation({ ...shownOnce, trip: { ...shownOnce.trip, arrival: null } }, { now: 1, clock: '09:00', endOfDay: MIDNIGHT });
  assert.equal(unknown.trip.withdrawnAfterArrival, null);
  assert.match(unknown.description, /Renfe dejó de publicarlo a las 09:00\.$/);
});

test('se siguen de lectura en lectura: la que desaparece se retira hasta medianoche y, si vuelve, deja de estar retirada', () => {
  const when = (now, clock) => ({ now, clock, endOfDay: MIDNIGHT });
  let memory = followWithdrawn({ shown: new Map(), withdrawn: new Map() }, [shownOnce], when(10_000, '09:00'));
  assert.equal(memory.withdrawn.size, 0);
  memory = followWithdrawn(memory, [], when(20_000, '09:05'));
  assert.equal(memory.withdrawn.get(shownOnce.id).withdrawn, 20_000);
  memory = followWithdrawn(memory, [], when(30_000, '09:10'));
  assert.equal(memory.withdrawn.get(shownOnce.id).withdrawn, 20_000, 'la hora de cuando se retiró, no la de cada lectura');
  memory = followWithdrawn(memory, [shownOnce], when(40_000, '09:15'));
  assert.equal(memory.withdrawn.size, 0, 'vuelve a publicarse');
  memory = followWithdrawn(memory, [], when(50_000, '09:20'));
  memory = followWithdrawn(memory, [], when(MIDNIGHT + 1, '00:00'));
  assert.equal(memory.withdrawn.size, 0, 'pasada la medianoche, fuera');
});

test('la que desaparece pasada la medianoche era de ayer: no se retira hasta la medianoche siguiente', () => {
  const NEXT_MIDNIGHT = MIDNIGHT + 86_400_000;
  // 23:58: se ve; 00:01: la fuente ha vaciado su tiempo real al cambiar de día.
  let memory = followWithdrawn({ shown: new Map(), withdrawn: new Map() }, [shownOnce], { now: MIDNIGHT - 120_000, clock: '23:58', endOfDay: MIDNIGHT });
  assert.equal(memory.shownUntil, MIDNIGHT);
  memory = followWithdrawn(memory, [], { now: MIDNIGHT + 60_000, clock: '00:01', endOfDay: NEXT_MIDNIGHT });
  assert.equal(memory.withdrawn.size, 0, 'no se da como retirada hoy');
  assert.equal(memory.shownUntil, NEXT_MIDNIGHT);
  // La fuente no responde de 23:00 a 01:00: la última vez que se vio fue ayer.
  memory = followWithdrawn({ shown: new Map(), withdrawn: new Map() }, [shownOnce], { now: MIDNIGHT - 3_600_000, clock: '23:00', endOfDay: MIDNIGHT });
  memory = followWithdrawn(memory, [], { now: MIDNIGHT + 3_600_000, clock: '01:00', endOfDay: NEXT_MIDNIGHT });
  assert.equal(memory.withdrawn.size, 0);
  // Sin el día guardado (lo guardado antes de este cambio), como antes: hasta la medianoche de hoy.
  memory = followWithdrawn({ shown: new Map([[shownOnce.id, shownOnce]]), withdrawn: new Map() }, [], { now: 20_000, clock: '09:05', endOfDay: MIDNIGHT });
  assert.equal(memory.withdrawn.get(shownOnce.id).expires, MIDNIGHT);
});

// ---------- Trenes sin datos ----------

test('tren sin datos: qué falta, por dónde iría según su horario y dónde se ve en el mapa', () => {
  const e = missingTrainEvent({
    id: 'renfe-sin-datos:37090', who: 'Media Distancia 37090', operator: 'Renfe', mode: 'md', service: 'Media Distancia', number: '37090',
    stops: STOPS, at: 1, date: '2026-11-05', publisher: 'Renfe', feed: 'GTFS-RT de AV/LD/MD', feedUrl: 'https://gtfsrt.renfe.com/vehicle_positions_LD.json',
    credit: 'Origen de los datos: Renfe Operadora', seen: 1000,
  }, NOW);
  assert.equal(e.category, 'sin-datos');
  assert.equal(e.severity, 'baja');
  assert.equal(e.title, 'Media Distancia 37090 sin datos de Renfe: Badajoz 06:29 → Madrid-Chamartín-Clara Campoamor');
  assert.equal(e.description, 'Según su horario debería estar circulando: salía de Badajoz a las 06:29 y llega a Madrid-Chamartín-Clara Campoamor a las 11:07; '
    + 'ahora iría entre Mérida y Cáceres. Renfe no publica en su tiempo real ni su posición, ni su retraso, ni lo da como cancelado: el radar no puede saber si circula.');
  assert.deepEqual([e.lon, e.lat], [-6.34, 38.92], 'en la última estación por la que debería haber pasado');
  assert.equal(e.area, 'Mérida');
  assert.deepEqual(e.trip.between, ['Mérida', 'Cáceres']);
  assert.deepEqual(e.trip.stops.map((st) => !!st.passed), [true, true, false, false]);
  assert.equal(e.expires, NOW + MISSING_TRAIN_TTL_MS);
  assert.equal(e.trip.date, '2026-11-05');
});
