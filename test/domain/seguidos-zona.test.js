// Lo que se avisa en una provincia además de AEMET, terremotos y avisos oficiales: los posibles apagones de las
// islas, Ceuta y Melilla (las alertas del motor de alertas, en la provincia de cada isla) y los focos de calor por
// satélite (sólo confianza alta y potencia alta, agrupados, uno por zona y día y nunca como incendio confirmado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_METRICS, isolatedGridBlackouts } from '../../server/domain/alerts/rules.js';
import { DEFAULT_THRESHOLDS } from '../../server/domain/alerts/thresholds.js';
import {
  FIRE_RULES, STATIC_HEAT, fireFacts, fireZones, gridFacts, hasIsolatedGrid, provinceExtrasText, provinceFacts, provinceOption,
} from '../../server/domain/seguidos/zona.js';
import { FACT_FORGET_MS, collectFacts, newFacts, provinceSub, statusOf, trackFacts } from '../../server/domain/seguidos/avisos.js';
import { provinceById } from '../../server/domain/provincias.js';

const NOW = Date.parse('2026-11-10T11:00:00Z'); // 12:00 en Madrid
const MIN = 60_000;
const HOUR = 3600_000;
const FIRMS_CREDIT = 'NASA FIRMS (LANCE, ESDIS) · Datos de NASA sin restricciones de uso · No apto para decisiones tácticas';
const creditOf = (source) => ({ firms: FIRMS_CREDIT, 'renfe-avisos': 'Origen de los datos: Renfe Operadora' })[source] ?? null;

/** Alertas de verdad, de la regla de los apagones de los sistemas aislados, con su demanda (MW). */
function gridAlerts(systems) {
  const list = systems.map(([id, name, real, programmed]) => ({
    id, name, real, programmed, recentMax: real, readMax: real, at: NOW - 10 * MIN, previous: { real, at: NOW - 15 * MIN },
  }));
  return isolatedGridBlackouts({ now: NOW, metrics: { [GRID_METRICS.aislados]: { systems: list } }, thresholds: DEFAULT_THRESHOLDS })
    .map((a) => ({ ...a, since: NOW - 5 * MIN }));
}

/** Un foco de FIRMS como lo da su adaptador. */
const foco = (lat, lon, frp, { confidence = 'alta', start = NOW - 2 * HOUR, id = `firms:${lat}:${lon}:${start}` } = {}) => ({
  id, source: 'firms', category: 'incendio', type: 'foco', title: `Foco de calor de ${Math.round(frp)} MW`, frp, confidence, lat, lon, start,
});

test('apagones: cada sistema aislado, en la provincia de sus islas; el peninsular y los demás, no', () => {
  const alerts = gridAlerts([['la-palma', 'La Palma', 0, 21], ['lanzarote-fuerteventura', 'Lanzarote y Fuerteventura', 60, 200], ['ceuta', 'Ceuta', 0.5, 30]]);
  alerts.push({ id: 'red-electrica', type: 'red-electrica', severity: 'alta', title: 'Demanda eléctrica 31 % por debajo de lo previsto', description: '…' });
  alerts.push({ id: 'sismo:x', type: 'sismo', severity: 'alta', title: 'Terremoto', description: '…' });
  const [total, silent] = gridFacts(alerts, 'santa-cruz-de-tenerife');
  assert.equal(total.id, 'red-aislada:la-palma|total');
  assert.equal(total.kind, 'apagon');
  assert.match(total.text, /^Posible apagón total en La Palma: demanda a 0 MW\. Real 0 MW a las .+ \(hora peninsular\) frente a 21 MW programados\. Estimación de Radar España con datos de Red Eléctrica: confírmalo con los avisos oficiales\.$/);
  assert.equal(total.credit, 'Fuente: Red Eléctrica', 'citando a Red Eléctrica, como la web');
  assert.deepEqual(silent, { ...total, id: 'red-aislada:la-palma|parcial', silent: true }, 'si vuelve a medias, no se avisa');
  assert.deepEqual(gridFacts(alerts, 'las-palmas').map((f) => f.id), ['red-aislada:lanzarote-fuerteventura|parcial'], 'una caída fuerte, no total');
  assert.deepEqual(gridFacts(alerts, 'ceuta').map((f) => f.id), ['red-aislada:ceuta|total', 'red-aislada:ceuta|parcial']);
  assert.deepEqual(gridFacts(alerts, 'madrid'), [], 'la demanda peninsular no es de ninguna provincia');
  assert.deepEqual(gridFacts(alerts, 'illes-balears'), []);
  assert.deepEqual(gridFacts(undefined, 'ceuta'), []);
});

