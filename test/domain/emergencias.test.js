// Avisos oficiales (protección civil y 112): qué es un corte de luz, qué nivel declaran, de qué
// riesgo tratan, dónde y cuáles siguen en vigor. Con frases reales de cada fuente; sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CUT_MAX_AGE, PLAN_MAX_AGE, currentNotices, expiresAt, illesIn, withCurrentCuts, islandsIn, isEndNotice, isPlanNotice, maxAgeOf, mentionsPlan, mentionsPowerBack,
  mentionsPowerCut, placeCandidates, powerClauses, provincesIn, severityOf, subjectsOf,
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

test('apagones que no son eléctricos, en singular y en plural: ni corte de luz ni riesgo «luz»', () => {
  for (const t of [
    'Apagón ferroviario en Andalucía', 'Apagones ferroviarios en Cercanías', 'Apagón tecnológico en los bancos', 'Apagones tecnológicos',
    'Apagón informativo sobre la DANA', 'Apagones informativos', 'Apagón digital', 'Apagón analógico', 'Apagón televisivo',
    'Apagón mediático', 'El apagón de las pulseras antimaltrato',
  ]) {
    assert.ok(!mentionsPowerCut(t), t);
    assert.ok(!subjectsOf(t).includes('luz'), `${t} → ${subjectsOf(t)}`);
  }
  for (const t of ['Apagón en La Palma', 'Apagones en Tenerife tras la tormenta', 'Apagón general en toda Andalucía']) {
    assert.ok(mentionsPowerCut(t), t);
    assert.ok(subjectsOf(t).includes('luz'), t);
  }
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

test('de qué trata: un título que sólo habla de la luz trata de la luz, no de todo lo de su lugar', () => {
  assert.deepEqual(subjectsOf('Corte de luz en Toledo'), ['luz']);
  assert.deepEqual(subjectsOf('Restablecido el suministro eléctrico en La Palma'), ['luz']);
  assert.deepEqual(subjectsOf('Decretado el fin de la emergencia en Ibiza'), ['*'], 'sin riesgo, plan ni luz: todo');
  assert.deepEqual(subjectsOf('Finaliza la situación de alerta en La Palma', 'ya se ha restablecido el suministro eléctrico'), ['*', 'luz'],
    'el título no dice de qué: sigue cerrando todo lo de La Palma');
});

test('islas y provincias que nombra un aviso', () => {
  assert.deepEqual(islandsIn('Isla de La Palma'), ['La Palma']);
  assert.deepEqual(islandsIn('prealerta por tormentas en las islas occidentales y Gran Canaria').sort(),
    ['El Hierro', 'Gran Canaria', 'La Gomera', 'La Palma', 'Tenerife']);
  assert.deepEqual(islandsIn('prealerta por calima en todo el Archipiélago'), ['*']);
  assert.deepEqual(islandsIn('El Gobierno de Canarias finaliza la prealerta'), []);
  assert.deepEqual(provincesIn('METEOCAM. Albacete, Ciudad Real, Cuenca y Toledo'), ['Albacete', 'Ciudad Real', 'Cuenca', 'Toledo']);
  assert.deepEqual(provincesIn('METEOCAM. Toledo, como Sevilla y Burgos', 'castilla-la-mancha'), ['Toledo'], 'sólo las de su comunidad');
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

const notice = (id, hoursAgo, { end = false, subjects = ['lluvia'], places = [], ...rest } = {}) => ({ id, at: NOW - hoursAgo * HOUR, end, subjects, places, ...rest });

test('en vigor: el aviso más nuevo de cada riesgo y lugar; un «finaliza» cierra los anteriores', () => {
  const list = currentNotices([
    notice('prealerta-todas', 30, { places: [] }),
    notice('alerta-maxima-lp', 9, { places: ['La Palma'] }),
    notice('alerta-lp-lg', 3, { places: ['La Palma', 'La Gomera'] }),
    notice('fin-lg', 1, { end: true, places: ['La Gomera'] }),
    notice('cero-lp', 4, { subjects: ['luz'], places: ['La Palma'] }),
  ], { now: NOW });
  const got = list.map(({ notice: n, place }) => `${n.id}@${place ?? 'todo'}`).sort();
  assert.deepEqual(got, ['alerta-lp-lg@La Palma', 'cero-lp@La Palma', 'prealerta-todas@todo']);
});

test('en vigor: un aviso nuevo de todo el territorio sustituye a los anteriores de su riesgo en cada isla (Canarias, 31-10 a 3-11)', () => {
  // El 3-11 el Gobierno de Canarias pasó a prealerta en todo el archipiélago; el mapa seguía con la
  // alerta por lluvias del 2-11 en tres islas y la del 31-10 en Tenerife, más graves que la situación real.
  const list = currentNotices([
    notice('prealerta-tormentas-occidentales', 59, { subjects: ['tormenta'], places: ['El Hierro', 'La Palma', 'La Gomera', 'Tenerife', 'Gran Canaria'] }),
    notice('alerta-lluvias-lp-tf', 52, { places: ['La Palma', 'Tenerife'] }),
    notice('alerta-lluvias-lp-lg-eh', 15, { places: ['El Hierro', 'La Palma', 'La Gomera'] }),
    notice('cero-energetico-lp', 14, { subjects: ['luz'], places: ['La Palma'] }),
    notice('prealerta-tormentas-todo', 3, { subjects: ['tormenta'], places: ['*'] }),
    notice('prealerta-lluvias-toda-canarias', 2, { places: ['*'] }),
  ], { now: NOW });
  const got = list.map(({ notice: n, place }) => `${n.id}@${place ?? 'todo'}`).sort();
  // El corte de luz es otro riesgo: sigue hasta su fin o su vigencia.
  assert.deepEqual(got, ['cero-energetico-lp@La Palma', 'prealerta-lluvias-toda-canarias@todo', 'prealerta-tormentas-todo@todo']);
});

test('en vigor: un aviso sin lugar (no se ha podido situar) no tapa los anteriores de cada pueblo', () => {
  const list = currentNotices([
    notice('corte-espera', 5, { subjects: ['luz'], places: ['Espera'] }),
    notice('corte-sin-situar', 1, { subjects: ['luz'], places: [] }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['corte-sin-situar', 'corte-espera']);
});

test('en vigor: un fin sin lugares cierra el riesgo en todo el territorio; lo viejo caduca', () => {
  const list = currentNotices([
    notice('alerta-hierro', 10, { places: ['El Hierro'] }),
    notice('fin-todo', 2, { end: true }),
    notice('calima-vieja', 120, { subjects: ['calima'] }),
    notice('luz-nueva', 1, { subjects: ['luz'], places: ['Ventrosa'] }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['luz-nueva']);
});

test('en vigor: si la luz vuelve en un pueblo, el corte sigue en los demás', () => {
  const list = currentNotices([
    notice('corte', 5, { subjects: ['luz'], places: ['Espera', 'Puerto Serrano'] }),
    notice('vuelve', 2, { end: true, subjects: ['luz'], places: ['Puerto Serrano'] }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ place }) => place), ['Espera']);
});

test('en vigor: en una incidencia del 112 (un solo suceso), la vuelta de la luz en un pueblo cierra la avería entera', () => {
  const list = currentNotices([
    notice('averia', 5, { subjects: ['luz'], places: ['Ventrosa', 'Brieva'] }),
    notice('restablecido', 2, { end: true, subjects: ['luz'], places: ['Ventrosa'] }),
    notice('otra-averia', 1, { subjects: ['luz'], places: ['Ezcaray'] }),
  ], { now: NOW, wholeNotice: true });
  assert.deepEqual(list.map(({ place }) => place), ['Ezcaray']);
});

test('en vigor: «rebaja los niveles de alerta» (sin riesgo) sustituye a la alerta roja anterior; «fin de la emergencia» lo cierra todo', () => {
  const avisos = [
    notice('naranja', 50, { places: ['Ibiza', 'Formentera'] }),
    notice('roja', 30, { places: ['Mallorca', 'Ibiza', 'Formentera'] }),
    notice('rebaja', 20, { subjects: ['*'], places: ['Mallorca', 'Ibiza', 'Formentera'] }),
  ];
  const now = currentNotices(avisos, { now: NOW });
  assert.deepEqual(now.map(({ notice: n, place }) => `${n.id}@${place}`), ['rebaja@Mallorca', 'rebaja@Ibiza', 'rebaja@Formentera']);
  const after = currentNotices([...avisos, notice('fin', 10, { end: true, subjects: ['*'], places: ['Mallorca', 'Ibiza', 'Formentera'] })],
    { now: NOW });
  assert.deepEqual(after, []);
});

test('vigencia: un corte de luz dura un día sin noticias de su fin; un plan, aunque sea por un apagón, cuatro', () => {
  assert.equal(CUT_MAX_AGE, 24 * HOUR);
  assert.equal(PLAN_MAX_AGE, 96 * HOUR);
  assert.equal(maxAgeOf({ power: true, title: 'Corte de luz en Toledo' }), CUT_MAX_AGE);
  assert.equal(maxAgeOf({ power: true, title: 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma' }),
    PLAN_MAX_AGE);
  assert.equal(maxAgeOf({ power: false, title: 'METEOCAM. Activada la alerta en la provincia de Toledo' }), PLAN_MAX_AGE);
  const list = currentNotices([
    notice('corte-23h', 23, { subjects: ['luz'], places: ['Espera'], power: true, title: 'Corte de luz en Espera' }),
    notice('corte-25h', 25, { subjects: ['luz'], places: ['Ubrique'], power: true, title: 'Corte de luz en Ubrique' }),
    notice('plan-90h', 90, { places: ['Cádiz'], title: 'Activado el Plan de Emergencias por lluvias en Cádiz' }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['corte-23h', 'plan-90h']);
});

test('vigencia: un aviso caducado no tapa a otro más viejo que sigue en vigor (Castilla-La Mancha)', () => {
  // Un «Corte de luz en Toledo» de hace 30 h ya caducó; la alerta del METEOCAM de hace 40 h sigue en vigor.
  // Si el corte se marcaba como visto antes de mirar su vigencia, ocupaba el sitio de la alerta y,
  // al quitarlo después por viejo, el mapa se quedaba sin nada en Toledo.
  const cut = 'Corte de luz en Toledo';
  const plan = 'METEOCAM. Activada la alerta en la provincia de Toledo';
  const list = currentNotices([
    notice('corte', 30, { subjects: subjectsOf(cut), places: ['Toledo'], power: true, title: cut }),
    notice('meteocam', 40, { subjects: subjectsOf(plan), places: ['Toledo'], power: false, title: plan }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n, place }) => `${n.id}@${place}`), ['meteocam@Toledo']);
});

test('vigencia: un corte de luz en vigor no sustituye a los planes de su lugar', () => {
  const cut = 'Corte de luz en Toledo';
  const plan = 'METEOCAM. Activada la alerta en la provincia de Toledo';
  const list = currentNotices([
    notice('corte', 5, { subjects: subjectsOf(cut), places: ['Toledo'], power: true, title: cut }),
    notice('meteocam', 40, { subjects: subjectsOf(plan), places: ['Toledo'], power: false, title: plan }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['corte', 'meteocam']);
});

test('vigencia: un fin cierra lo anterior aunque él ya sea viejo; la vigencia se puede pasar a mano', () => {
  const list = currentNotices([
    notice('alerta', 60, { places: ['La Palma'] }),
    notice('fin', 50, { end: true, places: ['La Palma'] }),
  ], { now: NOW });
  assert.deepEqual(list, [], 'el fin de hace 50 h cierra la alerta de hace 60 h, que seguiría en vigor');
  const short = currentNotices([notice('alerta', 3, { places: ['La Palma'] })], { now: NOW, maxAgeFor: () => 2 * HOUR });
  assert.deepEqual(short, []);
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

// ---------- Casos reales que no son un corte de luz ahora (radar-d1 y noticias de la Junta) ----------

test('no es un corte de luz: negación, prevención, simulacro, otro suceso con su fecha o un vehículo', () => {
  for (const t of [
    'No se han registrado cortes de luz en la provincia de Málaga.',
    'Ante posibles cortes de suministro eléctrico, la población debe tener linternas.',
    'Simulacro de apagón en Menorca',
    'No constan incidencias en el suministro eléctrico',
    'El temporal ha pasado sin que se hayan producido cortes de luz',
    'Moreno pide explicaciones por el apagón del 28 de abril',
    'Insta al Gobierno de España a dar explicaciones a los ciudadanos ante cuestiones como el apagón o el caos ferroviario.',
    'ha reclamado conocer las causas del apagón',
    'el apagón del pasado 28 de abril',
    'El conductor circulaba sin luz por la A-4',
    'El 1-1-2 recomienda qué hacer en caso de apagón eléctrico',
    'un frigorífico conserva los alimentos hasta cuatro horas durante un apagón',
    'interrupción del suministro eléctrico y de internet en el edificio de la Policía Local',
    'No hi ha talls de llum a Menorca',
  ]) {
    assert.ok(!mentionsPowerCut(t), t);
    assert.deepEqual(powerClauses(t).cut, [], t);
  }
  assert.ok(mentionsPowerCut('Se ha producido un corte de luz en Ronda.'));
  assert.ok(mentionsPowerCut('El incendio no ha causado heridos, ha dejado sin luz a 300 vecinos de Ronda'), 'la negación de otra parte de la frase no cuenta');
  assert.ok(mentionsPowerCut('La avería, que no se ha localizado aún, deja sin suministro eléctrico a Ventrosa'));
});

test('un simulacro no da cortes aunque el corte esté en el texto y el simulacro en el título (EMA, 25-3)', () => {
  const full = 'La EMA realiza un simulacro de incendio forestal en Sierra Morena. '
    + 'Durante el ejercicio se ha simulado el corte de la JA-6100 y del suministro eléctrico en la zona.';
  assert.deepEqual(powerClauses(full), { cut: [], back: [] });
});

test('Andalucía: las frases reales de la Junta que sí son un corte de luz o su vuelta', () => {
  for (const t of [
    'En Benamahoma el ayuntamiento informó que toda la población estaba anoche sin suministro eléctrico ni cobertura',
    'Hay falta de suministro eléctrico en Espera y San José del Valle',
    'Según el último balance, hay 195 personas sin suministro eléctrico en Jimena de la Frontera',
    'se ha detectado falta de suministro eléctrico, telefonía e internet en la población de Trebujena',
  ]) assert.equal(powerClauses(t).cut.length, 1, t);
  assert.deepEqual(powerClauses('en San Martín del Tesorillo se ha restablecido el suministro eléctrico').back.length, 1);
  assert.ok(!mentionsPowerBack('Todavía no se ha restablecido el suministro eléctrico en Ventrosa'), 'que no ha vuelto no es que ha vuelto');
});

test('sequía, alerta sanitaria o alimentaria: no son planes de protección civil, con su propia clave', () => {
  for (const t of [
    'El Govern declara la situación de emergencia por sequía en Ibiza y Formentera',
    'Salut declara la alerta sanitaria por sarampión en Ibiza',
    'Consumo activa la alerta alimentaria por listeria',
    "El Govern declara la situació d'emergència per sequera a Eivissa i Formentera",
    "Salut declara l'alerta sanitària per xarampió a Eivissa",
  ]) assert.ok(!isPlanNotice(t), t);
  assert.deepEqual(subjectsOf('Salut da por finalizada la alerta por sarampión'), ['sanitaria'], 'no cierra lo de todas las islas');
  assert.deepEqual(subjectsOf('Activada la alerta por riesgo de incendios por la sequía'), ['incendio'], 'el riesgo que se nombra antes manda');
});

test('«*» sólo si el aviso nombra un nivel o un plan; si no, no sustituye ni cierra lo de los demás', () => {
  assert.deepEqual(subjectsOf('Emergencias rebaja los niveles de alerta y confirma la vuelta a las clases en Mallorca'), ['*']);
  assert.deepEqual(subjectsOf("Decretat el final de l'emergència a Eivissa, Formentera i Mallorca"), ['*']);
  assert.deepEqual(subjectsOf('Finaliza el dispositivo especial en Ibiza'), ['sin-riesgo']);
  const list = currentNotices([
    notice('roja', 10, { places: ['Ibiza'] }),
    notice('otra-cosa', 5, { subjects: ['sin-riesgo'], places: ['Ibiza'] }),
    notice('fin-otra-cosa', 2, { end: true, subjects: ['sin-riesgo'], places: [] }),
  ], { now: NOW });
  assert.deepEqual(list.map(({ notice: n }) => n.id), ['roja'], 'la alerta por lluvias sigue');
});

// ---------- Catalán (sala de prensa del Govern balear, títulos reales de octubre de 2026) ----------

test('Baleares en catalán: alertas por color, su fin y sus islas', () => {
  const taronja = "Emergències activa l'alerta taronja per pluges i tempestes a Eivissa i Formentera i demana precaució a la població";
  assert.ok(isPlanNotice(taronja));
  assert.equal(severityOf(taronja), 'alta');
  assert.deepEqual(subjectsOf(taronja), ['lluvia']);
  assert.deepEqual(illesIn(taronja).sort(), ['Formentera', 'Ibiza']);
  const vermella = "Emergències eleva a vermella l'alerta per pluges i tempestes a Mallorca, Eivissa i Formentera i suspèn les classes demà a les tres illes";
  assert.ok(isPlanNotice(vermella));
  assert.equal(severityOf(vermella), 'muy alta');
  assert.equal(severityOf("Emergències manté l'alerta vermella de Protecció Civil per pluges i tempestes a Eivissa, Formentera i Mallorca"), 'muy alta');
  const rebaixa = "Emergències rebaixa els nivells d'alerta i confirma el retorn a les classes a partir de demà a Mallorca, Eivissa i Formentera";
  assert.ok(isPlanNotice(rebaixa));
  assert.equal(severityOf(rebaixa), 'alta');
  assert.ok(isEndNotice("Decretat el final de l'emergència a Eivissa, Formentera i Mallorca"));
  const inunbal = "La presidenta Prohens anuncia l'activació del Pla INUNBAL en fase de prealerta davant el risc de danes";
  assert.ok(isPlanNotice(inunbal));
  assert.equal(severityOf(inunbal), 'media');
  assert.equal(severityOf("activa el Pla INUNBAL en situació operativa 2"), 'muy alta');
});

test('Baleares en catalán: lo que no es un aviso ni un corte de luz', () => {
  for (const t of [
    "Reunió del CECOPI del Pla Meteobal i del Pla Inunbal des d'Eivissa",
    "El Govern aprova el primer protocol d'emergències meteorològiques per a l'àmbit esportiu de les Illes Balears",
    'El Govern eleva el Protocol ECLIPBAL a nivell 2 per reforçar la coordinació del dispositiu',
    "El Govern alerta de la consolidació de la nova ruta migratòria cap a les Illes Balears",
    "El Govern autoritza el teletreball per als empleats públics de la CAIB davant l'alerta vermella meteorològica d'aquest dilluns",
    "El Govern eleva la cobertura de la xarxa de comunicacions d'emergències d'Eivissa fins al 87,2%",
    'El Govern finalitza les excavacions del V Pla de Fosses a Son Servera',
    "Presentació de les ajudes per donar resposta a la situació d'emergència provocada pels terratrèmols de Veneçuela",
  ]) assert.ok(!isPlanNotice(t), t);
  for (const t of [
    'CONSELL DE GOVERN: Llum verda a un nou tram de doble via entre Petra i Manacor',
    "El Govern autoritza la fi de la generació elèctrica amb carbó a Mallorca",
    "Comencen les obres del sistema de subministrament elèctric a vaixells al port exterior de Ciutadella",
  ]) assert.ok(!mentionsPowerCut(t), t);
  assert.ok(mentionsPowerCut('Talls de llum a Menorca pel temporal'));
  assert.ok(mentionsPowerBack('Ja ha tornat la llum a Ciutadella'));
});

test('vigencia en el suceso: lo que dura sin noticias de su fin, desde que se publicó', () => {
  const at = NOW - 3 * HOUR;
  assert.equal(expiresAt({ at, power: true, title: 'Corte de luz en Toledo' }), at + CUT_MAX_AGE);
  assert.equal(expiresAt({ at, power: false, title: 'METEOCAM. Activada la alerta en Toledo' }), at + PLAN_MAX_AGE);
});

// ---------- Cortes de luz que ya no lo son ----------
const TH = { isolatedGridDrop: 0.5, isolatedGridStaleMinutes: 60 };
const PLATECA = 'El Gobierno de Canarias activa el PLATECA en situación de alerta por cero energético en La Palma';
const cutEvent = (area, hoursAgo, title = PLATECA) => ({
  id: `emergencias-canarias:899:${area}`, category: 'emergencia', type: 'apagon', power: true, severity: 'alta', title, area, issued: NOW - hoursAgo * HOUR,
});
// Dos datos seguidos de un sistema, `minutesAgo` el último.
const grid = (id, real, programmed, minutesAgo = 10) => ({
  id, real, programmed, recentMax: real, readMax: real, at: NOW - minutesAgo * 60_000, previous: { real, at: NOW - (minutesAgo + 5) * 60_000 },
});

test('un plan por un apagón deja de ser «corte de luz» al día aunque siga en vigor; uno que sólo era corte ya caducó', () => {
  const [plan] = withCurrentCuts([cutEvent('La Palma', 25)], { now: NOW, thresholds: TH });
  assert.equal(plan.power, false);
  assert.equal(plan.type, 'plan');
  assert.equal(plan.title, PLATECA, 'el aviso tal cual');
  assert.deepEqual(withCurrentCuts([cutEvent('La Palma', 23)], { now: NOW, thresholds: TH }).map((e) => e.type), ['apagon']);
});

test('en una isla, la demanda normal de su sistema (dos datos posteriores al aviso) dice que la luz ha vuelto', () => {
  const events = [cutEvent('La Palma', 3), cutEvent('Mallorca', 3, 'Corte de luz en Mallorca'), cutEvent('Lanzarote', 3, 'Corte de luz en Lanzarote')];
  const out = withCurrentCuts(events, { now: NOW, grid: [grid('la-palma', 30.6, 28.1), grid('lanzarote-fuerteventura', 0, 160)], thresholds: TH });
  assert.deepEqual(out.map((e) => `${e.area}:${e.type}`), ['La Palma:plan', 'Mallorca:apagon', 'Lanzarote:apagon'],
    'La Palma tiene luz; Baleares no tiene demanda en tiempo real; Lanzarote sigue a cero');
  const onlyCut = withCurrentCuts([cutEvent('La Palma', 3, 'Corte de luz en La Palma')], { now: NOW, grid: [grid('la-palma', 30.6, 28.1)], thresholds: TH });
  assert.deepEqual(onlyCut, [], 'un aviso que sólo hablaba del corte deja de mostrarse');
  const fuerteventura = withCurrentCuts([cutEvent('Fuerteventura', 3, 'Corte de luz en Fuerteventura')], { now: NOW, grid: [grid('lanzarote-fuerteventura', 160, 158)], thresholds: TH });
  assert.deepEqual(fuerteventura, [], 'Lanzarote y Fuerteventura son un solo sistema');
});

test('la demanda no cuenta si es anterior al aviso, vieja o de un solo dato', () => {
  const fresh = cutEvent('La Palma', 0.1); // publicado hace 6 min: los datos de hace 10 y 15 son de antes
  assert.equal(withCurrentCuts([fresh], { now: NOW, grid: [grid('la-palma', 30.6, 28.1)], thresholds: TH })[0].type, 'apagon');
  const old = withCurrentCuts([cutEvent('La Palma', 3)], { now: NOW, grid: [grid('la-palma', 30.6, 28.1, 90)], thresholds: TH });
  assert.equal(old[0].type, 'apagon', 'dato de hace hora y media');
  const single = withCurrentCuts([cutEvent('La Palma', 3)], { now: NOW, grid: [{ ...grid('la-palma', 30.6, 28.1), previous: null }], thresholds: TH });
  assert.equal(single[0].type, 'apagon');
  const half = withCurrentCuts([cutEvent('La Palma', 3)], { now: NOW, grid: [grid('la-palma', 7, 28.1)], thresholds: TH });
  assert.equal(half[0].type, 'apagon', 'con la cuarta parte de lo esperado sigue sin luz');
  // Justo después del apagón: REE programa 9 MW y en dos horas no ha pasado de 7, pero antes consumía 20,7.
  const sunk = { ...grid('la-palma', 6.8, 9), recentMax: 7, readMax: 20.7 };
  assert.equal(withCurrentCuts([cutEvent('La Palma', 3)], { now: NOW, grid: [sunk], thresholds: TH })[0].type, 'apagon',
    '6,8 MW frente a la programada hundida parece normal; frente a lo que consumía, es un tercio');
});
