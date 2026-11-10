// Puntualidad histórica: por servicio (su último retraso, el de su llegada) y por línea (sus lecturas), para
// cualquier vehículo con retraso y claves `follow`; las cancelaciones; los días de Madrid; los topes; y que
// lo guardado vuelve igual. Sin reloj real: cada lectura lleva su hora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deserialize, serialize } from 'node:v8';
import {
  LATE_MIN, RUN_END_MS, RUN_GAP_MS, createPunctualityBook, dayIso, isoDay, madridDay,
} from '../../server/domain/puntualidad.js';

const MIN = 60_000;
// 10-nov-2026 en Madrid (CET, UTC+1): las 08:00 son las 07:00 UTC.
const at = (iso) => Date.parse(iso);
const T0 = at('2026-11-10T07:00:00Z');
const DAY = 86_400_000;

const avant = (delay, over = {}) => ({
  id: 'renfe-ld:08058', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058',
  origin: 'Valladolid-Campo Grande', destination: 'Madrid-Chamartín-Clara Campoamor', delay, follow: ['s-renfe-8058', 'l-renfe-Avant'], ...over,
});
const bus = (id, delay, over = {}) => ({
  id, source: 'amb-bus', mode: 'bus', operator: 'AMB', line: 'V15', label: null, delay, estimated: true, follow: ['l-amb-V15'], ...over,
});

test('días de Madrid: la medianoche es la de Madrid, no la de UTC', () => {
  assert.equal(dayIso(madridDay(at('2026-11-10T22:30:00Z'))), '2026-11-10', '23:30 en Madrid');
  assert.equal(dayIso(madridDay(at('2026-11-10T23:30:00Z'))), '2026-11-11', '00:30 en Madrid');
  assert.equal(dayIso(madridDay(at('2026-07-10T22:30:00Z'))), '2026-07-11', 'en verano, UTC+2');
  assert.equal(isoDay('2026-11-10'), madridDay(T0));
  assert.equal(isoDay('10/11/2026'), null);
});

test('un servicio: su último retraso es el de su llegada, cuando lleva un rato sin verse; y cuenta en su línea', () => {
  const book = createPunctualityBook();
  book.observe([avant(3)], T0);
  book.observe([avant(12)], T0 + 30 * MIN);
  let r = book.report('s-renfe-8058', T0 + 31 * MIN);
  const today = r.days.at(-1);
  assert.equal(today.day, '2026-11-10');
  assert.equal(today.status, 'en-curso', 'aún no ha llegado');
  assert.deepEqual(r.now, { day: '2026-11-10', delay: 12, max: 12 });
  assert.deepEqual(r.summary, { ran: 0, late: 0, cancelled: 0 }, 'lo que está en curso no cuenta todavía');
  book.closeRuns(T0 + 30 * MIN + RUN_END_MS);
  r = book.report('s-renfe-8058', T0 + 50 * MIN);
  assert.equal(r.days.at(-1).status, 'tarde');
  assert.equal(r.days.at(-1).delay, 12);
  assert.equal(r.now, undefined);
  assert.deepEqual(r.summary, { ran: 1, late: 1, cancelled: 0 });
  assert.equal(r.name, undefined, 'el nombre lo pone quien pregunta (describeFollow), no el libro');
  assert.equal(r.service, 'Avant');
  assert.equal(r.number, '08058');
  assert.equal(r.origin, 'Valladolid-Campo Grande');
  assert.equal(r.lineKey, 'l-renfe-Avant');
  assert.equal(r.lateMinutes, LATE_MIN);
  assert.equal(r.days.length, 30);
  assert.equal(r.days[0].status, 'sin-dato');

  const line = book.report('l-renfe-Avant', T0 + 50 * MIN);
  const d = line.days.at(-1);
  assert.deepEqual([d.samples, d.late, d.vehicles, d.finished, d.finishedLate, d.max], [2, 1, 1, 1, 1, 12]);
  assert.equal(d.lateShare, 0.5);
});