test('qué provincias tienen sus apagones a la vista: Canarias, Ceuta y Melilla (Baleares no: no hay demanda real en tiempo real)', () => {
  for (const id of ['las-palmas', 'santa-cruz-de-tenerife', 'ceuta', 'melilla']) assert.equal(hasIsolatedGrid(id), true, id);
  for (const id of ['illes-balears', 'madrid', 'granada']) assert.equal(hasIsolatedGrid(id), false, id);
});

test('focos: sólo confianza alta y 10 MW o más, de hoy, fuera de las fuentes de calor fijas', () => {
  const events = [
    foco(37.05, -3.35, 45),
    foco(37.3, -3.0, 45, { confidence: 'nominal' }),
    foco(37.6, -3.6, 9.9),
    foco(37.2, -2.9, 80, { start: NOW - 11.5 * HOUR }), // 00:30 de hoy en Madrid
    foco(37.6, -2.9, 80, { start: NOW - 12.5 * HOUR }), // 23:30 de ayer: aunque sea de hace menos de 13 h
    foco(37.4, -3.9, 80, { start: NOW + 5 * MIN }), // del futuro: un reloj mal puesto
    foco(43.527, -5.732, 120), // la siderurgia de Gijón: no es un incendio
    { id: 'obra', category: 'carretera', lat: 37.05, lon: -3.35, frp: 45, confidence: 'alta', start: NOW },
  ];
  assert.deepEqual(fireZones(events, NOW).map((z) => z.strongest.id), [events[3].id, events[0].id], 'por orden de detección');
  assert.ok(STATIC_HEAT.every((s) => s.km <= 6), 'círculos pequeños: no tapan una comarca');
  // Un foco de esta madrugada sigue contando hasta medianoche (aunque sea de hace más de 12 h).
  const early = foco(37.05, -3.35, 45, { start: Date.parse('2026-11-09T23:30:00Z') }); // 00:30 de hoy en Madrid
  assert.equal(fireZones([early], Date.parse('2026-11-10T22:00:00Z')).length, 1, 'a las 23:00 de hoy, aún');
  assert.equal(fireZones([early], Date.parse('2026-11-10T23:30:00Z')).length, 0, 'mañana, no');
});

test('focos agrupados: un foco fuerte o tres juntos son un aviso; dos flojos, no; los repetidos cuentan una vez', () => {
  const strong = [foco(37.05, -3.35, 31)];
  assert.equal(fireZones(strong, NOW).length, 1);
  const two = [foco(37.05, -3.35, 15), foco(37.06, -3.35, 15)];
  assert.equal(fireZones(two, NOW).length, 0, 'dos de 15 MW: no');
  const three = [...two, foco(37.07, -3.35, 12)];
  const [z] = fireZones(three, NOW);
  assert.equal(z.focos, 3);
  assert.equal(z.maxFrp, 15);
  assert.deepEqual(z.provinces, ['granada']);
  assert.equal(fireZones([...two, two[0]], NOW).length, 0, 'el mismo foco en los dos ficheros de FIRMS cuenta una vez');
  // Encadenados: cada uno a menos de 2 km del siguiente, aunque los extremos estén a 5 km.
  const chain = [0, 1, 2, 3, 4, 5].map((i) => foco(37.05 + i * 0.009, -3.35, 12));
  assert.equal(fireZones(chain, NOW).length, 1);
  assert.equal(fireZones(chain, NOW)[0].focos, 6);
  // Lejos (a más de 2 km): dos grupos de dos, ninguno es aviso.
  assert.equal(fireZones([foco(37.05, -3.35, 15), foco(37.06, -3.35, 15), foco(37.2, -3.35, 15), foco(37.21, -3.35, 15)], NOW).length, 0);
});

test('como mucho un aviso por zona y día: aunque el fuego crezca o haya otro grupo en la zona; al día siguiente, otro', () => {
  const morning = [foco(37.05, -3.35, 40, { start: NOW - 3 * HOUR })];
  const [first] = fireZones(morning, NOW);
  const afternoon = [...morning, foco(37.07, -3.36, 90, { start: NOW + HOUR }), foco(37.08, -3.36, 50, { start: NOW + HOUR })];
  const later = fireZones(afternoon, NOW + 2 * HOUR);
  assert.deepEqual(later.map((z) => z.zone), [first.zone], 'crece: la misma zona');
  assert.equal(later[0].maxFrp, 90);
  // Otro grupo a 8 km, en la misma casilla y el mismo día: el mismo aviso.
  const other = [...morning, foco(37.05, -3.26, 35, { start: NOW - HOUR })];
  const merged = fireZones(other, NOW);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].focos, 2);
  // Lo de ayer no cuenta hoy: dos de ayer y uno de hoy no son tres juntos.
  const yesterday = [foco(37.05, -3.35, 15, { start: NOW - 20 * HOUR }), foco(37.06, -3.35, 15, { start: NOW - 20 * HOUR })];
  assert.equal(fireZones([...yesterday, foco(37.07, -3.35, 15, { start: NOW - HOUR })], NOW).length, 0);
  // Al día siguiente, los de ayer ya no cuentan y el primero es otro: otro aviso.
  const tomorrow = Date.parse('2026-11-11T13:00:00Z');
  const next = fireZones([...afternoon, foco(37.06, -3.35, 60, { start: tomorrow - HOUR })], tomorrow);
  assert.equal(next.length, 1);
  assert.notEqual(next[0].zone, first.zone);
  assert.match(next[0].zone, /^2026-11-11\|/);
});

