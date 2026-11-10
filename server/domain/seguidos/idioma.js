// El idioma del bot «Sigue tu tren»: español por defecto e inglés si el chat lo elige. Mismo criterio que la web
// (public/js/i18n.js): las frases en español son la clave y el diccionario inglés (en.js) da su traducción; una
// frase que falte sale en español, y test/domain/bot-idioma.test.js recorre el código del bot para que no falte
// ninguna ni se cuele una sin pasar por t().
//
// Se traduce lo que escribe el bot con sus palabras. Se deja tal cual lo que no es nuestro:
// - los nombres (estaciones, líneas, operadores, provincias, lugares) y los textos que publica cada fuente
//   (avisos de Renfe, de AEMET, de protección civil, motivos de las cancelaciones…): varias licencias piden no
//   alterar su contenido, y un nombre traducido ya no es el que se ve en la estación;
// - las atribuciones con su fórmula («Origen de los datos: Renfe Operadora», «© AEMET», «Powered by MITRAMS»…).
// Los títulos que escribe nuestro servidor (cancelaciones, terremotos…) van con las plantillas que usa la web
// (../en-servidor.js), y los nombres de lo que se sigue, que se guardan en español (domain/seguir.js
// describeFollow, directorio.js guessedName), con sus palabras traducidas al enseñarlos (nameText).
// Puro: sin red, ni reloj, ni disco.
import { EN } from './en.js';
import { serverTextEn } from '../en-servidor.js';
import { MODES, modeNoun } from '../modos.js';
import { plainName } from '../provincias.js';
import { ALL_DAYS, daysText } from '../seguir.js';

/** Los idiomas del bot; el primero, el de siempre. */
export const BOT_LANGS = Object.freeze(['es', 'en']);
export const DEFAULT_LANG = 'es';
export const isBotLang = (l) => BOT_LANGS.includes(l);

/**
 * Marca una frase en español que se traduce más tarde con t() (como gettext_noop): una descripción de una orden,
 * un nombre que se guarda en español. Devuelve la frase tal cual; el test la busca igual que las de t('…').
 */
export const frase = (es) => es;

// Fecha y hora en la de Madrid: «10/11, 15:00» en los dos idiomas (en inglés, día/mes y 24 h, como en Europa).
const DATE_TIME = Object.fromEntries(BOT_LANGS.map((l) => [l, new Intl.DateTimeFormat(l === 'en' ? 'en-GB' : 'es-ES', {
  timeZone: 'Europe/Madrid', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})]));

// Los días de un trayecto (máscara, bit 0 el lunes; domain/seguir.js): en español, daysText («de lunes a viernes»,
// «los sábados»…); en inglés, con los nombres de los días de Intl (el 1 de enero de 2024 fue lunes).
const WEEKDAYS_EN = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' })
  .format(Date.UTC(2024, 0, 1 + i)));
// El texto en español de cada máscara, para leerla de un nombre guardado («… (07:00-09:00, de lunes a viernes)»).
const MASK_OF_DAYS = new Map(Array.from({ length: ALL_DAYS }, (_, i) => [daysText(i + 1), i + 1]));

/**
 * Los días de una máscara en inglés, con las mismas formas que daysText: «every day», «Monday to Friday» (seguidos,
 * tres o más, también pasando del domingo al lunes), «on Saturdays», «on Mondays, Wednesdays and Fridays».
 * @param {number} mask  @param {(es: string, params?: object) => string} t  el traductor inglés
 */
function daysTextEn(mask, t) {
  const on = [0, 1, 2, 3, 4, 5, 6].filter((i) => mask & (1 << i));
  if (on.length === 7) return t('todos los días');
  if (!on.length) return t('ningún día');
  const start = on.find((i) => !(mask & (1 << ((i + 6) % 7))));
  if (on.length >= 3 && on.every((_, k) => mask & (1 << ((start + k) % 7)))) {
    return t('de {from} a {to}', { from: WEEKDAYS_EN[start], to: WEEKDAYS_EN[(start + on.length - 1) % 7] });
  }
  const many = on.map((i) => `${WEEKDAYS_EN[i]}s`);
  return t('los {days}', { days: many.length === 1 ? many[0] : t('{list} y {last}', { list: many.slice(0, -1).join(', '), last: many.at(-1) }) });
}

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (all, k) => (Object.hasOwn(params, k) ? String(params[k] ?? '') : all)) : text);
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- Nombres de lo que se sigue ----------
// Se guardan en español, tal y como los escribe el dominio, y se enseñan con nuestras palabras en el idioma del
// chat: «Autobús 27 · EMT Málaga» → «Bus 27 · EMT Málaga». Nunca los nombres de dentro (operador, línea, lugar).
// La palabra del principio: «Línea», «Servicio» o el nombre de un tipo del registro (modos.js) con mayúscula.
const KIND_WORDS = [...new Set([frase('Línea'), frase('Servicio'), ...MODES.map((m) => capital(m.noun)), capital(modeNoun(null))])];
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const NAME_KIND = new RegExp(`^(${KIND_WORDS.map(reEscape).join('|')})(?= .* · | · )`);
// Los nombres de lo que ahora no se ve (directorio.js guessedName y follow-bot.js), enteros.
const FIXED_NAMES = new Set([frase('esa línea (ahora no se ve)'), frase('ese servicio (ahora no se ve)'), frase('esa estación'), frase('eso')]);

/** Las palabras que pueden empezar un nombre (para el test: tienen que estar en el diccionario). */
export const NAME_WORDS = Object.freeze(KIND_WORDS);

/**
 * El nombre de algo seguido con nuestras palabras traducidas por `t`; lo demás, igual.
 * @param {string} name  @param {(es: string, params?: object) => string} t
 */
