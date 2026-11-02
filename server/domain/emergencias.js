// Avisos oficiales de emergencias (protección civil y 112 de las comunidades autónomas): si hablan
// de un corte de luz, qué nivel declaran, de qué riesgo y dónde, cuánto dura cada uno sin noticias de
// su fin y cuáles siguen en vigor. En castellano y en catalán (la sala de prensa del Govern balear y
// los planes de Cataluña se publican en catalán).
// Puro: los adaptadores leen cada formato (RSS, JSON…) y le pasan el texto tal cual.
import { GRUPOS_ISLAS, ILLES_BALEARS, ISLAS_CANARIAS, PROVINCIAS } from './lugares.js';

/** Minúsculas y sin tildes, para comparar textos de distintas fuentes. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const words = (list, flags = '') => new RegExp(`\\b(?:${list.join('|')})\\b`, flags);
/** Un nombre de lugar como palabra entera del texto plegado (se crea una vez por lugar, no en cada aviso). */
const nameRe = (name) => new RegExp(`\\b${fold(name)}\\b`);

// «Apagón ferroviario», «apagones informativos», «el apagón de las pulseras»… no son cortes de luz.
// Una sola lista para el corte de luz y para el riesgo «luz» de subjectsOf: si no, una de las dos
// se queda atrás. El \b final impide que «apagones ferroviarios» se cuele como «apagon» + «es…».
const NOT_POWER_BLACKOUTS = ['ferroviario', 'informativo', 'digital', 'analogico', 'televisivo', 'mediatico', 'tecnologico', 'inversor', 'de las pulseras'];
const BLACKOUT = `apagon(?:es)?(?! (?:${NOT_POWER_BLACKOUTS.join('|')}))\\b`;

// Corte del suministro eléctrico (castellano y catalán), sobre el texto plegado. Sólo frases que
// dicen que falta la luz: «garantizar la continuidad del suministro eléctrico» no es un corte. «Llum»
// a secas tampoco: «llum verda» es luz verde.
const POWER_CUT = [
  BLACKOUT,
  'cero energetico', 'zero energetic', 'apagada (?:general|electrica)',
  'sin (?:suministro electrico|suministro de luz|luz|electricidad|corriente electrica|fluido electrico)',
  '(?:corte|cortes|interrupcion|interrupciones|falta|perdida|caida|fallo|fallos|averia|averias|problemas|incidencias|incidencia) (?:general |generalizad[oa] )?(?:en el |del |de |de la |en la )?(?:suministro electrico|suministro de luz|suministro de electricidad|fluido electrico|luz|sistema electrico|red electrica)',
  'averia (?:que afecta|que ha afectado) (?:a|al) (?:el )?suministro electrico',
  'afecta(?:do|da|n)? (?:a|al) (?:el )?suministro electrico',
  'sense (?:llum|subministrament electric|electricitat)',
  '(?:tall|talls|manca|falta|interrupcio|interrupcions|fallada|caiguda) (?:de |del )?(?:llum|subministrament electric|corrent)',
];
const POWER_CUT_ANY = words(POWER_CUT, 'g');

// La luz vuelve: «restablecido el suministro eléctrico», «ya se ha recuperado la luz».
const POWER_BACK = words([
  'restablec\\w* (?:el |del |tanto el |tanto la |la )?(?:suministro electrico|suministro|luz|fluido electrico)',
  'recuperad[oa]s? (?:tanto )?(?:el |la )?(?:suministro electrico|luz)',
  'vuelve la luz', 'repuesto el suministro', 'reposicion (?:total |completa )?del suministro',
  'restablert (?:el )?subministrament', 'restabliment del subministrament', 'torna la llum', 'tornat la llum',
], 'g');

