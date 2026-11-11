// Las órdenes del bot «Sigue tu tren» y los textos fijos que contesta, en el idioma de cada chat (idioma.js).
// Puro: sólo texto.
import { cutText } from './texto.js';
import { plainName } from '../provincias.js';
import { BOT_LANGS, ES, frase, translator } from './idioma.js';

/** Lo que se lee de un mensaje: más que esto no es una orden ni una búsqueda razonable. */
export const INPUT_MAX = 200;

/**
 * Órdenes: su nombre (el de siempre, en español, que es también el que se cuenta en el uso), su nombre en inglés
 * y su descripción para el menú del bot (setMyCommands) y la ayuda, en el mismo orden. Las dos formas valen
 * siempre; cada idioma enseña la suya.
 */
export const COMMANDS = Object.freeze([
  { name: 'seguir', en: 'follow', about: frase('Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid') },
  { name: 'trayecto', en: 'journey', about: frase('Tus trenes de una estación a otra: /trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V') },
  { name: 'estado', en: 'status', about: frase('Cómo va ahora lo que sigues, o lo que busques') },
  { name: 'provincia', en: 'province', about: frase('Avisos de tu provincia: AEMET, terremotos, emergencias, apagones y cortes de carretera') },
  { name: 'carretera', en: 'road', about: frase('Cortes y accidentes de una carretera: /carretera A-7, /carretera AP-7 Tarragona') },
  { name: 'mis', en: 'following', about: frase('Lo que sigues') },
  { name: 'dejar', en: 'unfollow', about: frase('Dejar de seguir algo') },
  { name: 'parte', en: 'summary', about: frase('Un resumen cada día a la hora que digas: /parte 07:30') },
  { name: 'datos', en: 'data', about: frase('Qué guardo de este chat') },
  { name: 'baja', en: 'stop', about: frase('Borrar todo lo de este chat') },
  { name: 'idioma', en: 'language', about: frase('Cambiar de idioma: español o inglés') },
  { name: 'ayuda', en: 'help', about: frase('Cómo funciona') },
].map((c) => Object.freeze(c)));

/** El menú de órdenes en un idioma: [orden, descripción]. */
export const commandsFor = (lang) => COMMANDS.map((c) => [lang === 'en' ? c.en : c.name, translator(lang).t(c.about)]);

const ALIASES = {
  start: 'start', borrar: 'baja', misavisos: 'mis', lista: 'mis', list: 'mis', lang: 'idioma', idiomas: 'idioma',
  ...Object.fromEntries(COMMANDS.map((c) => [c.en, c.name])),
};
const KNOWN = new Set(['start', ...COMMANDS.map((c) => c.name)]);
/** Los nombres en inglés de las órdenes: quien escribe así, sin haber elegido idioma, lee inglés (follow-bot.js). */
const ENGLISH_NAMES = new Set([...COMMANDS.map((c) => c.en), 'list']);
// El idioma como orden («/english», «/spanish»): es /idioma con ese idioma.
const LANG_COMMANDS = { english: 'english', ingles: 'english', spanish: 'spanish', espanol: 'spanish', castellano: 'spanish' };

/**
 * Lo que Telegram enseña del bot en cada idioma (setMyDescription, setMyShortDescription) y su menú de órdenes.
 * El primero, el de siempre (sin language_code); los demás, para quien tiene Telegram en ese idioma.
 * @returns {Array<{ lang: string, commands: Array<[string, string]>, description: string, shortDescription: string }>}
 */
export function botProfiles() {
  return BOT_LANGS.map((lang) => {
    const { t } = translator(lang);
    return {
      lang,
      commands: commandsFor(lang),
      description: t('Te aviso de lo que sigas en Radar España: cancelaciones, retrasos, avisos de tu línea y de tu provincia, y cortes y '
        + 'accidentes de tu carretera. Datos públicos de los operadores y de tráfico; no es un servicio oficial.'),
      shortDescription: t('Avisos de trenes, autobuses, metro y tranvía de radarespana.es.'),
    };
  });
}