test('vuelve a verse antes de RUN_GAP_MS (un hueco en los datos): el mismo recorrido, y su línea no lo cuenta dos veces', () => {
  const book = createPunctualityBook();
  book.observe([avant(2)], T0);
  book.closeRuns(T0 + RUN_END_MS);
  book.observe([avant(1)], T0 + RUN_END_MS + 5 * MIN);
  book.closeRuns(T0 + 2 * RUN_END_MS + 10 * MIN);
  const d = book.report('l-renfe-Avant', T0 + 2 * RUN_END_MS + 10 * MIN).days.at(-1);
  assert.equal(d.finished, 1);
  assert.equal(d.finishedLate, 0);
  assert.equal(book.report('s-renfe-8058', T0 + 3 * RUN_END_MS).days.at(-1).delay, 1);
});

test('un recorrido que pasa la medianoche cuenta en el día en que salió', () => {
  const book = createPunctualityBook();
  const night = at('2026-11-10T22:30:00Z'); // 23:30 en Madrid
  book.observe([avant(4)], night);
  book.observe([avant(9)], night + 50 * MIN); // 00:20 del día 11
  book.closeRuns(night + 50 * MIN + RUN_END_MS);
  const r = book.report('s-renfe-8058', night + 2 * 3600_000);
  assert.equal(r.days.at(-1).day, '2026-11-11');
  assert.equal(r.days.at(-1).status, 'sin-dato');
  assert.deepEqual([r.days.at(-2).day, r.days.at(-2).status, r.days.at(-2).delay], ['2026-11-10', 'tarde', 9]);
});

test('«7 de los últimos 10 días en que circuló», y las cancelaciones aparte', () => {
  const book = createPunctualityBook();
  // 12 días: los dos primeros a tiempo, luego tarde salvo los días 4, 7 y 10; el día 6, cancelado.
  for (let n = 0; n < 12; n++) {
    const t = T0 + n * DAY;
    if (n === 6) {
      book.cancellations([{ id: 'c6', category: 'cancelacion', type: 'cancelado', source: 'renfe-avisos', trip: { follow: ['s-renfe-8058', 'l-renfe-Avant'] } }], t);
      continue;
    }
    const late = n >= 2 && ![4, 7, 10].includes(n);
    book.observe([avant(late ? 15 : 0)], t);
    book.closeRuns(t + RUN_END_MS);
  }
  const r = book.report('s-renfe-8058', T0 + 11 * DAY + 3600_000);
  assert.deepEqual(r.summary, { ran: 11, late: 6, cancelled: 1 });
  // Los últimos 10 contados: del día 2 al 11 (el 6, cancelado).
  assert.deepEqual(r.recent, { days: 10, late: 6, cancelled: 1 });
  assert.equal(r.days.find((d) => d.day === dayIso(madridDay(T0 + 6 * DAY))).status, 'cancelado');
  assert.equal(r.firstSeen, '2026-11-10');
});

test('cancelaciones: el servicio en su día (también uno que nunca se vio circular) y una vez en cada línea', () => {
  const book = createPunctualityBook();
  const cancelled = {
    id: 'renfe-cancelado:ld:5962', category: 'cancelacion', type: 'cancelado', source: 'renfe-avisos',
    trip: { operator: 'Renfe', mode: 'av', service: 'AVE', number: '05962', origin: 'Madrid', destination: 'Murcia', date: null, follow: ['s-renfe-5962', 'l-renfe-AVE'] },
  };
  const partial = {
    id: 'auvasa-aviso:1', category: 'cancelacion', type: 'parcial', source: 'auvasa-avisos',
    trip: { operator: 'AUVASA', mode: 'bus', line: '16', date: '2026-11-10', follow: ['l-auvasa-16'] },
  };
  for (let k = 0; k < 3; k++) book.cancellations([cancelled, partial, { id: 'x', category: 'meteo' }], T0 + k * MIN);
  const ave = book.report('s-renfe-5962', T0 + 5 * MIN);
  assert.equal(ave.days.at(-1).status, 'cancelado');
  assert.deepEqual([ave.number, ave.origin, ave.source], ['05962', 'Madrid', 'renfe-avisos'], 'lo que dice su viaje');
  assert.equal(book.report('l-renfe-AVE', T0 + 5 * MIN).days.at(-1).cancelled, 1, 'una vez, aunque se lea tres');
  const line = book.report('l-auvasa-16', T0 + 5 * MIN);
  assert.equal(line.days.at(-1).cancelled, 1);
  assert.equal(line.days.at(-1).lateShare, null, 'sin lecturas de retraso');
  // Con paradas suprimidas y sin verse circular: «parcial».
  book.cancellations([{ ...partial, id: 'p2', trip: { ...partial.trip, follow: ['s-amb-V15-0k3x9ab-0732', 'l-amb-V15'] } }], T0 + 6 * MIN);
  assert.equal(book.report('s-amb-V15-0k3x9ab-0732', T0 + 6 * MIN).days.at(-1).status, 'parcial');
});

