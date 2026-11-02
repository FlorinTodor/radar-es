// Avisos oficiales (protección civil y 112): qué es un corte de luz, qué nivel declaran, de qué
// riesgo tratan, dónde y cuáles siguen en vigor. Con frases reales de cada fuente; sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentNotices, illesIn, islandsIn, isEndNotice, isPlanNotice, mentionsPlan, mentionsPowerBack, mentionsPowerCut,
  placeCandidates, powerClauses, provincesIn, severityOf, subjectsOf,
} from '../../server/domain/emergencias.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');

test('corte de luz: las frases de los avisos que dicen que falta la luz', () => {
  for (const t of [
    'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma',
    'Hay falta de suministro eléctrico en Espera y San José del Valle',
    'En Benamahoma el ayuntamiento informó que toda la población estaba anoche sin suministro eléctrico ni cobertura',
    'Avería que afecta a suministro eléctrico y telefónico',
    'La Junta activa la Situación 2 del Plan de Emergencias de Protección Civil ante el apagón',
    'Talls de llum a diversos municipis del Maresme',
  ]) assert.ok(mentionsPowerCut(t), t);
});

test('no es un corte de luz: garantizar el suministro, apagones que no son eléctricos, simulacros', () => {
  for (const t of [
    'a fin de garantizar la continuidad del suministro eléctrico a través de generadores',
    'ha contrastado estos números con el «apagón ferroviario» que sufre Andalucía',
    'Colisión de un turismo con un patinete',
  ]) assert.ok(!mentionsPowerCut(t), t);
  assert.ok(!isPlanNotice('La EMA realiza un simulacro de incendio forestal y activa el Plan Infoca'));
});

test('la luz vuelve: «restablecido», «recuperado», también en catalán', () => {
  assert.ok(mentionsPowerBack('Restablecido el suministro eléctrico'));
  assert.ok(mentionsPowerBack('en Puerto Serrano ya se ha recuperado tanto la luz como la cobertura'));
  assert.ok(mentionsPowerBack('Restablert el subministrament elèctric a Badalona'));
  assert.ok(isEndNotice('Restablecido el suministro eléctrico'));
  assert.ok(isEndNotice('El Gobierno de Canarias finaliza la situación de prealerta por lluvias'));
  assert.ok(isEndNotice('PLATECAM, desactivado en la provincia de Toledo'));
  assert.ok(!isEndNotice('El Gobierno de Canarias declara la prealerta por lluvia en El Hierro'));
});

test('planes: activaciones y cambios de nivel, no cualquier noticia que nombre un plan', () => {
  assert.ok(isPlanNotice('El Gobierno declara la prealerta por tormentas en las islas occidentales y Gran Canaria'));
  assert.ok(isPlanNotice('Desciende a fase de preemergencia el Plan Infoca por el incendio en Los Gallardos'));
  assert.ok(isPlanNotice('PLATECAM, activado en la provincia de Toledo'));
  assert.ok(!isPlanNotice('La Junta reúne al Comité Asesor del Plan Sísmico tras el terremoto de Granada'));
  assert.ok(!isPlanNotice('El Gobierno de Canarias analiza el estado de las infraestructuras ante la temporada de lluvias'));
  assert.ok(mentionsPlan('METEOCAM. Albacete, Ciudad Real, Cuenca y Toledo'), 'en Castilla-La Mancha el título es sólo el plan');
});

test('nivel: prealerta → media, alerta → alta, alerta máxima o emergencia → muy alta', () => {
  assert.equal(severityOf('declara la prealerta por calima'), 'media');
  assert.equal(severityOf('actualiza la situación a alerta por lluvias'), 'alta');
  assert.equal(severityOf('declara la Alerta Máxima por lluvias en La Palma'), 'muy alta');
  assert.equal(severityOf('EMERGÈNCIA'), 'muy alta');
  assert.equal(severityOf('activa la Situación 2 del Plan de Emergencias'), 'muy alta');
  assert.equal(severityOf('activa el Plan de Emergencia ante el Riesgo de Inundaciones en fase de preemergencia'), 'alta',
    '«Plan de Emergencia» es el nombre del plan, no el nivel');
  assert.equal(severityOf('PLATECAM, activado en la provincia de Toledo'), null);
});