/**
 * Qué pide un mensaje: una orden con su argumento («/seguir C4 Madrid», «/seguir@RadarBot C4», «/follow C4») o, si
 * es texto sin orden, una búsqueda (`buscar`). «/english» y «/spanish» son /idioma con ese idioma.
 * @param {string} text
 * @returns {{ command: string, arg: string, english?: true }}  command: el nombre de COMMANDS, 'start', 'buscar' o
 *   'desconocida'; english: la orden se ha escrito con su nombre en inglés («/follow»)
 */
export function parseCommand(text) {
  const t = cutText(String(text ?? ''), INPUT_MAX, '').trim();
  const m = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return { command: t ? 'buscar' : 'ayuda', arg: t };
  const name = m[1].toLowerCase();
  if (Object.hasOwn(LANG_COMMANDS, name)) return { command: 'idioma', arg: LANG_COMMANDS[name] };
  const command = (Object.hasOwn(ALIASES, name) ? ALIASES[name] : null) ?? (KNOWN.has(name) ? name : 'desconocida');
  return { command, arg: (m[2] ?? '').replace(/\s+/g, ' ').trim(), ...(ENGLISH_NAMES.has(name) ? { english: true } : {}) };
}

// Lo que se escribe en un chat sin buscar nada («hola», «gracias», «vale»): no es una búsqueda (por el principio
// de una palabra, «hola» encontraba la parada «Naciones-Holanda» y «vale», las líneas de València). También en
// inglés, para quien escribe así.
const GREETING = /^(?:hola|holi|buenas|buenos dias|buenas tardes|buenas noches|hey|hi|hello|que tal|saludos|good morning|good afternoon|good evening)$/;
const THANKS = /^(?:gracias|muchas gracias|mil gracias|thanks|thank you|thank you very much|many thanks|cheers|thx)$/;
const OK = /^(?:vale|ok|okay|okey|perfecto|genial|de acuerdo|entendido|si|no|adios|hasta luego|chao|bien|muy bien|de nada|yes|great|cool|fine|got it|bye|goodbye)$/;
const HELP = /^(?:ayuda|help|menu|info|informacion|como funciona|que haces|start|empezar|comandos|ordenes|commands|how does it work|what do you do)$/;

/**
 * ¿Es charla y no una búsqueda? 'saludo', 'gracias', 'vale' o 'ayuda'; si no, null. Con «bot», «radar» o signos
 * alrededor igual («¡Hola, bot!», «gracias!!»).
 * @param {string} text
 */
export function smallTalk(text) {
  const t = plainName(text).replace(/(?:^| )(?:bot|radar|radar espana|amigo)$/, '').trim().replace(/^(?:hola )(?=que tal$)/, '');
  if (!t) return null;
  if (GREETING.test(t)) return 'saludo';
  if (THANKS.test(t)) return 'gracias';
  if (OK.test(t)) return 'vale';
  if (HELP.test(t)) return 'ayuda';
  return null;
}

/** Lo que se contesta a la charla: qué se le puede escribir. */
export function smallTalkText(kind, { t } = ES) {
  if (kind === 'gracias' || kind === 'vale') {
    const more = t('Si quieres seguir algo más, dime su número o su línea («08058», «C4 Madrid»). /mis para ver lo que sigues.');
    return kind === 'gracias' ? `${t('De nada.')} ${more}` : more;
  }
  const what = t('Dime qué quieres seguir: un número de tren («08058»), una línea con su ciudad u operador '
    + '(«C4 Madrid», «27 EMT Málaga») o una provincia (/provincia Valencia). /ayuda para ver todo lo que hago.');
  return kind === 'saludo' ? `${t('Hola.')} ${what}` : what;
}

/**
 * ¿Es una hora válida? «HH:MM», «7:30», «0730», «7.30» o «7h30»; y, como se escribe en inglés, «7pm» o «7:30 am».
 * La devuelve como «HH:MM» (24 h); si no, null.
 */