test('un aviso de focos se recuerda todo su día aunque deje de verse unas horas (los demás hechos, 3 h)', () => {
  const sub = provinceSub('granada');
  const zones = fireZones([foco(37.05, -3.35, 44.6, { start: NOW - HOUR })], NOW);
  const fire = fireFacts(zones, 'granada');
  const other = { id: 'aemet:1', kind: 'meteo', text: 'Aviso naranja' };
  let seen = trackFacts(new Map(), new Map([[sub, [...fire, other]]]), NOW);
  const gone = NOW + FACT_FORGET_MS + HOUR; // ni se ven (la fuente ha fallado) ni han pasado 26 h
  seen = trackFacts(seen, new Map(), gone);
  assert.deepEqual([...seen.keys()], [`${sub}|${fire[0].id}`]);
  assert.deepEqual(newFacts(sub, fire, trackFacts(seen, new Map([[sub, fire]]), gone + MIN), gone), [], 'vuelve: no es nuevo');
  assert.equal(trackFacts(seen, new Map(), NOW + 27 * HOUR).size, 0, 'al día siguiente se olvida (su id ya sería otro)');
});

test('el texto de un aviso de focos: detección por satélite, no un incendio confirmado; qué más puede ser, dónde y su atribución', () => {
  const zones = fireZones([foco(37.05, -3.35, 44.6), foco(37.06, -3.35, 20), foco(37.07, -3.35, 12)], NOW);
  const [f] = fireFacts(zones, 'granada', (e) => creditOf(e.source));
  assert.equal(f.kind, 'incendio');
  assert.equal(f.id, `incendio|${zones[0].zone}`);
  assert.equal(f.text, 'Posible incendio: 3 focos de calor juntos, el más fuerte de 45 MW; el último, detectado el 10/11, 10:00. '
    + 'Es una detección por satélite, no un incendio confirmado: también puede ser una quema agrícola o una fuente de calor industrial. '
    + 'Dónde: https://www.openstreetmap.org/?mlat=37.0500&mlon=-3.3500#map=13/37.0500/-3.3500');
  assert.equal(f.credit, FIRMS_CREDIT);
  assert.deepEqual(fireFacts(zones, 'jaen'), [], 'sólo en su provincia');
  // En Canarias, también puede ser un volcán.
  const [palma] = fireFacts(fireZones([foco(28.75, -17.85, 35)], NOW), 'santa-cruz-de-tenerife');
  assert.match(palma.text, /^Posible incendio: un foco de calor de 35 MW, detectado el 10\/11, 10:00\. Es una detección por satélite, no un incendio confirmado: también puede ser una quema agrícola, actividad volcánica o una fuente de calor industrial\./);
  assert.equal(palma.credit, null, 'sin atribución conocida, ninguna');
});

test('/provincia con o sin incendios', () => {
  assert.deepEqual(provinceOption('Granada'), { place: 'Granada', fires: null });
  assert.deepEqual(provinceOption('Granada incendios'), { place: 'Granada', fires: true });
  assert.deepEqual(provinceOption('A Coruña con incendios'), { place: 'A Coruña', fires: true });
  assert.deepEqual(provinceOption('Santa Cruz de Tenerife focos de calor'), { place: 'Santa Cruz de Tenerife', fires: true });
  assert.deepEqual(provinceOption('incendios en Granada'), { place: 'Granada', fires: true });
  assert.deepEqual(provinceOption('Granada sin incendios'), { place: 'Granada', fires: false });
  assert.deepEqual(provinceOption('Granada  sin  fuegos'), { place: 'Granada', fires: false });
  assert.deepEqual(provinceOption(''), { place: '', fires: null });
});