test('de qué trata: el mismo riesgo aunque el título cambie, y «luz» si habla del suministro', () => {
  assert.deepEqual(subjectsOf('declara la prealerta por lluvias en El Hierro'), ['lluvia']);
  assert.deepEqual(subjectsOf('finaliza la situación de prealerta por lluvia'), ['lluvia']);
  assert.deepEqual(subjectsOf('Desciende a fase de preemergencia el Plan Infoca por el incendio en Los Gallardos'), ['incendio']);
  assert.deepEqual(subjectsOf('activa el PLATECA en situación de alerta por cero energético en La Palma'), ['luz']);
  assert.deepEqual(subjectsOf('PLATECAM, activado en la provincia de Toledo'), ['platecam']);
  assert.deepEqual(subjectsOf('activa la prealerta del PLATECA por afectación a suministros básicos en Lanzarote', 'Lanzarote sin suministro eléctrico'),
    ['suministros', 'luz']);
});

test('islas y provincias que nombra un aviso', () => {
  assert.deepEqual(islandsIn('Isla de La Palma'), ['La Palma']);
  assert.deepEqual(islandsIn('prealerta por tormentas en las islas occidentales y Gran Canaria').sort(),
    ['El Hierro', 'Gran Canaria', 'La Gomera', 'La Palma', 'Tenerife']);
  assert.deepEqual(islandsIn('prealerta por calima en todo el Archipiélago'), ['*']);
  assert.deepEqual(islandsIn('El Gobierno de Canarias finaliza la prealerta'), []);
  assert.deepEqual(provincesIn('METEOCAM. Albacete, Ciudad Real, Cuenca y Toledo'), ['Albacete', 'Ciudad Real', 'Cuenca', 'Toledo']);
});

test('lugares que cita el texto, para el geocodificador', () => {
  assert.deepEqual(placeCandidates('Hay falta de suministro eléctrico en Espera y San José del Valle'), ['Espera', 'San José del Valle']);
  assert.deepEqual(placeCandidates('la avería afecta a Mansilla, Villavelayo, Ventrosa, Brieva y Las Viniegras'),
    ['Mansilla', 'Villavelayo', 'Ventrosa', 'Brieva', 'Las Viniegras']);
  assert.deepEqual(placeCandidates('falta de suministro eléctrico, telefonía e internet en la población de Trebujena.'), ['Trebujena']);
  assert.deepEqual(placeCandidates('Endesa trabaja en la zona'), []);
});

test('una frase con el corte y la vuelta de la luz se separa', () => {
  const { cut, back } = powerClauses('Hay falta de suministro eléctrico en Espera y San José del Valle, mientras que en Puerto Serrano ya se ha recuperado tanto la luz como la cobertura.');
  assert.equal(cut.length, 1);
  assert.match(cut[0], /Espera y San José del Valle$/);
  assert.equal(back.length, 1);
  assert.match(back[0], /Puerto Serrano/);
});

const notice = (id, hoursAgo, { end = false, subjects = ['lluvia'], places = [] } = {}) => ({ id, at: NOW - hoursAgo * HOUR, end, subjects, places });

test('en vigor: el aviso más nuevo de cada riesgo y lugar; un «finaliza» cierra los anteriores', () => {
  const list = currentNotices([
    notice('prealerta-todas', 30, { places: [] }),
    notice('alerta-maxima-lp', 9, { places: ['La Palma'] }),
    notice('alerta-lp-lg', 3, { places: ['La Palma', 'La Gomera'] }),
    notice('fin-lg', 1, { end: true, places: ['La Gomera'] }),
    notice('cero-lp', 4, { subjects: ['luz'], places: ['La Palma'] }),
  ], { now: NOW, maxAgeMs: 96 * HOUR });
  const got = list.map(({ notice: n, place }) => `${n.id}@${place ?? 'todo'}`).sort();
  assert.deepEqual(got, ['alerta-lp-lg@La Palma', 'cero-lp@La Palma', 'prealerta-todas@todo']);
});