// Lo que, justo antes de la mención y en la misma frase, dice que no hay un corte ahora. La negación
// («No se han registrado cortes de luz», «sin que se hayan producido cortes», «No constan incidencias
// en el suministro»), que también vale para la luz que vuelve («aún no se ha restablecido»)…
const NEGATION = words(['no', 'ni', 'nunca', 'tampoco', 'sin que', 'ningun[oa]?s?', 'descart\\w*', 'cap', 'tampoc', 'sense que']);
// …y la prevención o un caso hipotético («Ante posibles cortes», «en caso de apagón», «durante un
// apagón»), la referencia a otro suceso («las causas del apagón», «explicaciones por el apagón»,
// «cuestiones como el apagón»), un simulacro o un vehículo («circulaba sin luz»).
const NOT_NOW = words([
  'ante (?:posibles?|eventuales?|el riesgo de|la posibilidad de|un)', 'en prevision de', 'por si', 'posibles?', 'eventuales?', 'riesgo de',
  'prevenir', 'evitar', 'en caso de', 'durante un', 'tras un', 'si (?:el|hay|se produce|se produjera)',
  'davant (?:possibles?|el risc de|una?)', 'en previsio de', 'possibles?', 'risc de', 'en cas de', 'durant una?',
  'explicaci\\w*', 'las causas (?:del|de)', '(?:cuestiones|asuntos|temas|problemas) como', 'investigaci\\w*', 'aniversario', 'comision', 'lecciones', 'recuerd\\w*', 'desde el', 'antes del',
  'simula\\w*', 'circula\\w*', 'conduc\\w*', 'vehiculo', 'bicicleta', 'motocicleta', 'patinete', 'ciclista',
]);
// Justo después: otro suceso con su fecha («el apagón del 28 de abril», «del pasado lunes», «del
// 28-A») o un solo edificio («en el edificio de la Policía Local»).
const MONTHS = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre'
  + '|gener|febrer|marc|maig|juny|juliol|agost|setembre|desembre';
const WEEKDAYS = 'dia|lunes|martes|miercoles|jueves|viernes|sabado|domingo';
const NOT_NOW_AFTER = new RegExp(`^\\s*(?:(?:del?|de la|d')\\s*(?:pasado|passat|ano pasado|(?:(?:${WEEKDAYS}) )?\\d{1,2}(?:-a\\b| de (?:${MONTHS})\\b| d'(?:${MONTHS})\\b)|(?:${MONTHS})\\b|\\d{4}\\b)`
  + '|[^.]{0,40}\\ben (?:el|un) (?:edificio|inmueble|local|vivienda|nave)\\b)');
// Un simulacro habla de cortes que no existen: si lo es, nada de lo que diga es un corte de luz.
const DRILL = words(['simulacro', 'simulacre', 'simulad[oa]s?', 'simulacion', 'simulacio']);

/** Frases y partes de frase de un texto: «Hay falta de suministro en A, mientras que en B ya se ha recuperado» son dos. */
const clausesOf = (text) => String(text ?? '').split(/(?<=[.!?])\s+|\n+/)
  .flatMap((sentence) => sentence.split(/[,;]\s+(?=mientras que|aunque|pero|y ya|ya se)|;\s+/));

