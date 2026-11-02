// Alertas a partir de los avisos oficiales de protección civil y de los 112: cortes de luz y planes
// en alerta o emergencia. Funciones puras: sin red ni reloj.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRules, officialEmergencyPlans, officialPowerCuts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';

const ctx = (events, health = []) => ({
  now: Date.parse('2026-11-02T12:00:00Z'), vehicles: [], tracks: new Map(), events, metrics: {}, health,
  kpis: { vehicles: 0 }, kpiHistory: [], nearestStation: () => null, thresholds: DEFAULT_THRESHOLDS,
});

const aviso = (id, extra = {}) => ({
  id, group: id.split(':').slice(0, 2).join(':'), category: 'emergencia', type: 'plan', power: false, severity: 'alta',
  title: 'Aviso', description: '', area: 'La Palma', approx: 'isla', lat: 28.68, lon: -17.86, source: 'emergencias-canarias',
  credit: 'Fuente: Gobierno de Canarias', ...extra,
});

test('corte de luz oficial → alerta con su lugar, el texto del aviso entre comillas y la atribución', () => {
  const [alert] = officialPowerCuts(ctx([aviso('emergencias-canarias:123:la-palma', {
    type: 'apagon', power: true, title: 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma',
    description: 'A las 06:42 h se ha producido un fallo general del sistema eléctrico en la isla de La Palma (cero energético).',
  })]));
  assert.equal(alert.id, 'apagon:emergencias-canarias:123');
  assert.equal(alert.type, 'apagon');
  assert.equal(alert.severity, 'alta');
  assert.equal(alert.title, 'Corte de luz · La Palma');
  assert.match(alert.description, /^Aviso oficial: «A las 06:42 h se ha producido un fallo general/);
  assert.equal(alert.credit, 'Fuente: Gobierno de Canarias');
  assert.deepEqual(alert.eventIds, ['emergencias-canarias:123:la-palma']);
});

test('el mismo aviso en varios pueblos es una sola alerta que los señala todos', () => {
  const cut = (place) => aviso(`emergencias-andalucia:GeNews-1:luz:${place}`, {
    group: 'emergencias-andalucia:GeNews-1:luz', type: 'apagon', power: true, severity: 'media', area: place, approx: 'municipio',
    description: 'Hay falta de suministro eléctrico en Espera y San José del Valle', credit: 'Información obtenida del Portal de la Junta de Andalucía',
  });
  const alerts = officialPowerCuts(ctx([cut('Espera'), cut('San José del Valle')]));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Corte de luz · Espera, San José del Valle');
  assert.equal(alerts[0].eventIds.length, 2);
  assert.equal(alerts[0].severity, 'media');
});

test('sin lugar exacto, la alerta lo dice', () => {
  const [alert] = officialPowerCuts(ctx([aviso('emergencias-cataluna:procicat', {
    type: 'apagon', power: true, area: 'Cataluña', approx: 'comunidad', title: 'PROCICAT · ALERTA', description: 'Apagada elèctrica generalitzada',
  })]));
  assert.match(alert.description, /no dice el lugar exacto/);
});

test('planes: alerta y emergencia dan alerta; la prealerta se queda en el mapa', () => {
  const alerts = officialEmergencyPlans(ctx([
    aviso('emergencias-canarias:200:la-palma', { severity: 'muy alta', title: 'El Gobierno de Canarias declara la Alerta Máxima por lluvias en La Palma' }),
    aviso('emergencias-canarias:201:tenerife', { severity: 'media', area: 'Tenerife', title: 'Prealerta por tormentas' }),
    aviso('emergencias-canarias:202:la-palma', { type: 'apagon', power: true, title: 'cero energético' }),
  ]));
  assert.equal(alerts.length, 1, 'ni la prealerta ni el corte de luz (tiene su propia regla)');
  assert.equal(alerts[0].severity, 'muy alta');
  assert.equal(alerts[0].title, 'El Gobierno de Canarias declara la Alerta Máxima por lluvias en La Palma', 'el lugar ya está en el título');
  assert.equal(alerts[0].type, 'emergencia');
});

test('la atribución sale de la fuente si el suceso no la trae', () => {
  const [alert] = officialPowerCuts(ctx(
    [aviso('emergencias-la-rioja:x:ventrosa', { power: true, type: 'apagon', credit: undefined, source: 'emergencias-la-rioja' })],
    [{ id: 'emergencias-la-rioja', license: 'Fuente: Gobierno de La Rioja (SOS Rioja 112)' }],
  ));
  assert.equal(alert.credit, 'Fuente: Gobierno de La Rioja (SOS Rioja 112)');
});

test('las reglas de avisos oficiales están en el motor y no tocan otros sucesos', () => {
  const alerts = evaluateRules(ctx([
    aviso('emergencias-canarias:1:la-palma', { type: 'apagon', power: true }),
    { id: 'aemet:1', category: 'meteo', level: 'amarillo', severity: 'media', title: 'Aviso amarillo', lat: 28, lon: -16 },
  ]));
  assert.deepEqual(alerts.filter((a) => a.type === 'apagon' || a.type === 'emergencia').map((a) => a.type), ['apagon']);
});
