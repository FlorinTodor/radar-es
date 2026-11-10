// El día en cifras: el registro de un día (vehículos por tipo y por horas, retrasos, cancelaciones, trenes
// sin datos y avisos) y su resumen, para cualquier tipo de vehículo y sin saber de fuentes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY_LIMITS, addDays, emptyDay, foldEvents, foldVehicles, isDay, madridDay, madridHour, medianDelay, noteSources, sanitizeDay, summarizeDay,
} from '../../server/domain/dia.js';

const DATE = '2026-11-10';
const at = (hhmm) => Date.parse(`${DATE}T${hhmm}:00+01:00`); // hora de Madrid (CET)

test('días y horas de Madrid: medianoche, cambio de hora y fechas que no existen', () => {
  assert.equal(madridDay(Date.parse('2026-11-09T23:30:00Z')), '2026-11-10', 'las 00:30 en Madrid ya son el día 10');
  assert.equal(madridHour(Date.parse('2026-11-09T23:30:00Z')), 0);
  assert.equal(madridHour(Date.parse('2026-07-01T12:00:00Z')), 14, 'en verano, UTC+2');
  assert.equal(madridHour(Date.parse('2026-03-29T01:30:00Z')), 3, 'el día del cambio de hora salta de las 2 a las 3');
  assert.equal(isDay('2026-11-10'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '10-11-2026', '2026-11-10T00', '', null, '../x']) assert.equal(isDay(bad), false, String(bad));
  assert.equal(addDays('2026-11-03', 7), '2026-11-10');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('vehículos: por tipo y por horas, sin los estimados; retrasos donde se publican; el minuto con más', () => {
  const day = emptyDay(DATE);
  const vehicles = [
    { mode: 'cercanias', delay: 0, source: 'renfe-cercanias', operator: 'Renfe' },
    { mode: 'cercanias', delay: 7, source: 'renfe-cercanias', operator: 'Renfe' },
    { mode: 'bus', delay: null, source: 'emt-malaga', operator: 'EMT Málaga' },
    { mode: 'barco', delay: 20, source: 'naviera', operator: 'Naviera' }, // un tipo que aún no existe: cuenta igual
    { mode: 'av', estimated: true, source: 'ouigo-horario' }, // posición por horario: no se ha visto
    { mode: '__proto__', source: 'raro' },
  ];
  foldVehicles(day, vehicles, at('08:10'));
  foldVehicles(day, vehicles.slice(0, 2), at('08:11'));
  const hour = day.hours['8'];
  assert.equal(hour.n, 2);
  assert.deepEqual(hour.m.cercanias, [4, 2, 4, 2], 'suma, máximo, con retraso publicado, con 5 min o más');
  assert.deepEqual(hour.m.bus, [1, 1, 0, 0]);
  assert.deepEqual(hour.m.barco, [1, 1, 1, 1]);
  assert.deepEqual(hour.m.otros, [1, 1, 0, 0], 'un tipo con un nombre raro cuenta como «otros»');
  assert.equal(hour.m.av, undefined);
  assert.equal(Object.getPrototypeOf(hour.m), Object.prototype);
  assert.equal(day.delays.cercanias[0], 2);
  assert.equal(day.delays.cercanias[7], 2);
  assert.equal(day.delays.barco[16], 0, '20 min va en el tramo de 15 a 29');
  assert.equal(day.delays.barco[15], 1);
  assert.deepEqual(day.peak, { t: at('08:10'), total: 5, byMode: { cercanias: 2, bus: 1, barco: 1, otros: 1 } });
  assert.deepEqual(day.sources['renfe-cercanias'], ['Renfe']);
  assert.equal(day.sources['ouigo-horario'], undefined);
  assert.equal([day.from, day.to].join(), [at('08:10'), at('08:11')].join());
});

const cancellation = (id, over = {}) => ({
  id, category: 'cancelacion', type: 'cancelado', severity: 'alta', source: 'renfe-avisos', credit: 'Origen de los datos: Renfe Operadora',
  seen: at('07:00'), expires: at('23:59'),
  trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C5', origin: 'Móstoles-El Soto', follow: ['s-renfe-23719', 'l-renfe-10-C5'] },
  ...over,
});

test('incidencias: cada cancelación una vez al día (también si se retira), sin datos y avisos de emergencia en vigor', () => {
  const day = emptyDay(DATE);
  const events = [
    cancellation('c1'),
    cancellation('c2', { type: 'parcial', trip: { operator: 'AUVASA', mode: 'bus', service: 'Autobús', line: '16', follow: ['l-auvasa-16'] }, source: 'auvasa-avisos', credit: 'Fuente: AUVASA' }),
    { id: 's1', category: 'sin-datos', severity: 'baja', seen: at('09:00'), trip: { operator: 'Renfe', mode: 'md', service: 'Media Distancia', number: '18093', follow: ['s-renfe-18093', 'l-renfe-Media_20Distancia'] } },
    { id: 'm1', category: 'meteo', level: 'naranja', severity: 'alta', title: 'Aviso naranja por lluvias', area: 'Sur de Ávila', start: at('06:00'), end: at('20:00') },
    { id: 'm2', category: 'meteo', level: 'amarillo', title: 'Aviso amarillo', start: at('06:00') },
    { id: 'm3', category: 'meteo', level: 'rojo', title: 'Aviso rojo de mañana', start: at('23:00') + 86_400_000 },
    { id: 'q1', category: 'sismo', magnitude: 3.4, title: 'Terremoto M3.4', area: 'Granada', start: at('04:00') },
    { id: 'q0', category: 'sismo', magnitude: 4.1, title: 'Terremoto de ayer', start: at('04:00') - 86_400_000 },
    { id: 'o1', category: 'emergencia', severity: 'alta', power: true, title: 'Corte de luz', area: 'Tenerife', start: at('05:00') },
    { id: 'g1', category: 'catastrofe', level: 'verde', title: 'Inundación' },
    { id: 'viejo', category: 'cancelacion', type: 'cancelado', expires: at('07:30'), trip: {} },
  ];
  foldEvents(day, events, at('10:00'));
  // Otra lectura: la c1 ya no se publica (retirada) y la c2 pasa a cancelada del todo.
  foldEvents(day, [cancellation('c1', { withdrawn: at('10:01'), type: 'cancelado' }), { ...events[1], type: 'cancelado' }], at('10:02'));
  assert.deepEqual(Object.keys(day.cancellations).sort(), ['c1', 'c2'], 'la que ya no está en vigor no cuenta');
  assert.equal(day.cancellations.c2.type, 'cancelado');
  assert.equal(day.cancellations.c1.lk, 'l-renfe-10-C5');
  assert.deepEqual(Object.keys(day.missing), ['s1']);
  assert.deepEqual(Object.keys(day.emergencies).sort(), ['m1', 'o1', 'q1'], 'ni el amarillo, ni el de mañana, ni el terremoto de ayer, ni GDACS verde');
  assert.equal(day.emergencies.o1.power, true);
  assert.deepEqual(day.credits, { 'renfe-avisos': 'Origen de los datos: Renfe Operadora', 'auvasa-avisos': 'Fuente: AUVASA' });
});

test('un tren sin datos visto a las 10:00 cuenta en el día aunque caduque a los 10 min; uno ya caducado al leerse, no', () => {
  const day = emptyDay(DATE);
  const seenAt10 = { id: 's1', category: 'sin-datos', seen: at('10:00'), expires: at('10:10'), trip: { operator: 'Renfe', mode: 'md', number: '18093' } };
  const alreadyGone = { id: 's2', category: 'sin-datos', seen: at('09:00'), expires: at('09:10'), trip: { operator: 'Renfe', mode: 'md', number: '18095' } };
  foldEvents(day, [seenAt10], at('10:00'));
  foldEvents(day, [seenAt10, alreadyGone], at('10:20')); // el repositorio aún los guarda, ya caducados
  assert.deepEqual(Object.keys(day.missing), ['s1']);
  assert.equal(summarizeDay({ date: DATE, now: at('10:30'), today: true, record: day }).missing.total, 1);
});

test('topes: una lista que llega al suyo se queda ahí y lo dice', () => {
  const day = emptyDay(DATE);
  const many = Array.from({ length: DAY_LIMITS.missing + 5 }, (_, i) => ({ id: `s${i}`, category: 'sin-datos', trip: { operator: 'X', mode: 'md' } }));
  foldEvents(day, many, at('10:00'));
  assert.equal(Object.keys(day.missing).length, DAY_LIMITS.missing);
  assert.equal(day.truncated.missing, true);
});

test('el registro leído del disco se comprueba: otra versión u otro día, fuera; lo mal formado, fuera', () => {
  const day = emptyDay(DATE);
  foldVehicles(day, [{ mode: 'metro', delay: 1, source: 'metro-bilbao', operator: 'Metro Bilbao' }], at('08:00'));
  foldEvents(day, [cancellation('c1')], at('08:00'));
  const copy = JSON.parse(JSON.stringify(day));
  assert.deepEqual(sanitizeDay(copy, DATE), day);
  assert.equal(sanitizeDay(copy, '2026-11-11'), null, 'el de otro día');
  assert.equal(sanitizeDay({ ...copy, v: 99 }, DATE), null);
  assert.equal(sanitizeDay('basura', DATE), null);
  const bad = JSON.parse(JSON.stringify(day));
  bad.hours['8'].m.metro = [1, 'x', 3, 4];
  bad.hours['30'] = { n: 1, m: {} };
  bad.delays['__proto__'] = new Array(18).fill(0);
  bad.cancellations = JSON.parse('{"__proto__": {"x": 1}, "ok": {"op": "Renfe"}}');
  const clean = sanitizeDay(bad, DATE);
  assert.equal(clean.hours['8'].m.metro, undefined);
  assert.equal(clean.hours['30'], undefined);
  assert.deepEqual(Object.keys(clean.cancellations), ['ok']);
  assert.equal({}.x, undefined);
});

test('mediana del retraso: minuto a minuto hasta 14 y por tramos desde 15', () => {
  const bins = new Array(18).fill(0);
  assert.equal(medianDelay(bins), null);
  bins[0] = 3;
  bins[4] = 2;
  assert.deepEqual(medianDelay(bins), { minutes: 0 });
  bins[16] = 10;
  assert.deepEqual(medianDelay(bins), { from: 30, to: 59 });
});

// ---------- El resumen ----------

const kpiRow = (hhmm, byMode, extra = {}) => ({ t: at(hhmm), vehicles: Object.values(byMode).reduce((s, n) => s + n, 0), byMode, delayed: 2, withDelayInfo: 10, ...extra });

test('resumen: por horas del registro (todos los tipos) o, antes de él, de los KPI (sólo los ferroviarios); y la semana anterior', () => {
  const record = emptyDay(DATE);
  for (const m of ['10:00', '10:01']) {
    foldVehicles(record, [{ mode: 'cercanias', delay: 6 }, { mode: 'cercanias', delay: 0 }, { mode: 'bus', delay: 1 }], at(m));
  }
  const kpiRows = [kpiRow('07:00', { cercanias: 50 }), kpiRow('07:30', { cercanias: 30, metro: 4 }), kpiRow('10:00', { cercanias: 999 })];
  const compare = { date: '2026-11-03', record: null, kpiRows: [{ ...kpiRow('07:00', { cercanias: 80 }), t: at('07:00') - 7 * 86_400_000 }] };
  const s = summarizeDay({ date: DATE, now: at('10:30'), today: true, record, kpiRows, compare, days: ['2026-11-09', DATE, '2026-11-03'] });
  const cerc = s.vehicles.modes.find((m) => m.id === 'cercanias');
  const bus = s.vehicles.modes.find((m) => m.id === 'bus');
  assert.deepEqual(s.vehicles.modes.map((m) => m.id), ['cercanias', 'metro', 'bus'], 'en el orden del registro de tipos');
  assert.equal(cerc.hourly[7], 40, 'a las 7, de los KPI: la media de 50 y 30');
  assert.equal(cerc.hourly[10], 2, 'a las 10, del registro (manda sobre los KPI)');
  assert.equal(cerc.hourly[11], null, 'lo que aún no ha pasado, sin valor');
  assert.equal(cerc.hourly[3], null, 'sin muestras, sin valor (no cero)');
  assert.equal(bus.hourly[7], null, 'a las 7 sólo hay KPI, que no cuentan los autobuses: no se sabe');
  assert.equal(bus.hourly[10], 1);
  assert.equal(s.vehicles.modes.find((m) => m.id === 'metro').hourly[10], 0, 'en una hora del registro, un tipo que no se vio es cero');
  assert.equal(cerc.compare[7], 80);
  assert.equal(cerc.max, 50, 'el máximo de las horas que se enseñan: la de las 10, del registro');
  assert.equal(s.vehicles.compareDate, '2026-11-03');
  assert.deepEqual(cerc.delay, { lateShare: 50, median: { minutes: 0 } });
  assert.equal(s.delay.hourly[7], 20, 'de los KPI: 4 de 20 con retraso');
  assert.equal(s.delay.hourly[10], round1(100 * 2 / 6));
  assert.equal(s.coverage.hoursAllModes, 1);
  assert.equal(s.coverage.hoursRailOnly, 1);
  assert.deepEqual(s.days, ['2026-11-10', '2026-11-09', '2026-11-03']);
  assert.equal(s.prev, '2026-11-09');
  assert.equal(s.next, null);
});
const round1 = (x) => Math.round(x * 10) / 10;

test('resumen: cancelaciones por operador, tipo y línea (con su nombre y por dónde), alertas y avisos', () => {
  const record = emptyDay(DATE);
  foldEvents(record, [
    cancellation('c1'), cancellation('c2', { trip: { ...cancellation('x').trip, origin: 'Humanes' } }), cancellation('c3'),
    cancellation('c4', { type: 'parcial', trip: { operator: 'Renfe', mode: 'av', service: 'Avant', line: null, follow: ['s-renfe-8058', 'l-renfe-Avant'] } }),
    cancellation('c5', { trip: { operator: 'EMT Málaga', mode: 'bus', service: 'EMT Málaga', line: '27', follow: ['l-emtmalaga-27'] } }),
    { id: 'q1', category: 'sismo', magnitude: 2.1, title: 'Terremoto M2.1', start: at('03:00') },
    { id: 'q2', category: 'sismo', magnitude: 3.6, title: 'Terremoto M3.6', area: 'Murcia', start: at('05:00') },
    { id: 'm1', category: 'meteo', level: 'naranja', title: 'Naranja', start: at('01:00') },
    { id: 'm2', category: 'meteo', level: 'rojo', title: 'Rojo', start: at('02:00') },
  ], at('10:00'));
  const alertRows = [
    { id: 'a1', event: 'nueva', severity: 'media', title: 'Salto de retraso', since: at('08:00') },
    { id: 'a1', event: 'escalada', severity: 'alta', title: 'Salto de retraso', since: at('08:00') },
    { id: 'a1', event: 'resuelta', severity: 'alta', title: 'Salto de retraso' },
    { id: 'a2', event: 'nueva', severity: 'baja', title: 'Fuente caída', since: at('09:00') },
    'basura',
  ];
  const s = summarizeDay({ date: DATE, now: at('10:30'), today: true, record, alertRows });
  assert.equal(s.cancellations.total, 5);
  assert.equal(s.cancellations.whole, 4);
  assert.equal(s.cancellations.partial, 1);
  assert.deepEqual(s.cancellations.byOperator, [{ name: 'Renfe', n: 4 }, { name: 'EMT Málaga', n: 1 }]);
  assert.deepEqual(s.cancellations.byMode.map((m) => [m.id, m.n]), [['av', 1], ['cercanias', 3], ['bus', 1]]);
  const [c5, ...rest] = s.cancellations.byLine;
  assert.deepEqual([c5.key, c5.name, c5.n, c5.origins], ['l-renfe-10-C5', 'Tren C5 · Cercanías · Renfe', 3, ['Móstoles-El Soto', 'Humanes']],
    'el nombre de describeFollow, con el tipo del registro (sin «Línea» delante)');
  assert.deepEqual(rest.map((g) => g.name).sort(), ['Autobús 27 · EMT Málaga', 'Tren Avant · Avant · Renfe'],
    'en AV/LD/MD lo que agrupa es el producto');
  assert.equal(s.alerts.total, 2);
  assert.deepEqual(s.alerts.bySeverity, { alta: 1, baja: 1 });
  assert.deepEqual(s.alerts.top.map((a) => a.severity), ['alta', 'baja'], 'la que se agravó cuenta con su gravedad mayor');
  assert.equal(s.emergencies.sismos.total, 2);
  assert.equal(s.emergencies.sismos.felt, 1);
  assert.equal(s.emergencies.sismos.top[0].magnitude, 3.6);
  assert.deepEqual([s.emergencies.meteo.rojo, s.emergencies.meteo.naranja], [1, 1]);
  assert.equal(s.emergencies.meteo.top[0].level, 'rojo');
  assert.equal(s.vehicles.peak, null);
});

test('resumen: las fuentes por su nombre y con su atribución (la de cada operador si la fuente agrupa a varios), sin repetir', () => {
  const record = emptyDay(DATE);
  foldVehicles(record, [
    { mode: 'cercanias', source: 'renfe-cercanias', operator: 'Renfe' }, { mode: 'av', source: 'renfe-ld', operator: 'Renfe' },
    { mode: 'bus', source: 'bus-moventis', operator: 'Moventis Casas' }, { mode: 'bus', source: 'desconocida', operator: 'X' },
  ], at('10:00'));
  foldEvents(record, [cancellation('c1'), cancellation('c2', { source: 'auvasa-avisos', credit: 'Fuente: AUVASA' })], at('10:00'));
  const health = [
    { id: 'renfe-cercanias', name: 'Renfe Cercanías', license: 'Origen de los datos: Renfe Operadora' },
    { id: 'renfe-ld', name: 'Renfe AV/LD/MD', license: 'Origen de los datos: Renfe Operadora' },
    { id: 'renfe-avisos', name: 'Renfe avisos', license: 'Origen de los datos: Renfe Operadora' },
    { id: 'bus-moventis', name: 'Autobuses del NAP', license: 'NAP', operatorLicenses: { 'Moventis Casas': 'Fuente: Moventis (CC BY 4.0)', Otro: 'x' } },
  ];
  noteSources(record, health);
  assert.deepEqual(record.attrib['bus-moventis'], { name: 'Autobuses del NAP', license: 'NAP', operators: { 'Moventis Casas': 'Fuente: Moventis (CC BY 4.0)' } });
  // Otro día ya no está en la lista de fuentes: se cita como estaba ese día (lo guardado en el registro).
  const { credits } = summarizeDay({ date: DATE, now: at('10:30'), today: true, record: sanitizeDay(JSON.parse(JSON.stringify(record)), DATE), health: [] });
  assert.deepEqual(credits, [
    { names: ['Autobuses del NAP'], credit: 'Fuente: Moventis (CC BY 4.0)' },
    { names: ['auvasa-avisos'], credit: 'Fuente: AUVASA' },
    { names: ['Renfe AV/LD/MD', 'Renfe avisos', 'Renfe Cercanías'], credit: 'Origen de los datos: Renfe Operadora' },
  ], 'por su nombre; el id, sólo de la que no se sabe (auvasa-avisos no estaba en la lista)');
  // Con la lista de ahora, también su nombre.
  const now = summarizeDay({ date: DATE, now: at('10:30'), today: true, record, health: [...health, { id: 'auvasa-avisos', name: 'AUVASA avisos' }] });
  assert.ok(now.credits.some((c) => c.names.includes('AUVASA avisos')));
});

test('las que no traen clave de línea (de versiones anteriores) van con la suya si no hay duda; si la hay, aparte', () => {
  const record = emptyDay(DATE);
  const c1 = (id, scope, over = {}) => cancellation(id, { trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C1', follow: scope ? ['l-renfe-' + scope + '-C1'] : undefined }, ...over });
  foldEvents(record, [
    cancellation('a1'), cancellation('a2', { trip: { operator: 'Renfe', mode: 'cercanias', service: 'Cercanías', line: 'C5' } }),
    c1('b1', '10'), c1('b2', '40'), c1('b3', null),
  ], at('10:00'));
  const lines = summarizeDay({ date: DATE, now: at('10:30'), today: true, record }).cancellations.byLine;
  assert.equal(lines.find((g) => g.key === 'l-renfe-10-C5').n, 2, 'la C5 sin clave, con la única C5');
  assert.equal(lines.filter((g) => g.name.startsWith('Tren C1')).length, 3, 'C1 hay en Madrid y en València: la que no tiene clave, aparte');
});

test('lo que no se sabe sale null, no 0: alertas sin leer, y cancelaciones, sin datos y avisos de un día sin registro', () => {
  const record = emptyDay(DATE);
  foldVehicles(record, [{ mode: 'metro' }], at('10:00'));
  const s = summarizeDay({ date: DATE, now: at('10:30'), today: true, record, alertRows: null });
  assert.equal(s.alerts, null);
  assert.equal(s.cancellations.total, 0, 'con registro, cero es cero');
  const old = summarizeDay({ date: '2026-11-01', now: at('10:30'), today: false, record: null, kpiRows: [{ t: Date.parse('2026-11-01T09:00:00+01:00'), byMode: { metro: 3 }, vehicles: 3 }], alertRows: [] });
  assert.deepEqual([old.cancellations, old.missing, old.emergencies], [null, null, null]);
  assert.equal(old.alerts.total, 0);
  assert.equal(old.delay.lateShare, null, 'sin retrasos publicados, no 0 %');
});

test('resumen: de un día sin nada, null; uno pasado, entero (sin cortar en la hora actual)', () => {
  assert.equal(summarizeDay({ date: DATE, now: at('10:30'), today: true, record: emptyDay(DATE) }), null);
  const s = summarizeDay({ date: '2026-11-09', now: at('10:30'), today: false, record: null, kpiRows: [{ ...kpiRow('22:00', { cercanias: 10 }), t: at('22:00') - 86_400_000 }] });
  assert.equal(s.vehicles.modes[0].hourly[22], 10);
  assert.equal(s.cancellations, null, 'de antes del registro no se sabe');
  assert.equal(s.coverage.incidents, false);
});