/** Lo que va antes de `at` en la misma parte de la frase (desde la última coma o dos puntos), como mucho seis palabras. */
const wordsBefore = (t, at) => t.slice(0, at).split(/[,;:(]/).pop().trim().split(/\s+/).slice(-6).join(' ');

/** Alguna mención de `re` en esta parte de la frase que no niega ni anticipa ni cita otro suceso. */
function saysNow(clause, re, { negationOnly = false } = {}) {
  const t = fold(clause);
  for (const m of t.matchAll(re)) {
    const before = wordsBefore(t, m.index);
    if (NEGATION.test(before)) continue;
    if (negationOnly) return true;
    if (NOT_NOW.test(before) || NOT_NOW_AFTER.test(t.slice(m.index + m[0].length))) continue;
    return true;
  }
  return false;
}
const isCut = (clause) => saysNow(clause, POWER_CUT_ANY);
const isBack = (clause) => saysNow(clause, POWER_BACK, { negationOnly: true });

/** El texto dice que hay (o ha habido) un corte de luz: no si lo niega, lo prevé, es un simulacro o habla de otro suceso. */
export const mentionsPowerCut = (text) => !DRILL.test(fold(text)) && clausesOf(text).some(isCut);
/** El texto dice que la luz ha vuelto. */
export const mentionsPowerBack = (text) => clausesOf(text).some(isBack);

// Un aviso que da por terminada una situación (se mira sólo en el título).
const END = words([
  'finaliza', 'finalizad[oa]', 'da por finalizad[oa]', 'desactiva', 'desactivad[oa]', 'desactivacion',
  'restablecid[oa]', 'restablece', 'restablecen', 'repuesto', 'solucionad[oa]', 'vuelve la luz', 'fin de la',
  'desactivat', 'desactivad[ae]', 'finalitza', 'finalitzad[ae]', "fi(?:nal)? de (?:la |l')(?:emergencia|alerta|prealerta|situacio\\w*)",
]);
export const isEndNotice = (title) => END.test(fold(title));

// Activación o cambio de un plan de protección civil o de su nivel (prealerta, alerta, emergencia…).
// «Plan» a secas no vale: «el V Plan de Fosas» o un plan de igualdad no son emergencias.
const PLAN_WORD = words([
  // Planes de emergencias con nombre (siglas autonómicas y los que se citan por su riesgo).
  'plateca', 'platecam', 'meteocam', 'pricam', 'infocam', 'infoca', 'procicat', 'inuncat', 'neucat', 'ventcat', 'infocat',
  'platerbal', 'meteobal', 'inunbal', 'infobal', 'sismibal',
  'plan (?:territorial |especial )?de emergencias?', 'plan (?:de )?(?:infoca|sismico|inundaciones|emergencia por incendios)',
  'plan (?:territorial )?de proteccion civil', 'pla (?:territorial |especial )?de proteccio civil',
  // Niveles.
  'prealerta', 'alerta', 'alerta maxima', 'preemergencia', 'situacion (?:operativa )?[0-3]', 'fase de emergencia',
  'situacion de emergencia', 'nivell [0-3]', "situacio (?:operativa )?[0-3]", "situacio d'emergencia", "fase d'emergencia",
]);
const PLAN_ACTION = words([
  'activa', 'activad[oa]s?', 'activat', 'activacion', 'activacio', 'declara', 'declarad[oa]', 'declarar', 'declaracion', 'eleva',
  'elevad[oa]', 'sube', 'mantiene', 'mante', 'actualiza', 'actualitza', 'amplia', 'pasa', 'passa', 'pasando', 'desciende', 'baja',
  'baixa', 'rebaja', 'rebaixa', 'decreta', 'decretat',
]);
// Noticias que nombran un plan o un nivel sin declararlo.
const NOT_A_NOTICE = words([
  'simulacro', 'simulacre', 'ayudas?', 'ajud[ae]s?', 'ajuts?', 'subvencion(?:es)?', 'subvencions?', 'jornad[ae]s?', 'protocol', 'protocolo',
  'presentacion', 'presentacio', 'curso', 'curs', 'formacion', 'formacio', 'reunion', 'reunio',
]);

// De qué riesgo trata un aviso, para emparejar cada «declara» con su «finaliza» aunque los títulos
// no digan lo mismo («por lluvias» / «por lluvia»; «Plan Infoca» / «por el incendio de…»). En
// castellano y en catalán («pluges», «tempestes»…).
const HAZARDS = [
  [`cero energetico|zero energetic|${BLACKOUT}|apagada`, 'luz'],
  ['suministros? basicos?', 'suministros'],
  ['infoca|infobal|infocat|infocam|incendi|forestal', 'incendio'],
  ['inundaci|inunbal|inuncat|lluvia|pluj|pluge|precipitaci|dana|riada|avenida', 'lluvia'],
  ['sismic|sismo|terremoto|terratremol|sismibal', 'sismo'],
  ['nevada|nieve|helada|neu\\b|neucat|glacada', 'nieve'],
  ['tormenta|tempest', 'tormenta'],
  ['viento|vents?\\b|ventcat|temporal|borrasca', 'viento'],
  ['calima|polvo', 'calima'],
  ['temperatura|calor', 'calor'],
  ['oleaje|onatge|costero|maritim', 'costero'],
  ['contaminacio', 'contaminacion'],
  ['comunicaciones|telefonia', 'telecomunicaciones'],
  ['quimic|seveso|nuclear|radiolog', 'quimico'],
  ['multitudinari|romeria|romero|aldea', 'evento'],
  // No son de protección civil: una sequía, una alerta sanitaria o una alimentaria no son planes de
  // emergencia del mapa (isPlanNotice), y tener su propia clave impide que sustituyan o cierren otros.
  ['sequia|sequera', 'sequia'],
  ['sanitari|sarampion|xarampio|epidemi|pandemi|brote|salud publica|salut publica', 'sanitaria'],
  ['alimentari', 'alimentaria'],
].map(([re, key]) => [new RegExp(`\\b(?:${re})`), key]);
const NOT_CIVIL_PROTECTION = new Set(['sequia', 'sanitaria', 'alimentaria']);

/** El riesgo que aparece antes en el título (texto plegado), o null si no nombra ninguno. */
function firstHazard(t) {
  let first = null;
  for (const [re, key] of HAZARDS) {
    const at = t.search(re);
    if (at >= 0 && (!first || at < first.at)) first = { at, key };
  }
  return first?.key ?? null;
}

/** Nombra un plan de protección civil o un nivel (aunque no diga «activa»: «METEOCAM. Toledo»). */
export function mentionsPlan(title) {
  const t = fold(title);
  return PLAN_WORD.test(t) && !NOT_A_NOTICE.test(t) && !NOT_CIVIL_PROTECTION.has(firstHazard(t));
}
/** Declara, cambia o da por terminado un plan o un nivel de protección civil (no una sequía ni una alerta sanitaria). */
export function isPlanNotice(title) {
  const t = fold(title);
  return mentionsPlan(title) && (PLAN_ACTION.test(t) || END.test(t));
}

/**
 * Gravedad según el nivel que declara el aviso: prealerta → media, alerta → alta, alerta máxima o
 * emergencia → muy alta. null si no dice ninguno.
 * @returns {import('./model.js').Severity|null}
 */
export function severityOf(text) {
  // «Plan de Emergencia(s)», «Emergencias 112»… son nombres, no el nivel declarado.
  const t = fold(text).replace(/\bplan(?:es)? (?:territorial |especial )?de emergencias?\b/g, 'plan')
    .replace(/\bpla (?:territorial |especial )?d'emergencies\b/g, 'pla');
  // Niveles por color («eleva a roja la alerta», «alerta naranja»; «alerta vermella», «taronja», «groga»).
  if (/\balerta\b/.test(t) && /\b(?:roj[ao]s?|vermell[ae]s?)\b/.test(t)) return 'muy alta';
  if (/\balerta\b/.test(t) && /\b(?:naranjas?|taronj[ae]s?)\b/.test(t)) return 'alta';
  if (/\balerta\b/.test(t) && /\b(?:amarill[ao]s?|grog(?:a|ues)?|groc)\b/.test(t)) return 'media';
  if (/\b(?:alerta maxima|emergencia|situacion? (?:operativa )?[23]|nivell? [23])\b/.test(t)) return 'muy alta';
  if (/\b(?:alerta|preemergencia|situacion? (?:operativa )?1|nivell? 1)\b/.test(t)) return 'alta';
  if (/\b(?:prealerta|situacion? (?:operativa )?0|nivell? 0)\b/.test(t)) return 'media';
  return null;
}

/**
 * Claves de lo que trata el aviso: el riesgo que aparece antes en el título (o, si no dice ninguno,
 * el nombre del plan) y «luz» si habla de un corte de luz o de que ha vuelto. Si no dice ni riesgo
 * ni plan pero nombra un nivel de protección civil («Decretado el fin de la emergencia en Ibiza»,
 * «rebaja los niveles de alerta»), '*': un aviso así sustituye o cierra todo lo de sus lugares. Si no
 * nombra ni eso, 'sin-riesgo': sólo se empareja con otros avisos que tampoco lo digan, y no puede
 * cerrar las alertas de los demás.
 * Un título que sólo habla de la luz («Corte de luz en Toledo») trata de la luz, no de todo: con '*'
 * sustituiría a los planes en vigor de su lugar (ver currentNotices).
 */
export function subjectsOf(title, text = '') {
  const t = fold(title);
  const hazard = firstHazard(t);
  const out = hazard ? [hazard] : [];
  if (!out.length) {
    const plan = String(title).match(/\b([A-Z]{5,})\b/); // PLATECAM, METEOCAM…
    if (plan) out.push(plan[1].toLowerCase());
    else if (!mentionsPowerCut(title) && !mentionsPowerBack(title)) out.push(PLAN_WORD.test(t) || /\bemergencia\b/.test(t) ? '*' : 'sin-riesgo');
  }
  const all = `${title} ${text}`;
  if (mentionsPowerCut(all) || mentionsPowerBack(all)) out.push('luz');
  return [...new Set(out)];
}

const ISLAS_RE = ISLAS_CANARIAS.map((isla) => [isla.name, nameRe(isla.name)]);
const ILLES_RE = ILLES_BALEARS.map((illa) => [illa.name, nameRe(illa.name)]);
const PROVINCIAS_RE = PROVINCIAS.map((p) => [p, nameRe(p.name)]);

/** Islas que nombra un texto; ['*'] si habla de todo el archipiélago; [] si no nombra ninguna. */
export function islandsIn(text) {
  const t = fold(text);
  if (/\b(?:archipielago|todas las islas|toda canarias|todo canarias|comunidad autonoma de canarias)\b/.test(t)) return ['*'];
  const out = new Set();
  if (/\bislas occidentales\b/.test(t)) GRUPOS_ISLAS.occidentales.forEach((n) => out.add(n));
  if (/\bislas orientales\b/.test(t)) GRUPOS_ISLAS.orientales.forEach((n) => out.add(n));
  for (const [name, re] of ISLAS_RE) if (re.test(t)) out.add(name);
  // «La Palma» no cuenta como «Gran Canaria» ni al revés; «Canaria» suelta no es una isla.
  return [...out];
}

/** Islas de Baleares que nombra un texto (en castellano o en catalán); ['*'] si habla de todas; [] si no nombra ninguna. */
export function illesIn(text) {
  const t = fold(text);
  if (/\b(?:todas las islas|illes balears|islas baleares|baleares|totes les illes|el archipielago|l'arxipelag)\b/.test(t)) return ['*'];
  const out = new Set();
  if (/\b(?:pitiusas|pitiuses)\b/.test(t)) { out.add('Ibiza'); out.add('Formentera'); }
  if (/\beivissa\b/.test(t)) out.add('Ibiza');
  for (const [name, re] of ILLES_RE) if (re.test(t)) out.add(name);
  return [...out];
}

/**
 * Provincias (de la tabla de lugares) que nombra un texto; con `region` (clave de COMUNIDADES), sólo
 * las de esa comunidad: el 112 de Castilla-La Mancha no avisa de lo que pasa en Sevilla.
 */
export function provincesIn(text, region = null) {
  const t = fold(text);
  return PROVINCIAS_RE.filter(([p, re]) => (!region || p.region === region) && re.test(t)).map(([p]) => p.name);
}

// Nombres de lugar: palabras con mayúscula unidas por «de», «del», «la»… («San José del Valle»).
const CAP = "[A-ZÁÉÍÓÚÑÜ][a-záéíóúñüçàèìòù'·-]+";
const LINK = '(?:de|del|de la|de las|de los|la|las|los|el|d\'|de l\')';
const NAME = `${CAP}(?:\\s+(?:${LINK}\\s+)?${CAP})*`;
const LIST = new RegExp(`^(${NAME})((?:\\s*,\\s*${NAME})*)(?:\\s+(?:y|e|i)\\s+(${NAME}))?`);
const INTRO = /(?:^|[\s(])(?:en|afecta(?:n|do|da|ndo)? (?:a|al)|de los vecinos de|vecinos de|localidad de|municipio de|pueblo de|poblacion de|población de|pedania de|pedanía de|núcleo de|nucleo de|barriada de|zona de)\s+(?:la localidad de |el municipio de |los municipios de |las localidades de |la población de |la poblacion de )?/gi;
// Palabras con mayúscula que no son lugares (empiezan frase, organismos…).
const NOT_PLACES = new Set(['el', 'la', 'los', 'las', 'este', 'esta', 'endesa', 'iberdrola', 'ema', 'sos', 'junta', 'gobierno',
  'guardia civil', 'policia local', 'protección civil', 'proteccion civil', 'andalucia', 'españa', 'espana', 'canarias',
  'castilla y leon', 'castilla-la mancha', 'la rioja', 'cataluña', 'cataluna', 'centro coordinador', 'urgencias']);

/**
 * Lugares que cita un texto tras «en», «localidad de», etc. («Hay falta de suministro eléctrico en
 * Espera y San José del Valle» → Espera, San José del Valle). Son candidatos: el geocodificador
 * decide si existen.
 */
export function placeCandidates(text, max = 6) {
  const out = [];
  const s = String(text ?? '');
  for (const m of s.matchAll(INTRO)) {
    const rest = s.slice(m.index + m[0].length);
    const list = rest.match(LIST);
    if (!list) continue;
    const names = [list[1], ...(list[2] ? list[2].split(',').map((x) => x.trim()).filter(Boolean) : []), list[3]].filter(Boolean);
    for (const n of names) {
      const name = n.trim();
      if (!NOT_PLACES.has(fold(name)) && !out.includes(name)) out.push(name);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Frases del texto que hablan del corte de luz y las que dicen que ha vuelto, por separado. Las que
 * lo niegan, lo prevén o hablan de otro suceso no cuentan; en un simulacro, ninguna.
 */
export function powerClauses(text) {
  const cut = [];
  const back = [];
  if (DRILL.test(fold(text))) return { cut, back };
  for (const clause of clausesOf(text)) {
    if (isBack(clause)) back.push(clause.trim());
    else if (isCut(clause)) cut.push(clause.trim());
  }
  return { cut, back };
}

/**
 * @typedef {object} Notice  Un aviso oficial ya leído por su adaptador.
 * @property {string} id
 * @property {number} at          Epoch ms de publicación.
 * @property {boolean} end        Da por terminada la situación («finaliza», «restablecido»…).
 * @property {string[]} subjects  De qué trata (ver subjectsOf). La primera es la principal.
 * @property {string[]} places    Dónde (islas, municipios…); vacío o ['*'] = todo su territorio.
 * @property {boolean} [power]    Habla de un corte de luz.
 * @property {string} [title]     Título tal cual lo publica la fuente.
 */

// Cuánto se muestra un aviso sin noticias de su fin: los avisos no siempre lo publican. Un plan de
// protección civil suele durar días; un corte de luz del 112, horas.
const HOUR = 3_600_000;
export const PLAN_MAX_AGE = 96 * HOUR; // un plan sin noticias de su fin se deja de mostrar a los 4 días
export const CUT_MAX_AGE = 24 * HOUR;  // un corte de luz sin noticia de que ha vuelto, al día
/** Lo más que puede seguir en vigor un aviso: lo que haya que guardar para no perder ninguno. */
export const NOTICE_MAX_AGE = Math.max(PLAN_MAX_AGE, CUT_MAX_AGE);

/**
 * Vigencia de un aviso sin noticias de su fin: un corte de luz, un día; un plan (aunque sea por un
 * apagón, como el PLATECA por el cero energético de La Palma), cuatro. La misma en todas las fuentes.
 * @param {Notice} n
 */
export const maxAgeOf = (n) => (n.power && !isPlanNotice(n.title) ? CUT_MAX_AGE : PLAN_MAX_AGE);

/** El aviso ya no está en vigor por viejo, según la vigencia `maxAgeFor` (por omisión, la del dominio). */
export const isExpired = (n, now, maxAgeFor = maxAgeOf) => !(now - n.at <= maxAgeFor(n));

/**
 * Hasta cuándo sigue en vigor un aviso sin noticias de su fin (epoch ms). Va en el suceso del mapa
 * (`expires`) para que deje de mostrarse a su hora aunque su fuente deje de responder: si no, el
 * último corte de luz que leyó se quedaría en el mapa mientras la fuente siga caída.
 */
export const expiresAt = (n, maxAgeFor = maxAgeOf) => n.at + maxAgeFor(n);

/**
 * Avisos que siguen en vigor, uno por lugar: del más nuevo al más viejo, el primero de cada riesgo y
 * lugar es su estado actual. Un «finaliza» cierra lo que trata en sus lugares (o en todo el
 * territorio si no dice ninguno) y los avisos anteriores de eso ya no cuentan. Los que pasan de su
 * vigencia (`maxAgeFor`, por omisión maxAgeOf) sin actualizarse se descartan antes de nada: un aviso
 * caducado no puede ocupar el sitio de otro más viejo que sigue en vigor (un corte de luz de hace
 * 30 h no tapa la alerta de hace 40 h de la misma provincia). Los fines no caducan: sólo cierran
 * avisos anteriores a ellos, que, si el fin es viejo, también lo son.
 * Con `wholeNotice` (incidencias del 112, que son un solo suceso), si se cierra uno de sus lugares
 * se cierra el aviso entero: «restablecido en Ventrosa» también vale para los otros pueblos de la avería.
 * @template {Notice} T
 * @param {T[]} notices
 * @param {{ now: number, maxAgeFor?: (n: T) => number, wholeNotice?: boolean }} opts
 * @returns {Array<{ notice: T, place: string|null }>}
 */
export function currentNotices(notices, { now, maxAgeFor = maxAgeOf, wholeNotice = false }) {
  const closed = new Set();
  const seen = new Set();
  const out = [];
  for (const n of [...notices].sort((a, b) => b.at - a.at)) {
    const places = n.places.length ? n.places : ['*'];
    if (n.end) {
      for (const s of n.subjects) for (const p of places) closed.add(`${s}|${p}`);
      continue;
    }
    if (isExpired(n, now, maxAgeFor)) continue; // antes de marcarlo como visto
    const isShut = (p) => closed.has(`*|${p}`) || closed.has('*|*')
      || n.subjects.some((s) => closed.has(`${s}|${p}`) || closed.has(`${s}|*`));
    if (wholeNotice && places.some(isShut)) continue;
    for (const p of places) {
      const shut = isShut(p);
      const key = `${n.subjects[0]}|${p}`;
      // Un aviso general sobre los niveles de un lugar («rebaja los niveles de alerta», clave '*')
      // sustituye a todos los anteriores de ese lugar.
      if (shut || seen.has(key) || seen.has(`*|${p}`)) continue;
      seen.add(key);
      out.push({ notice: n, place: p === '*' ? null : p });
    }
  }
  return out;
}
