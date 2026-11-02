// Caso de uso detect-alerts: evalúa las reglas sobre el estado, abre, escala y resuelve alertas, las
// apunta en el histórico y muestrea los KPIs. Con el repositorio en memoria de verdad, un reloj que
// se mueve a mano y un histórico falso que guarda lo que se le pide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDetectAlerts } from '../../server/application/use-cases/detect-alerts.js';
import { createInMemorySituation } from '../../server/adapters/outbound/persistence/in-memory-situation.js';

const MIN = 60_000;
const START = Date.parse('2026-11-02T10:00:00Z');

const train = (id, delay, extra = {}) => ({
  id: `renfe-ld:${id}`, mode: 'av', service: 'AVE', line: null, label: id, lat: 40.4, lon: -3.7,
  delay, origin: 'Madrid-Puerta de Atocha', destination: 'Sevilla-Santa Justa', ...extra,
});

function setup() {
  const situation = createInMemorySituation();
  situation.registerSource({ id: 'renfe-ld', name: 'Renfe AV/LD/MD', kind: 'vehicles', interval: 20_000, url: 'https://gtfsrt.renfe.com/x.json' }, { enabled: true });
  const clock = { t: START, now() { return this.t; } };
  const rows = [];
  const history = { append: async (stream, row) => { rows.push({ stream, ...row }); } };
  const stations = { nearest: () => null };
  const detect = makeDetectAlerts({ situation, stations, history, clock });
  /** Una lectura de la fuente con estos trenes, en el instante del reloj. */
  const read = (...vehicles) => situation.saveResult('renfe-ld', { vehicles }, clock.t, 5);
  return { situation, clock, rows, detect, read };
}

test('una alerta se abre, escala y se resuelve, y cada cambio va al histórico', () => {
  const { situation, clock, rows, detect, read } = setup();
  const alertRows = () => rows.filter((r) => r.stream === 'alerts');

  read(train('03063', 50));
  let { alerts, kpis } = detect();
  assert.deepEqual(alerts.map((a) => [a.id, a.severity]), [['retraso:renfe-ld:03063', 'media']]);
  assert.equal(kpis.alerts, 1, 'el KPI de alertas cuenta las activas');
  assert.deepEqual(alertRows().map((r) => [r.event, r.id, r.severity, r.since]), [['nueva', 'retraso:renfe-ld:03063', 'media', START]]);

  clock.t += MIN;
  read(train('03063', 95));
  ({ alerts } = detect());
  assert.equal(alerts[0].severity, 'alta');
  assert.equal(alerts[0].since, START, 'conserva desde cuándo está abierta');
  assert.equal(alerts[0].updated, START + MIN);
  assert.deepEqual(alertRows().map((r) => r.event), ['nueva', 'escalada']);

  clock.t += MIN;
  read(train('03063', 96));
  detect();
  assert.deepEqual(alertRows().map((r) => r.event), ['nueva', 'escalada'], 'sigue abierta igual: nada nuevo en el histórico');

  clock.t += MIN;
  read(train('03063', 10));
  ({ alerts, kpis } = detect());
  assert.deepEqual(alerts, []);
  assert.equal(kpis.alerts, 0);
  const resolved = alertRows().at(-1);
  assert.deepEqual([resolved.event, resolved.id, resolved.resolvedAt, resolved.since], ['resuelta', 'retraso:renfe-ld:03063', START + 3 * MIN, START]);
  assert.deepEqual(situation.resolvedAlerts().map((a) => [a.id, a.resolvedAt]), [['retraso:renfe-ld:03063', START + 3 * MIN]], 'y queda entre las resueltas');
  assert.equal(situation.activeAlerts().size, 0);
});

test('las alertas salen ordenadas por gravedad y los KPIs se guardan en el repositorio', () => {
  const { situation, detect, read } = setup();
  read(train('A', 50), train('B', 120), train('C', 3));
  const { alerts, kpis } = detect();
  assert.deepEqual(alerts.map((a) => a.id), ['retraso:renfe-ld:B', 'retraso:renfe-ld:A']);
  assert.equal(situation.kpis(), kpis);
  assert.deepEqual(kpis, {
    t: START, vehicles: 3, byMode: { av: 3 }, delayed: 2, withDelayInfo: 3, medianDelay: 50, maxDelay: 120, alerts: 2,
  });
});

test('los KPIs y las alertas sólo cuentan trenes con GPS: ni autobuses ni posiciones estimadas', () => {
  const { detect, read } = setup();
  read(train('A', 60), train('bus', 70, { mode: 'bus' }), train('ouigo', 80, { estimated: true }));
  const { alerts, kpis } = detect();
  assert.equal(kpis.vehicles, 1);
  assert.deepEqual(alerts.map((a) => a.id), ['retraso:renfe-ld:A']);
});

test('los KPIs se muestrean una vez por minuto, y no sin vehículos', () => {
  const { situation, clock, rows, detect, read } = setup();
  const kpiRows = () => rows.filter((r) => r.stream === 'kpis');
  detect();
  assert.deepEqual(situation.kpiHistory(), [], 'sin vehículos no hay muestra');
  assert.equal(kpiRows().length, 0);

  read(train('A', 7), train('B', 1));
  detect();
  assert.deepEqual(situation.kpiHistory(), [{ t: START, vehicles: 2, delayed: 1, medianDelay: 4 }]);
  assert.equal(kpiRows().length, 1);
  assert.equal(kpiRows()[0].alerts, 0, 'el histórico de KPIs lleva también las alertas activas');

  clock.t += 30_000;
  detect();
  assert.equal(situation.kpiHistory().length, 1, 'a los 30 s, no');
  clock.t += 29_999;
  detect();
  assert.equal(situation.kpiHistory().length, 1, 'a 1 ms del minuto, tampoco');
  clock.t += 1;
  detect();
  assert.deepEqual(situation.kpiHistory().map((k) => k.t), [START, START + MIN]);
  assert.equal(kpiRows().length, 2);
});

test('el muestreo de KPIs guarda como mucho 24 h (1.440 muestras): las más viejas salen', () => {
  const { situation, clock, detect, read } = setup();
  read(train('A', 0));
  for (let i = 0; i < 1441; i++) {
    detect();
    clock.t += MIN;
  }
  const history = situation.kpiHistory();
  assert.equal(history.length, 1440);
  assert.equal(history[0].t, START + MIN, 'la primera ya no está');
  assert.equal(history.at(-1).t, START + 1440 * MIN);
});

test('el histórico no se espera: detect devuelve aunque append no haya terminado', () => {
  const situation = createInMemorySituation();
  situation.registerSource({ id: 'renfe-ld', name: 'Renfe', kind: 'vehicles', interval: 20_000, url: 'https://x.example/' }, { enabled: true });
  situation.saveResult('renfe-ld', { vehicles: [train('A', 100)] }, START, 5);
  const pending = [];
  const history = { append: (stream) => new Promise(() => { pending.push(stream); }) }; // nunca termina
  const detect = makeDetectAlerts({ situation, stations: { nearest: () => null }, history, clock: { now: () => START } });
  const { alerts } = detect();
  assert.equal(alerts.length, 1);
  assert.deepEqual(pending, ['alerts', 'kpis']);
});