test('en vigor: un fin sin lugares cierra el riesgo en todo el territorio; lo viejo caduca', () => {
  const list = currentNotices([
    notice('alerta-hierro', 10, { places: ['El Hierro'] }),
    notice('fin-todo', 2, { end: true }),
    notice('calima-vieja', 120, { subjects: ['calima'] }),
    notice('luz-nueva', 1, { subjects: ['luz'], places: ['Ventrosa'] }),
  ], { now: NOW, maxAgeMs: 96 * HOUR });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['luz-nueva']);
});

test('en vigor: si la luz vuelve en un pueblo, el corte sigue en los demás', () => {
  const list = currentNotices([
    notice('corte', 5, { subjects: ['luz'], places: ['Espera', 'Puerto Serrano'] }),
    notice('vuelve', 2, { end: true, subjects: ['luz'], places: ['Puerto Serrano'] }),
  ], { now: NOW, maxAgeMs: 24 * HOUR });
  assert.deepEqual(list.map(({ place }) => place), ['Espera']);
});

test('en vigor: en una incidencia del 112 (un solo suceso), la vuelta de la luz en un pueblo cierra la avería entera', () => {
  const list = currentNotices([
    notice('averia', 5, { subjects: ['luz'], places: ['Ventrosa', 'Brieva'] }),
    notice('restablecido', 2, { end: true, subjects: ['luz'], places: ['Ventrosa'] }),
    notice('otra-averia', 1, { subjects: ['luz'], places: ['Ezcaray'] }),
  ], { now: NOW, maxAgeMs: 24 * HOUR, wholeNotice: true });
  assert.deepEqual(list.map(({ place }) => place), ['Ezcaray']);
});

test('en vigor: «rebaja los niveles de alerta» (sin riesgo) sustituye a la alerta roja anterior; «fin de la emergencia» lo cierra todo', () => {
  const avisos = [
    notice('naranja', 50, { places: ['Ibiza', 'Formentera'] }),
    notice('roja', 30, { places: ['Mallorca', 'Ibiza', 'Formentera'] }),
    notice('rebaja', 20, { subjects: ['*'], places: ['Mallorca', 'Ibiza', 'Formentera'] }),
  ];
  const now = currentNotices(avisos, { now: NOW, maxAgeMs: 96 * HOUR });
  assert.deepEqual(now.map(({ notice: n, place }) => `${n.id}@${place}`), ['rebaja@Mallorca', 'rebaja@Ibiza', 'rebaja@Formentera']);
  const after = currentNotices([...avisos, notice('fin', 10, { end: true, subjects: ['*'], places: ['Mallorca', 'Ibiza', 'Formentera'] })],
    { now: NOW, maxAgeMs: 96 * HOUR });
  assert.deepEqual(after, []);
});

test('planes: «Plan» a secas no es una emergencia, ni las ayudas o las jornadas sobre una', () => {
  assert.ok(!isPlanNotice('El Govern finaliza las excavaciones del V Plan de Fosas en Son Servera'));
  assert.ok(!isPlanNotice('CONSELL DE GOVERN: El Govern amplía las funciones de las comisiones del Plan de Igualdad'));
  assert.ok(!isPlanNotice('Presentación de las ayudas para dar respuesta a la situación de emergencia provocada por la DANA'));
  assert.ok(isPlanNotice('La presidenta Prohens anuncia la activación del Plan INUNBAL en fase de prealerta'));
  assert.ok(isPlanNotice('Emergencias eleva a roja la alerta por lluvias y tormentas en Mallorca, Ibiza y Formentera'));
  assert.equal(severityOf('Emergencias eleva a roja la alerta por lluvias'), 'muy alta');
  assert.equal(severityOf('Emergencias activa la alerta naranja por lluvias'), 'alta');
});

test('islas de Baleares: por su nombre, las Pitiusas y todo el archipiélago', () => {
  assert.deepEqual(illesIn('alerta roja en Ibiza y Formentera, naranja en Mallorca').sort(), ['Formentera', 'Ibiza', 'Mallorca']);
  assert.deepEqual(illesIn('la DANA en las Pitiusas').sort(), ['Formentera', 'Ibiza']);
  assert.deepEqual(illesIn('alerta en Eivissa'), ['Ibiza']);
  assert.deepEqual(illesIn('prealerta en todas las islas'), ['*']);
});
