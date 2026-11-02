// Avisos oficiales de emergencias (protección civil y 112 de las comunidades autónomas): si hablan
// de un corte de luz, qué nivel declaran, de qué riesgo y dónde, y cuáles siguen en vigor.
// Puro: los adaptadores leen cada formato (RSS, JSON…) y le pasan el texto tal cual.
import { GRUPOS_ISLAS, ISLAS_CANARIAS, PROVINCIAS } from './lugares.js';

/** Minúsculas y sin tildes, para comparar textos de distintas fuentes. */
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const words = (list) => new RegExp(`\\b(?:${list.join('|')})\\b`);

// Corte del suministro eléctrico (castellano y catalán), sobre el texto plegado. Sólo frases que
// dicen que falta la luz: «garantizar la continuidad del suministro eléctrico» no es un corte.
const POWER_CUT = words([
  // «Apagón ferroviario», «apagón informativo»… no son cortes de luz.
  'apagon(?:es)?(?! (?:ferroviario|informativo|digital|analogico|televisivo|mediatico|tecnologico|de las pulseras))',
  'cero energetico', 'zero energetic', 'apagada (?:general|electrica)',
  'sin (?:suministro electrico|suministro de luz|luz|electricidad|corriente electrica|fluido electrico)',
  '(?:corte|cortes|interrupcion|interrupciones|falta|perdida|caida|fallo|fallos|averia|averias|problemas|incidencias|incidencia) (?:general |generalizad[oa] )?(?:en el |del |de |de la |en la )?(?:suministro electrico|suministro de luz|suministro de electricidad|fluido electrico|luz|sistema electrico|red electrica)',
  'averia (?:que afecta|que ha afectado) (?:a|al) (?:el )?suministro electrico',
  'afecta(?:do|da|n)? (?:a|al) (?:el )?suministro electrico',
  'sense (?:llum|subministrament electric|electricitat)',
  '(?:tall|talls|manca|interrupcio|interrupcions) (?:de |del )?(?:llum|subministrament electric|corrent)',
]);

// La luz vuelve: «restablecido el suministro eléctrico», «ya se ha recuperado la luz».
const POWER_BACK = words([
  'restablec\\w* (?:el |del |tanto el |tanto la |la )?(?:suministro electrico|suministro|luz|fluido electrico)',
  'recuperad[oa]s? (?:tanto )?(?:el |la )?(?:suministro electrico|luz)',
  'vuelve la luz', 'repuesto el suministro', 'reposicion (?:total |completa )?del suministro',
  'restablert (?:el )?subministrament', 'restabliment del subministrament',
]);

/** El texto dice que hay (o ha habido) un corte de luz. */
export const mentionsPowerCut = (text) => POWER_CUT.test(fold(text));
/** El texto dice que la luz ha vuelto. */
export const mentionsPowerBack = (text) => POWER_BACK.test(fold(text));

// Un aviso que da por terminada una situación (se mira sólo en el título).
const END = words([
  'finaliza', 'finalizad[oa]', 'da por finalizad[oa]', 'desactiva', 'desactivad[oa]', 'desactivacion',
  'restablecid[oa]', 'restablece', 'restablecen', 'repuesto', 'solucionad[oa]', 'vuelve la luz', 'fin de la',
  'desactivat', 'finalitza',
]);
export const isEndNotice = (title) => END.test(fold(title));

// Activación o cambio de un plan de protección civil o de su nivel (prealerta, alerta, emergencia…).
const PLAN_WORD = words([
  'plan', 'plateca', 'platecam', 'meteocam', 'pricam', 'infocam', 'infoca', 'procicat', 'prealerta', 'alerta',
  'alerta maxima', 'preemergencia', 'situacion (?:operativa )?[0-3]', 'fase de emergencia', 'situacion de emergencia',
]);
const PLAN_ACTION = words([
  'activa', 'activad[oa]', 'activat', 'declara', 'declarad[oa]', 'declarar', 'eleva', 'elevad[oa]', 'sube', 'mantiene',
  'actualiza', 'amplia', 'pasa', 'pasando', 'desciende', 'baja', 'rebaja', 'decreta', 'fase', 'situacion',
]);
/** Nombra un plan de protección civil o un nivel (aunque no diga «activa»: «METEOCAM. Toledo»). */
export const mentionsPlan = (title) => PLAN_WORD.test(fold(title)) && !/\bsimulacro/.test(fold(title));
export function isPlanNotice(title) {
  const t = fold(title);
  if (/\bsimulacro/.test(t)) return false;
  return PLAN_WORD.test(t) && (PLAN_ACTION.test(t) || END.test(t));
}

/**
 * Gravedad según el nivel que declara el aviso: prealerta → media, alerta → alta, alerta máxima o
 * emergencia → muy alta. null si no dice ninguno.
 * @returns {import('./model.js').Severity|null}
 */
export function severityOf(text) {
  // «Plan de Emergencia(s)», «Emergencias 112»… son nombres, no el nivel declarado.
  const t = fold(text).replace(/\bplan(?:es)? (?:territorial |especial )?de emergencias?\b/g, 'plan');
  if (/\b(?:alerta maxima|emergencia|situacion (?:operativa )?[23]|nivel [23])\b/.test(t)) return 'muy alta';
  if (/\b(?:alerta|preemergencia|situacion (?:operativa )?1|nivel 1)\b/.test(t)) return 'alta';
  if (/\b(?:prealerta|situacion (?:operativa )?0|nivel 0)\b/.test(t)) return 'media';
  return null;
}

