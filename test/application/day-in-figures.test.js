// Caso de uso del día en cifras: suma cada minuto lo que se ve, lo guarda, cierra el día a medianoche y da
// el resumen de hoy (al momento) o de un día pasado (tras leerlo del disco). Reloj y almacenes falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDayInFigures } from '../../server/application/use-cases/day-in-figures.js';
import { emptyDay, foldVehicles } from '../../server/domain/dia.js';

const at = (s) => Date.parse(`${s}+01:00`); // hora de Madrid (CET)
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(start) {
  let now = at(start);
  const saved = new Map();
  const saves = [];
  const store = {
    load: async (day) => structuredClone(saved.get(day) ?? null),
    save: async (record) => { saves.push(record.date); saved.set(record.date, structuredClone(record)); },
    days: async () => [...saved.keys()].sort(),
  };
  const rows = new Map(); // «stream día» → filas
  const history = { read: async (stream, day) => rows.get(`${stream} ${day}`) ?? [], days: async (stream) => [...rows.keys()].filter((k) => k.startsWith(`${stream} `)).map((k) => k.split(' ')[1]).sort() };
  let vehicles = [{ mode: 'cercanias', delay: 0, source: 'renfe-cercanias', operator: 'Renfe' }];
  let events = [];
  const situation = { vehicles: () => vehicles, events: () => events, health: () => [] };
  const uc = makeDayInFigures({ situation, history, store, clock: { now: () => now }, log: { warn() {}, info() {}, error() {} } });
  return {
    uc, saved, saves, rows,
    tickAt: (s) => { now = at(s); return uc.tick(); },
    set: (v, e) => { vehicles = v; events = e ?? events; },
    setNow: (s) => { now = at(s); },
  };
}

test('cada minuto suma lo que se ve; se guarda cada 5 y al cambiar de día; el resumen de hoy, al momento', async () => {
  const s = setup('2026-11-10T23:55:00');
  await s.uc.restore();
  for (const m of ['55', '56', '57', '58', '59']) await s.tickAt(`2026-11-10T23:${m}:00`);
  assert.deepEqual(s.saves, ['2026-11-10'], 'al quinto minuto');
  const today = s.uc.summary();
  assert.equal(today.date, '2026-11-10');
  assert.equal(today.vehicles.modes[0].hourly[23], 1);
  // Medianoche: se guarda el día que se cierra y empieza otro.
  s.set([{ mode: 'bus' }, { mode: 'bus' }]);
  await s.tickAt('2026-11-11T00:00:30');
  assert.deepEqual(s.saves, ['2026-11-10', '2026-11-10']);
  assert.equal(s.saved.get('2026-11-10').hours['23'].n, 5, 'el día cerrado, entero');
  const next = s.uc.summary();
  assert.equal(next.date, '2026-11-11');
  assert.deepEqual(next.vehicles.modes.map((m) => [m.id, m.hourly[0]]), [['bus', 2]]);
});

test('al arrancar sigue con el registro de hoy (un reinicio no empieza de cero)', async () => {
  const s = setup('2026-11-10T09:00:00');
  const before = emptyDay('2026-11-10');
  foldVehicles(before, [{ mode: 'metro' }, { mode: 'metro' }, { mode: 'metro' }], at('2026-11-10T08:30:00'));
  s.saved.set('2026-11-10', before);
  await s.uc.restore();
  await s.tickAt('2026-11-10T09:00:00');
  const sum = s.uc.summary();
  assert.equal(sum.vehicles.modes.find((m) => m.id === 'metro').hourly[8], 3);
  assert.equal(sum.vehicles.modes.find((m) => m.id === 'cercanias').hourly[9], 1);
});

test('un día pasado: «cargando» mientras se lee y luego su resumen; los KPI y alertas del histórico y la semana anterior', async () => {
  const s = setup('2026-11-10T12:00:00');
  s.rows.set('kpis 2026-11-09', [{ t: at('2026-11-09T08:00:00'), vehicles: 7, byMode: { cercanias: 7 }, delayed: 1, withDelayInfo: 7 }]);
  s.rows.set('kpis 2026-11-02', [{ t: at('2026-11-02T08:00:00'), vehicles: 9, byMode: { cercanias: 9 } }]);
  s.rows.set('alerts 2026-11-09', [{ id: 'a', event: 'nueva', severity: 'alta', title: 'Tren detenido' }]);
  await s.uc.restore();
  assert.deepEqual(s.uc.summary('2026-11-09'), { date: '2026-11-09', loading: true });
  await flush();
  const past = s.uc.summary('2026-11-09');
  assert.equal(past.today, false);
  assert.equal(past.vehicles.modes[0].hourly[8], 7);
  assert.equal(past.vehicles.modes[0].compare[8], 9, 'el lunes anterior');
  assert.equal(past.vehicles.compareDate, '2026-11-02');
  assert.equal(past.alerts.total, 1);
  assert.equal(past.cancellations, null, 'de ese día no hay registro');
  assert.ok(past.days.includes('2026-11-09') && past.days.includes('2026-11-10'));
  // Un día del que no hay nada: null (404), también después de leerlo.
  assert.deepEqual(s.uc.summary('2026-11-01'), { date: '2026-11-01', loading: true });
  await flush();
  assert.equal(s.uc.summary('2026-11-01'), null);
});

test('fechas que no valen: futuras, de hace más de 90 días o mal escritas', async () => {
  const s = setup('2026-11-10T12:00:00');
  await s.uc.restore();
  for (const day of ['2026-11-11', '2026-08-01', '2026-02-30', 'hoy', '../x']) assert.equal(s.uc.summary(day), null, day);
});

test('pedir muchos días a la vez lee como mucho dos a la vez; los demás, al volver a pedirlos', async () => {
  const s = setup('2026-11-10T12:00:00');
  await s.uc.restore();
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
  assert.ok(days.map((d) => s.uc.summary(d)).every((a) => a?.loading), 'todos «cargando»');
  await flush();
  const state = (a) => (a === null ? 'sin datos' : a.loading ? 'cargando' : 'listo');
  assert.deepEqual(days.map((d) => state(s.uc.summary(d))), ['sin datos', 'sin datos', 'cargando', 'cargando', 'cargando'],
    'sólo se leyeron los dos primeros');
});