test('lo que se dice al seguir una provincia: sus apagones si tiene islas o es Ceuta o Melilla; y los focos, o cómo pedirlos', () => {
  assert.equal(provinceExtrasText(provinceById('granada'), { fires: false }),
    'Si quieres también los focos de calor que detecta el satélite (posibles incendios, sin confirmar): /provincia Granada incendios');
  assert.equal(provinceExtrasText(provinceById('granada'), { fires: true }),
    'También te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio confirmado. '
    + 'Para quitarlos: /provincia Granada sin incendios');
  assert.match(provinceExtrasText(provinceById('las-palmas'), { fires: true }),
    /^También te aviso de los posibles apagones que se ven en la demanda eléctrica de cada isla \(una estimación de Radar España con datos de Red Eléctrica\)\. Y de los focos/);
  assert.match(provinceExtrasText(provinceById('melilla'), { fires: false }), /demanda eléctrica de Melilla/);
});

test('hechos y estado de una provincia: apagones siempre; focos, sólo a quien los pide', () => {
  const alerts = gridAlerts([['la-palma', 'La Palma', 0, 21]]);
  const events = [foco(28.75, -17.85, 35)];
  const facts = collectFacts({ keys: [], provinces: ['santa-cruz-de-tenerife', 'granada'], events, alerts, now: NOW, creditOf });
  const sub = provinceSub('santa-cruz-de-tenerife');
  assert.deepEqual(facts.get(sub).map((f) => f.kind), ['apagon', 'apagon', 'incendio']);
  assert.equal(facts.get(provinceSub('granada')), undefined);
  assert.deepEqual(provinceFacts(facts.get(sub)).map((f) => f.id), ['red-aislada:la-palma|total'], 'sin focos ni callados');
  assert.equal(provinceFacts(facts.get(sub), { fires: true }).length, 2);
  const plain = statusOf(sub, { events, alerts, now: NOW, creditOf });
  assert.equal(plain.lines.length, 2, 'el apagón y, detrás, el tráfico (trafico.js)');
  assert.match(plain.lines[0], /^Posible apagón total en La Palma/);
  assert.equal(plain.lines[1], 'Carreteras: ahora no hay cortes ni accidentes graves.');
  assert.deepEqual(plain.credits, ['Fuente: Red Eléctrica']);
  const withFires = statusOf(sub, { events, alerts, now: NOW, creditOf, fires: true });
  assert.match(withFires.lines[1], /^Posible incendio: un foco de calor de 35 MW/);
  assert.deepEqual(withFires.credits, ['Fuente: Red Eléctrica', FIRMS_CREDIT]);
  const quiet = statusOf(provinceSub('granada'), { events, alerts, now: NOW, creditOf, fires: true });
  assert.deepEqual(quiet.lines, [
    'Ahora no hay avisos naranja o rojo de AEMET, terremotos que puedan sentirse ni avisos oficiales en Granada.',
    'Focos de calor por satélite: ahora ninguno de los que aviso (confianza alta y potencia alta).',
    'Carreteras: ahora no hay cortes ni accidentes graves.',
  ]);
  assert.equal(FIRE_RULES.clusterKm, DEFAULT_THRESHOLDS.fireClusterKm, 'el mismo grupo que el motor de alertas');
});

test('la fundición de Atlantic Copper (Huelva), a 4 km de La Rábida, también es una fuente de calor fija', async () => {
  const { CALOR_FIJO } = await import('../../server/domain/lugares.js');
  const { distanceKm } = await import('../../server/domain/geo.js');
  assert.ok(CALOR_FIJO.some((s) => distanceKm(s.lat, s.lon, 37.229, -6.948) <= s.km));
});

test('/estado de una provincia: lo más grave primero (un apagón total no queda detrás de muchos avisos naranja), con su atribución', () => {
  const alerts = gridAlerts([['la-palma', 'La Palma', 0, 21]]);
  const orange = Array.from({ length: 10 }, (_, i) => ({ id: `aemet:${i}`, source: 'aemet-avisos', category: 'meteo', type: 'costeros', level: i === 9 ? 'rojo' : 'naranja',
    title: `Aviso ${i === 9 ? 'rojo' : 'naranja'} por fenómenos costeros · Zona ${i}`, lat: 28.47, lon: -16.25, issued: NOW - HOUR, start: NOW, end: NOW + 6 * HOUR,
    credit: '© AEMET' }));
  const { lines, credits } = statusOf(provinceSub('santa-cruz-de-tenerife'), { events: orange, alerts, now: NOW, creditOf });
  assert.match(lines[0], /^Posible apagón total en La Palma/, lines[0]);
  assert.match(lines[1], /^Aviso rojo por fenómenos costeros/);
  assert.equal(lines.filter((l) => l.startsWith('Aviso naranja')).length, 6, 'hasta ocho en total');
  assert.match(lines.find((l) => l.startsWith('…y')), /^…y 3 más\.$/);
  assert.ok(credits.includes('© AEMET') && credits.some((c) => /Red Eléctrica/.test(c)), credits.join(' | '));
});
