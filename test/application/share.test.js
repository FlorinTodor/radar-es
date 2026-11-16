import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShare, ShareBusy } from '../../server/application/use-cases/share.js';

const NOW = Date.UTC(2026, 10, 16, 10, 42);
const accident = { id: 'dgt:1', source: 'dgt', category: 'carretera', type: 'accident', severity: 'alta', title: 'Accidente · A-7 km 214.0', lat: 36.7, lon: -4.4 };
const bus = { id: 'bus-x:1', source: 'bus-x', mode: 'bus', operator: 'EMT', line: '27', label: '27', lat: 40.4, lon: -3.7, delay: null };
const log = { info() {}, warn() {}, error() {} };

function setup({ events = [accident], vehicles = [bus], available = true, render } = {}) {
  const state = { events, vehicles, now: NOW, saved: [], loaded: null, renders: 0 };
  const share = makeShare({
    query: {
      events: () => state.events, vehicles: () => state.vehicles, health: () => [{ id: 'dgt', license: 'Fuente: DGT' }, { id: 'bus-x', operatorLicenses: { EMT: 'Fuente: EMT' } }],
      station: (code) => (code === '71801' ? { code, name: 'Barcelona-Sants', lat: 41.38, lon: 2.14 } : null),
    },
    store: { load: async () => state.loaded, save: async (r) => { state.saved.push(r); } },
    renderer: {
      available: () => available,
      render: render ?? (async () => { state.renders++; return new Uint8Array(1000); }),
    },
    clock: { now: () => state.now },
    log,
  });
  return { share, state };
}

test('lookup: lo del directo, con la atribución de su fuente (la del operador si agrupa a varios)', () => {
  const { share } = setup();
  const e = share.lookup('incidencia', 'dgt:1');
  assert.equal(e.status, 'activa');
  assert.equal(e.card.credit, 'Fuente: DGT');
  const v = share.lookup('vehiculo', 'bus-x:1');
  assert.equal(v.card.credit, 'Fuente: EMT');
  assert.equal(v.vehicle.mode, 'bus');
  assert.equal(share.lookup('estacion', '71801').card.title, 'Barcelona-Sants');
  assert.equal(share.lookup('incidencia', 'no-existe'), null);
  assert.equal(share.lookup('otra', 'dgt:1'), null);
});

test('una incidencia que deja de salir sigue en su enlace como «ya no está en el directo», y se guarda', async () => {
  const { share, state } = setup();
  share.remember();
  state.events = [];
  state.now = NOW + 60_000;
  assert.equal(share.remember(), 1);
  const gone = share.lookup('incidencia', 'dgt:1');
  assert.equal(gone.status, 'terminada');
  assert.equal(gone.ended.endedAt, NOW + 60_000);
  assert.equal(gone.card.status.active, false);
  await share.save();
  assert.equal(state.saved.length, 1);
  await share.save(); // sin cambios, no vuelve a escribir
  assert.equal(state.saved.length, 1);
});

test('al arrancar, recupera las terminadas que guardó el servidor anterior', async () => {
  const first = setup();
  first.share.remember();
  first.state.events = [];
  first.share.remember();
  await first.share.save();
  const second = setup({ events: [] });
  second.state.loaded = JSON.parse(JSON.stringify(first.state.saved[0]));
  await second.share.restore();
  assert.equal(second.share.lookup('incidencia', 'dgt:1').status, 'terminada');
});

test('el índice por id se rehace cada pocos segundos, no en cada consulta', () => {
  const { share, state } = setup();
  let calls = 0;
  const list = state.events;
  Object.defineProperty(state, 'events', { get: () => { calls++; return list; } });
  share.lookup('incidencia', 'dgt:1');
  share.lookup('incidencia', 'dgt:1');
  assert.equal(calls, 1);
  state.now += 5_000;
  share.lookup('incidencia', 'dgt:1');
  assert.equal(calls, 2);
});

test('card: se dibuja una vez por versión; dos peticiones a la vez esperan al mismo dibujo', async () => {
  const { share, state } = setup();
  const [a, b] = await Promise.all([share.card('incidencia', 'dgt:1'), share.card('incidencia', 'dgt:1')]);
  assert.equal(state.renders, 1);
  assert.equal(a.version, b.version);
  await share.card('incidencia', 'dgt:1');
  assert.equal(state.renders, 1);
  // Otro minuto: la hora de la comprobación cambia lo que enseña, así que es otra versión.
  state.now += 60_000;
  await share.card('incidencia', 'dgt:1');
  assert.equal(state.renders, 2);
  assert.equal(await share.card('incidencia', 'no-existe'), null);
});

test('card: sin presupuesto o con la cola llena, ShareBusy (y lo que ya está dibujado no gasta nada)', async () => {
  const pending = [];
  const { share } = setup({ render: () => new Promise((resolve) => pending.push(resolve)) });
  await assert.rejects(share.card('incidencia', 'dgt:1', 'es', { allow: () => false }), ShareBusy);
  const events = Array.from({ length: 6 }, (_, i) => ({ ...accident, id: `dgt:${i + 10}` }));
  const many = setup({ events, render: () => new Promise((resolve) => pending.push(resolve)) });
  const jobs = events.slice(0, 4).map((e) => many.share.card('incidencia', e.id));
  await assert.rejects(many.share.card('incidencia', 'dgt:14'), ShareBusy);
  for (const resolve of pending) resolve(new Uint8Array(10));
  await Promise.all(jobs);
  // Ya dibujada: aunque no haya presupuesto, se sirve.
  assert.ok(await many.share.card('incidencia', 'dgt:10', 'es', { allow: () => false }));
});

test('card: sin letra no hay tarjetas, y un fallo al dibujar se registra y da null', async () => {
  assert.equal(await setup({ available: false }).share.card('incidencia', 'dgt:1'), null);
  const warned = [];
  const broken = makeShare({
    query: { events: () => [accident], vehicles: () => [], health: () => [], station: () => null },
    store: { load: async () => null, save: async () => {} },
    renderer: { available: () => true, render: async () => { throw new Error('roto'); } },
    clock: { now: () => NOW }, log: { ...log, warn: (m) => warned.push(m) },
  });
  assert.equal(await broken.card('incidencia', 'dgt:1'), null);
  assert.match(warned[0], /roto/);
  // El fallo no se queda «dibujándose»: la siguiente lo vuelve a intentar.
  assert.equal(await broken.card('incidencia', 'dgt:1'), null);
  assert.equal(warned.length, 2);
});

test('card: el memo de tarjetas tiene tope', async () => {
  const events = Array.from({ length: 230 }, (_, i) => ({ ...accident, id: `dgt:${i}` }));
  const { share } = setup({ events });
  for (const e of events) await share.card('incidencia', e.id);
  assert.equal(share.sizes().cards, 200);
});