export function nameText(name, t) {
  if (typeof name !== 'string') return name;
  if (FIXED_NAMES.has(name)) return t(name);
  // Un trayecto (describeFollow): «<origen> → <destino> (07:00-09:00, de lunes a viernes)»; sólo cambian los días.
  let m = /^(.+ → .+) \((\d{2}:\d{2}-\d{2}:\d{2}), ([^()]+)\)$/.exec(name);
  if (m && MASK_OF_DAYS.has(m[3])) return `${m[1]} (${m[2]}, ${daysTextEn(MASK_OF_DAYS.get(m[3]), t)})`;
  // Una carretera (trafico.js roadTitle): «Carretera A-7» o «Carretera A-7 (Málaga)»; la carretera y la provincia, tal cual.
  m = /^Carretera (.+?)( \([^()]+\))?$/.exec(name);
  if (m) return `${t('Carretera {road}', { road: m[1] })}${m[2] ?? ''}`;
  m = /^(.+): toda la red$/.exec(name);
  if (m) return t('{who}: toda la red', { who: m[1] });
  m = /^una línea de (.+)$/.exec(name);
  if (m) return t('una línea de {operator}', { operator: m[1] });
  m = /^un servicio de (.+)$/.exec(name);
  if (m) return t('un servicio de {operator}', { operator: m[1] });
  m = /^Estación (.+)$/.exec(name);
  if (m) return t('Estación {name}', { name: m[1] });
  return name
    .replace(NAME_KIND, (word) => t(word))
    .replace(/, el de las (\d{1,2}:\d{2})(?=,|$)/, (all, time) => `, ${t('el de las {time}', { time })}`)
    .replace(/, desde (.+)$/, (all, place) => `, ${t('desde {place}', { place })}`)
    .replace(/\(sin nombre legible\)/, () => t('(sin nombre legible)'));
}

/**
 * @typedef {object} Translator
 * @property {'es'|'en'} lang
 * @property {(es: string, params?: object) => string} t  La frase en el idioma del chat, con sus {variables}.
 * @property {(one: string, other: string, n: number, params?: object) => string} tn  Singular o plural según n ({n}).
 * @property {(ms: number) => string|null} when  «10/11, 15:00» en hora de Madrid.
 * @property {(text: string, source?: string|null) => string} server  Un texto que escribe nuestro servidor (un título).
 * @property {(name: string) => string} name  El nombre de algo seguido (nameText).
 * @property {(mode: string|null, plural?: boolean) => string} noun  «tren», «autobuses»… del registro de tipos.
 * @property {(mask: number) => string} days  Los días de un trayecto: «de lunes a viernes», «Monday to Friday».
 */

/** @returns {Translator} */
function make(lang) {
  const dict = lang === 'en' ? EN : null;
  const t = (es, params) => fill(dict && Object.hasOwn(dict, es) ? dict[es] : es, params);
  return Object.freeze({
    lang,
    t,
    tn: (one, other, n, params = {}) => t(n === 1 ? one : other, { n, ...params }),
    when: (ms) => (Number.isFinite(ms) ? DATE_TIME[lang].format(ms) : null),
    server: (text, source = null) => (dict ? serverTextEn(text, source) : text),
    name: (name) => (dict ? nameText(name, t) : name),
    noun: (mode, plural = false) => t(modeNoun(mode, plural)),
    days: (mask) => (dict ? daysTextEn(mask, t) : daysText(mask)),
  });
}

const TRANSLATORS = new Map(BOT_LANGS.map((l) => [l, make(l)]));
/** El traductor de un idioma (el de siempre si no es uno del bot). */
export const translator = (lang) => TRANSLATORS.get(lang) ?? TRANSLATORS.get(DEFAULT_LANG);
/** El de español: lo que contesta el bot si nadie ha elegido otro idioma. */
export const ES = translator('es');

// ---------- Cómo se elige el idioma ----------

/** Lo que se escribe para elegir un idioma (/idioma inglés, /language english…): 'es', 'en' o null. */
const LANG_WORDS = { es: ['es', 'espanol', 'castellano', 'spanish'], en: ['en', 'ingles', 'english'] };
export function parseLang(text) {
  const t = plainName(text);
  return BOT_LANGS.find((l) => LANG_WORDS[l].includes(t)) ?? null;
}

// Los idiomas de España: quien tiene Telegram en catalán, euskera o gallego está en España y lee español.
const SPAIN = /^(?:es|ca|eu|gl|ast|oc)(?:[-_]|$)/i;
/**
 * ¿Hay que ofrecerle el inglés? Si su Telegram está en otro idioma (`language_code` que Telegram manda con cada
 * mensaje: «en», «de», «pt-br»…) que no es de España. Sin él, no.
 */
export const offerEnglish = (clientLang) => typeof clientLang === 'string' && /^[a-z]{2,3}(?:[-_][a-z0-9]{1,8})*$/i.test(clientLang)
  && !SPAIN.test(clientLang);

/**
 * Lo que trae un enlace t.me/<bot>?start=<payload>. La web en inglés pone delante el idioma («en-s-renfe-8058»,
 * «en-c-A7», «en-prov-valencia», «en» a secas): ninguna clave ni provincia empieza así (las claves son «s-», «l-»,
 * «p-», «t-» o, las de carretera, «c-»), y los enlaces de siempre, sin idioma, siguen igual.
 * @returns {{ lang: string|null, rest: string }}
 */
export function parseStartPayload(arg) {
  const m = /^([a-z]{2})(?:-(.*))?$/.exec(String(arg ?? ''));
  if (m && isBotLang(m[1])) return { lang: m[1], rest: m[2] ?? '' };
  return { lang: null, rest: String(arg ?? '') };
}