test('sin retraso publicado, nada; las líneas sin servicio (autobuses con sólo su línea) también tienen puntualidad', () => {
  const book = createPunctualityBook();
  book.observe([
    bus('amb-bus:1', 2), bus('amb-bus:2', 7), bus('amb-bus:2', 8),
    { id: 'alsa:1', mode: 'bus', operator: 'ALSA', delay: null, estimated: true, follow: ['l-alsa-710'] }, // sólo horario
    { id: 'emt:1', mode: 'bus', operator: 'EMT Málaga', delay: 3 }, // sin claves
  ], T0);
  const d = book.report('l-amb-V15', T0).days.at(-1);
  assert.deepEqual([d.samples, d.late, d.vehicles, d.finished], [3, 2, 2, 0]);
  assert.equal(book.report('l-alsa-710', T0), null, 'sin retraso no hay puntualidad');
  assert.equal(book.report('p-71801', T0), null, 'las paradas no tienen');
  assert.equal(book.report('s-renfe-1', T0), null, 'una clave que no se ha visto');
  assert.equal(book.stats().services, 0);
});

test('lo que lleva más de los días que se guardan se olvida, y su sitio vale para otra clave', () => {
  const book = createPunctualityBook({ keep: 5 });
  book.observe([avant(1)], T0);
  book.closeRuns(T0 + RUN_END_MS);
  book.observe([avant(20, { follow: ['s-renfe-1234'] })], T0 + 2 * DAY);
  assert.equal(book.report('s-renfe-8058', T0 + 4 * DAY).summary.ran, 1);
  // Cinco días después del último, ya no se guarda.
  book.observe([], T0 + 5 * DAY);
  assert.equal(book.report('s-renfe-8058', T0 + 5 * DAY), null);
  assert.equal(book.stats().services, 1);
  book.observe([avant(3, { follow: ['s-renfe-9999'] })], T0 + 5 * DAY);
  const reused = book.report('s-renfe-9999', T0 + 5 * DAY);
  assert.deepEqual(reused.days.filter((d) => d.status !== 'sin-dato').map((d) => d.day), ['2026-11-15'], 'el hueco reutilizado empieza vacío');
  assert.equal(reused.days.length, 30);
});

test('topes: con la tabla llena, las claves nuevas no entran y se dice', () => {
  const book = createPunctualityBook({ maxServices: 2, maxLines: 1 });
  book.observe([1, 2, 3].map((n) => avant(1, { id: `v${n}`, follow: [`s-renfe-${n}`, `l-renfe-L${n}`] })), T0);
  const s = book.stats();
  assert.equal(s.services, 2);
  assert.equal(s.lines, 1);
  assert.deepEqual(s.full, { services: true, lines: true });
  assert.equal(book.report('s-renfe-3', T0), null);
});

test('un día salteado en el anillo no deja datos viejos: se vacía al escribir el siguiente', () => {
  const book = createPunctualityBook({ keep: 3 });
  book.observe([avant(9)], T0);
  book.closeRuns(T0 + RUN_END_MS);
  book.observe([avant(1)], T0 + 2 * DAY);
  book.closeRuns(T0 + 2 * DAY + RUN_END_MS);
  // Día +3: cae en el hueco del día 0, que ya no se guarda.
  book.observe([avant(2)], T0 + 3 * DAY);
  const r = book.report('s-renfe-8058', T0 + 3 * DAY + 3 * MIN);
  const statuses = Object.fromEntries(r.days.slice(-4).map((d) => [d.day, d.status]));
  assert.deepEqual(statuses, { '2026-11-10': 'sin-dato', '2026-11-11': 'sin-dato', '2026-11-12': 'a-tiempo', '2026-11-13': 'en-curso' });
});