export function parseHour(text) {
  const t = String(text ?? '').trim();
  const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(t);
  if (m) return Number(m[1]) > 23 || Number(m[2]) > 59 ? null : `${m[1].padStart(2, '0')}:${m[2]}`;
  const ampm = /^(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?\s*m\.?$/i.exec(t);
  if (!ampm || Number(ampm[1]) < 1 || Number(ampm[1]) > 12 || Number(ampm[2] ?? 0) > 59) return null;
  const hour = (Number(ampm[1]) % 12) + (ampm[3].toLowerCase() === 'p' ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${ampm[2] ?? '00'}`;
}

/** La ayuda: qué hace, las órdenes (con sus nombres en el idioma del chat) y de dónde salen los datos. */
export function helpText({ webUrl, limits, tr = ES }) {
  const { t } = tr;
  return [
    t('Te aviso de lo que sigas: cualquier tren, autobús, metro o tranvía que publique el radar, su línea, una estación o tu trayecto de '
      + 'cada día, los avisos de tu provincia (y, si los pides, sus focos de calor) y los cortes y accidentes de una carretera.'),
    t('Órdenes:'),
    commandsFor(tr.lang).map(([c, d]) => `/${c}: ${d}`).join('\n'),
    t('También puedes escribirme sin orden lo que buscas («08058», «C4 Madrid», «27 EMT Málaga»).'),
    t('Desde la web, en la ficha de un vehículo o de una estación, el botón «Avísame por Telegram» lo sigue directamente: {web}', { web: webUrl }),
    t('Avisos: si se cancela o se suprimen paradas, si va con {delay} min de retraso o más (y otra vez si empeora), si su operador deja de '
      + 'publicarlo y los avisos del operador sobre su línea. Puedes seguir hasta {max} cosas.', { delay: limits.delayMin, max: limits.subsPerChat }),
    t('Los datos son los que publican los operadores y organismos: el radar no es oficial y puede fallar. No lo uses para decisiones de seguridad.'),
  ].join('\n\n');
}

export function welcomeText({ webUrl, limits, tr = ES }) {
  return `${tr.t('Hola. Soy el bot de Radar España.')}\n\n${helpText({ webUrl, limits, tr })}`;
}

/** El nombre de cada idioma: en /datos, en el del chat; en los botones para elegirlo, en el suyo (langLabel). */
export const LANG_NAMES = Object.freeze({ es: frase('español'), en: frase('inglés') });
/** «Español», «English»: cada idioma, con su propio nombre. */
export const langLabel = (lang) => {
  const name = translator(lang).t(LANG_NAMES[lang] ?? LANG_NAMES.es);
  return name[0].toUpperCase() + name.slice(1);
};

/**
 * Lo que se guarda de un chat, para /datos.
 * @param {{ id: number|string, since: number, subs: Array<{ name: string }>, provinces: Array<{ name: string }>, digest: string|null,
 *           lang: string }|null} chat  los nombres, ya en el idioma del chat
 * @param {{ tr?: import('./idioma.js').Translator }} [opts]
 */
export function dataText(chat, { tr = ES } = {}) {
  const { t } = tr;
  if (!chat) {
    const nothing = t('De este chat no guardo nada: no sigues nada. Si sigues algo, guardaré el número de este chat, lo que sigues y desde '
      + 'cuándo; nada más (ni tu nombre ni tu teléfono). Se borra todo con /baja.');
    // El idioma elegido sin seguir nada sólo se recuerda en memoria (follow-bot.js), y así se dice.
    return tr.lang === ES.lang ? nothing
      : `${nothing} ${t('El idioma que has elegido sólo lo recuerdo en memoria, sin guardarlo, hasta que se reinicie el bot.')}`;
  }
  return [
    t('Esto es todo lo que guardo de este chat:'),
    t('- Número del chat: {id}', { id: chat.id }),
    t('- Desde: {when}', { when: tr.when(chat.since) }),
    t('- Lo que sigues: {list}', { list: chat.subs.length ? chat.subs.map((s) => s.name).join('; ') : t('nada') }),
    t('- Provincias: {list}', { list: chat.provinces.length ? chat.provinces.map((p) => p.name).join(', ') : t('ninguna') }),
    t('- Parte diario: {hour}', { hour: chat.digest ?? t('no') }),
    t('- Idioma: {lang}', { lang: t(LANG_NAMES[chat.lang] ?? LANG_NAMES.es) }),
    t('Nada más: ni tu nombre, ni tu usuario, ni tu teléfono. Lo uso sólo para avisarte y se borra con /baja (también si bloqueas el bot). '
      + 'Telegram, que transporta los mensajes, tiene su propia política de privacidad.'),
  ].join('\n');
}
