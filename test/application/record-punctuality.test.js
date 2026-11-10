// Caso de uso de la puntualidad: cada minuto, los vehículos de fuentes al día y las cancelaciones en vigor;
// el informe con su nombre y la atribución de su fuente; y la copia, que vuelve igual tras un reinicio. Sin
// reloj real: la hora la da un reloj simulado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRESH_MS, makeRecordPunctuality } from '../../server/application/use-cases/record-punctuality.js';
import { RUN_END_MS, createPunctualityBook } from '../../server/domain/puntualidad.js';

const T0 = Date.parse('2026-11-10T07:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };

function fixture() {
  let now = T0;
  const state = {
    vehicles: [
      { id: 'renfe-ld:08058', source: 'renfe-ld', mode: 'av', operator: 'Renfe', service: 'Avant', line: 'Avant', label: '08058', delay: 7, follow: ['s-renfe-8058', 'l-renfe-Avant'] },
      { id: 'amb-bus:1', source: 'amb-bus', mode: 'bus', operator: 'AMB', line: 'V15', delay: 2, estimated: true, follow: ['s-amb-V15-0k3x9ab-0732', 'l-amb-V15'] },
      // De una fuente que lleva diez minutos sin responder: no es una lectura nueva.
      { id: 'fgc:1', source: 'fgc', mode: 'cercanias', operator: 'FGC', line: 'S1', delay: 30, follow: ['l-fgc-S1'] },
    ],
    events: [
      { id: 'renfe-cancelado:ld:5962', category: 'cancelacion', type: 'cancelado', source: 'renfe-avisos', expires: T0 + 3600_000,
        trip: { operator: 'Renfe', mode: 'av', service: 'AVE', number: '05962', follow: ['s-renfe-5962', 'l-renfe-AVE'] } },
      { id: 'vieja', category: 'cancelacion', type: 'cancelado', source: 'renfe-avisos', expires: T0 - 1, trip: { follow: ['s-renfe-1'] } },
    ],
  };
  const health = () => [
    { id: 'renfe-ld', enabled: true, lastOk: now, license: 'Origen de los datos: Renfe Operadora (CC BY 4.0)' },
    { id: 'amb-bus', enabled: true, lastOk: now - 60_000, license: 'AMB', operatorLicenses: { AMB: 'Font: AMB' } },
    { id: 'fgc', enabled: true, lastOk: now - FRESH_MS - 1, license: 'Font: FGC' },
    { id: 'renfe-avisos', enabled: true, lastOk: now, license: 'Origen de los datos: Renfe Operadora (CC BY 4.0)' },
  ];
  const situation = { vehicles: () => state.vehicles, events: () => state.events, health };
  let saved = null;
  const store = { load: async () => saved, save: async (s) => { saved = s; } };
  const clock = { now: () => now };
  return { state, situation, store, clock, tick: (ms) => { now += ms; }, saved: () => saved };
}

test('cada minuto: vehículos de fuentes al día y cancelaciones en vigor; el informe lleva su nombre y su atribución', () => {
  const f = fixture();
  const p = makeRecordPunctuality({ ...f, log: quiet });
  p.tick();
  f.tick(RUN_END_MS);
  f.state.vehicles = [];
  p.tick();
  const avant = p.report('s-renfe-8058');
  assert.equal(avant.name, 'Avant 08058');
  assert.equal(avant.days.at(-1).status, 'tarde');
  assert.equal(avant.credit, 'Origen de los datos: Renfe Operadora (CC BY 4.0)');
  assert.match(avant.note, /^Retrasos que publica Renfe en su tiempo real; datos modificados/);
  const bus = p.report('l-amb-V15');
  assert.equal(bus.name, 'Autobús V15 · AMB');
  assert.equal(bus.credit, 'Font: AMB', 'la del operador, si la fuente agrupa a varios');
  assert.equal(p.report('l-fgc-S1'), null, 'su fuente no estaba al día');
  assert.equal(p.report('s-renfe-5962').days.at(-1).status, 'cancelado');
  assert.equal(p.report('s-renfe-1'), null, 'una cancelación que ya no está en vigor no cuenta');
});

test('la copia guardada vuelve igual tras un reinicio; sin copia, o con una que no vale, se empieza de cero', async () => {
  const f = fixture();
  const p = makeRecordPunctuality({ ...f, log: quiet });
  p.tick();
  await p.save();
  const infos = [];
  const again = makeRecordPunctuality({ ...f, log: { ...quiet, info: (m) => infos.push(m) } });
  assert.equal(await again.restore(), true);
  assert.deepEqual(again.report('s-renfe-8058'), p.report('s-renfe-8058'));
  assert.match(infos[0], /recuperados 3 servicios y 3 líneas/, 'también el AVE cancelado y su línea');
  const warnings = [];
  const other = makeRecordPunctuality({ ...f, store: { load: async () => ({ version: 0 }), save: async () => {} }, log: { ...quiet, warn: (m) => warnings.push(m) } });
  assert.equal(await other.restore(), false);
  assert.match(warnings[0], /no vale/);
  assert.equal(await makeRecordPunctuality({ ...f, store: { load: async () => null, save: async () => {} }, log: quiet }).restore(), false);
});

test('con la tabla llena se avisa una vez en el registro', () => {
  const f = fixture();
  const warnings = [];
  const p = makeRecordPunctuality({ ...f, log: { ...quiet, warn: (m) => warnings.push(m) }, book: createPunctualityBook({ maxServices: 1 }) });
  p.tick();
  p.tick();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /llena/);
});