test('lo guardado vuelve igual (con el formato de Node), y lo de otra versión no se usa', () => {
  const book = createPunctualityBook();
  book.observe([avant(6), bus('amb-bus:1', 2)], T0);
  book.cancellations([{ id: 'c', category: 'cancelacion', type: 'cancelado', trip: { follow: ['s-renfe-77', 'l-renfe-Avant'] } }], T0);
  const saved = deserialize(serialize(book.snapshot()));
  const again = createPunctualityBook();
  assert.equal(again.restore(saved), true);
  for (const key of ['s-renfe-8058', 'l-renfe-Avant', 'l-amb-V15', 's-renfe-77']) {
    assert.deepEqual(again.report(key, T0 + MIN), book.report(key, T0 + MIN), key);
  }
  // El recorrido en curso sigue: acaba y cuenta en su línea.
  again.closeRuns(T0 + RUN_END_MS);
  assert.equal(again.report('l-renfe-Avant', T0 + RUN_END_MS).days.at(-1).finishedLate, 1);
  // El mismo vehículo, después de volver: no se cuenta otra vez en su línea.
  again.observe([bus('amb-bus:1', 3)], T0 + 2 * MIN);
  assert.equal(again.report('l-amb-V15', T0 + 2 * MIN).days.at(-1).vehicles, 1);
  assert.equal(createPunctualityBook().restore({ ...saved, version: 99 }), false);
  assert.equal(createPunctualityBook({ keep: 30 }).restore(saved), false, 'otro número de días');
  assert.equal(createPunctualityBook().restore({ ...saved, services: { ...saved.services, data: {} } }), false, 'mal formado');
  assert.equal(createPunctualityBook().restore(null), false);
});

test('al cambiar de día, «hoy» empieza de cero: el mismo vehículo cuenta otra vez en su línea', () => {
  const book = createPunctualityBook();
  book.observe([bus('amb-bus:1', 2)], T0);
  book.observe([bus('amb-bus:1', 2)], T0 + DAY);
  const days = book.report('l-amb-V15', T0 + DAY).days;
  assert.deepEqual([days.at(-2).vehicles, days.at(-1).vehicles], [1, 1]);
  assert.equal(book.report('l-amb-V15', T0 + DAY).summary.samples, 1, 'el resumen, sin hoy');
});

test('un recorrido que no vuelve en RUN_GAP_MS se olvida; si reaparece, es otro recorrido', () => {
  const book = createPunctualityBook();
  book.observe([avant(1)], T0);
  book.closeRuns(T0 + RUN_END_MS);
  book.closeRuns(T0 + RUN_GAP_MS + MIN);
  assert.equal(book.stats().runs, 0);
  book.observe([avant(30)], T0 + RUN_GAP_MS + 2 * MIN); // el mismo día: lo último que se sabe
  book.closeRuns(T0 + RUN_GAP_MS + 2 * MIN + RUN_END_MS);
  const r = book.report('s-renfe-8058', T0 + 5 * 3600_000);
  assert.equal(r.days.at(-1).status, 'tarde');
  assert.equal(book.report('l-renfe-Avant', T0 + 5 * 3600_000).days.at(-1).finished, 2);
});

test('de una línea, lo que dice su vehículo (la fuente del retraso) manda sobre lo que dice una cancelación', () => {
  const book = createPunctualityBook();
  const cancelled = { id: 'c', category: 'cancelacion', type: 'cancelado', source: 'renfe-avisos', trip: { operator: 'Renfe', service: 'Cercanías', line: 'C1', follow: ['l-renfe-Madrid-C1'] } };
  book.cancellations([cancelled], T0);
  assert.equal(book.report('l-renfe-Madrid-C1', T0).source, 'renfe-avisos');
  const c1 = { id: 'renfe-c:1', source: 'renfe-cercanias', mode: 'cercanias', operator: 'Renfe', service: 'Cercanías', line: 'C1', delay: 2, follow: ['l-renfe-Madrid-C1'] };
  book.observe([c1], T0 + MIN);
  assert.equal(book.report('l-renfe-Madrid-C1', T0 + MIN).source, 'renfe-cercanias');
  book.cancellations([{ ...cancelled, id: 'c2' }], T0 + 2 * MIN);
  assert.equal(book.report('l-renfe-Madrid-C1', T0 + 2 * MIN).source, 'renfe-cercanias', 'una cancelación después no lo cambia');
});