// De qué riesgo trata un aviso, para emparejar cada «declara» con su «finaliza» aunque los títulos
// no digan lo mismo («por lluvias» / «por lluvia»; «Plan Infoca» / «por el incendio de…»).
const HAZARDS = [
  ['cero energetico|zero energetic|apagon(?!es? (?:ferroviario|informativo|digital))|apagada', 'luz'],
  ['suministros? basicos?', 'suministros'],
  ['infoca|incendio|forestal', 'incendio'],
  ['inundacion|lluvia|precipitacion|dana|riada|avenida', 'lluvia'],
  ['sismic|sismo|terremoto', 'sismo'],
  ['nevada|nieve|helada', 'nieve'],
  ['tormenta', 'tormenta'],
  ['viento|temporal|borrasca', 'viento'],
  ['calima|polvo', 'calima'],
  ['temperatura|calor', 'calor'],
  ['oleaje|costero|maritimo', 'costero'],
  ['contaminacion', 'contaminacion'],
  ['comunicaciones|telefonia', 'telecomunicaciones'],
  ['quimic|seveso|nuclear|radiolog', 'quimico'],
  ['multitudinari|romeria|romero|aldea', 'evento'],
].map(([re, key]) => [new RegExp(`\\b(?:${re})`), key]);

/**
 * Claves de lo que trata el aviso: el riesgo que aparece antes en el título (o, si no dice ninguno,
 * el nombre del plan) y «luz» si habla de un corte de luz o de que ha vuelto.
 */
export function subjectsOf(title, text = '') {
  const t = fold(title);
  const found = HAZARDS.map(([re, key]) => [t.search(re), key]).filter(([at]) => at >= 0).sort((a, b) => a[0] - b[0]);
  const out = found.length ? [found[0][1]] : [];
  if (!out.length) {
    const plan = String(title).match(/\b([A-Z]{5,})\b/); // PLATECAM, METEOCAM…
    out.push(plan ? plan[1].toLowerCase() : t);
  }
  const all = `${title} ${text}`;
  if (mentionsPowerCut(all) || mentionsPowerBack(all)) out.push('luz');
  return [...new Set(out)];
}

/** Islas que nombra un texto; ['*'] si habla de todo el archipiélago; [] si no nombra ninguna. */
export function islandsIn(text) {
  const t = fold(text);
  if (/\b(?:archipielago|todas las islas|toda canarias|todo canarias|comunidad autonoma de canarias)\b/.test(t)) return ['*'];
  const out = new Set();
  if (/\bislas occidentales\b/.test(t)) GRUPOS_ISLAS.occidentales.forEach((n) => out.add(n));
  if (/\bislas orientales\b/.test(t)) GRUPOS_ISLAS.orientales.forEach((n) => out.add(n));
  for (const isla of ISLAS_CANARIAS) if (new RegExp(`\\b${fold(isla.name)}\\b`).test(t)) out.add(isla.name);
  // «La Palma» no cuenta como «Gran Canaria» ni al revés; «Canaria» suelta no es una isla.
  return [...out];
}

/** Provincias (de la tabla de lugares) que nombra un texto. */
export function provincesIn(text) {
  const t = fold(text);
  return PROVINCIAS.filter((p) => new RegExp(`\\b${fold(p.name)}\\b`).test(t)).map((p) => p.name);
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

/** Frases del texto que hablan del corte de luz y las que dicen que ha vuelto, por separado. */
export function powerClauses(text) {
  const cut = [];
  const back = [];
  const sentences = String(text ?? '').split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    // «Hay falta de suministro en A, mientras que en B ya se ha recuperado la luz»: dos partes.
    for (const clause of sentence.split(/[,;]\s+(?=mientras que|aunque|pero|y ya|ya se)|;\s+/)) {
      if (mentionsPowerBack(clause)) back.push(clause.trim());
      else if (mentionsPowerCut(clause)) cut.push(clause.trim());
    }
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
 */

/**
 * Avisos que siguen en vigor, uno por lugar: del más nuevo al más viejo, el primero de cada riesgo y
 * lugar es su estado actual. Un «finaliza» cierra lo que trata en sus lugares (o en todo el
 * territorio si no dice ninguno) y los avisos anteriores de eso ya no cuentan. Los que pasan de
 * `maxAgeMs` sin actualizarse se dejan de mostrar: los avisos no siempre publican su fin.
 * Con `wholeNotice` (incidencias del 112, que son un solo suceso), si se cierra uno de sus lugares
 * se cierra el aviso entero: «restablecido en Ventrosa» también vale para los otros pueblos de la avería.
 * @template {Notice} T
 * @param {T[]} notices
 * @param {{ now: number, maxAgeMs: number, wholeNotice?: boolean }} opts
 * @returns {Array<{ notice: T, place: string|null }>}
 */
export function currentNotices(notices, { now, maxAgeMs, wholeNotice = false }) {
  const closed = new Set();
  const seen = new Set();
  const out = [];
  for (const n of [...notices].sort((a, b) => b.at - a.at)) {
    if (!(now - n.at <= maxAgeMs)) continue;
    const places = n.places.length ? n.places : ['*'];
    if (n.end) {
      for (const s of n.subjects) for (const p of places) closed.add(`${s}|${p}`);
      continue;
    }
    const isShut = (p) => n.subjects.some((s) => closed.has(`${s}|${p}`) || closed.has(`${s}|*`));
    if (wholeNotice && places.some(isShut)) continue;
    for (const p of places) {
      const shut = isShut(p);
      const key = `${n.subjects[0]}|${p}`;
      if (shut || seen.has(key)) continue;
      seen.add(key);
      out.push({ notice: n, place: p === '*' ? null : p });
    }
  }
  return out;
}
