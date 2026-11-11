// El bot en inglés: que no falte ninguna frase en el diccionario (server/domain/seguidos/en.js), que no se cuele
// ninguna sin pasar por t() y que las traducciones lleven las mismas variables y las órdenes en inglés. Las frases
// salen del propio código del bot, como en la web (test/public/i18n.test.js): una frase nueva sin traducir, o
// escrita sin t(), no pasa los tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EN } from '../../server/domain/seguidos/en.js';
import { NAME_WORDS, nameText, offerEnglish, parseLang, parseStartPayload, translator } from '../../server/domain/seguidos/idioma.js';
import { COMMANDS, botProfiles, commandsFor, parseCommand, parseHour } from '../../server/domain/seguidos/ordenes.js';
import { guessedName, knownNames, updateDirectory } from '../../server/domain/seguidos/directorio.js';
import { MODES } from '../../server/domain/modos.js';
import { daysText, describeFollow, lineKey, numberedServiceKey, scheduledServiceKey } from '../../server/domain/seguir.js';
import { parseDays } from '../../server/domain/seguidos/trayectos.js';
import { parseRoadRequest } from '../../server/domain/seguidos/trafico.js';
import { provinceOption } from '../../server/domain/seguidos/zona.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// Lo que escribe el bot: su dominio (menos el diccionario y el directorio, que sólo da nombres en español: se
// guardan así y se traducen al enseñarlos, ver el test de los nombres) y su caso de uso. Un fichero nuevo en
// server/domain/seguidos/ entra solo.
const SEGUIDOS = 'server/domain/seguidos/';
const NOT_SCANNED = new Set(['en.js', 'directorio.js']);
const FILES = [
  ...(await readdir(`${ROOT}${SEGUIDOS}`)).filter((f) => f.endsWith('.js') && !NOT_SCANNED.has(f)).map((f) => `${SEGUIDOS}${f}`),
  'server/application/use-cases/follow-bot.js',
];
const sources = await Promise.all(FILES.map(async (f) => [f, await readFile(`${ROOT}${f}`, 'utf8')]));

// Un literal de JS: '…', "…" o `…`; y varios unidos con + (las frases largas van partidas en varias líneas).
const LIT = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60`;
const JOINED = String.raw`(?:${LIT})(?:\s*\+\s*(?:${LIT}))*`;
const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, (all, c) => ({ n: '\n', t: '\t' }[c] ?? c));
const joined = (s) => [...s.matchAll(new RegExp(LIT, 'g'))].map((m) => unquote(m[0])).join('');
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

/** Las frases de un fichero que pasan por t(), tn() o frase(), con su línea y dónde empieza cada literal. */
function keysOf(src) {
  const out = [];
  const add = (group, index) => {
    const starts = [...group.matchAll(new RegExp(LIT, 'g'))].map((m) => index + m.index);
    out.push({ key: joined(group), line: lineOf(src, index), starts });
  };
  for (const m of src.matchAll(new RegExp(String.raw`\btn\(\s*(${JOINED})\s*,\s*(${JOINED})`, 'g'))) {
    add(m[1], m.index + m[0].indexOf(m[1]));
    add(m[2], m.index + m[0].lastIndexOf(m[2]));
  }
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:t|frase)\(\s*(${JOINED})`, 'g'))) add(m[1], m.index + m[0].indexOf(m[1]));
  return out;
}

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw']);
/**
 * Todos los literales de texto de un fichero (también los de dentro de ${…}), con dónde empiezan y su parte fija
 * (las ${…}, como {}), y dónde están sus comentarios. Se salta las expresiones regulares.
 */
function literalsOf(src) {
  const found = [];
  const comments = [];
  const n = src.length;
  let prev = '';
  const regexAllowed = () => prev === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || KEYWORDS_BEFORE_REGEX.has(prev);
  function skipRegex(i) {
    let j = i + 1;
    let inClass = false;
    for (; j < n; j++) {
      const c = src[j];
      if (c === '\\') j++;
      else if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
    }
    j++;
    while (j < n && /[a-z]/.test(src[j])) j++;
    return j;
  }
  function scan(i, inExpr) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        comments.push([i, end < 0 ? n : end]);
        i = end < 0 ? n : end;
      } else if (c === '/' && src[i + 1] === '*') {
        comments.push([i, src.indexOf('*/', i + 2) + 2]);
        i = comments.at(-1)[1];
      } else if (c === '\'' || c === '"' || c === '`') {
        const start = i;
        let text = '';
        let j = i + 1;
        while (j < n && src[j] !== c) {
          if (src[j] === '\\') {
            text += src[j + 1];
            j += 2;
          } else if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
            text += '{}';
            j = scan(j + 2, true);
          } else {
            text += src[j];
            j++;
          }
        }
        found.push({ start, text });
        i = j + 1;
        prev = 'lit';
      } else if (c === '/' && regexAllowed()) {
        i = skipRegex(i);
        prev = 'lit';
      } else if (/\s/.test(c)) {
        i++;
      } else if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j++;
        prev = src.slice(i, j);
        i = j;
      } else {
        if (inExpr && c === '{') depth++;
        if (inExpr && c === '}') {
          if (!depth) return i + 1;
          depth--;
        }
        prev = c;
        i++;
      }
    }
    return n;
  }
  scan(0, false);
  return { literals: found, comments };
}

/** El código sin sus comentarios (con espacios en su lugar, para que las posiciones sigan siendo las mismas). */
const withoutComments = (src, comments) => comments.reduce((s, [a, b]) => s.slice(0, a) + s.slice(a, b).replace(/[^\n]/g, ' ') + s.slice(b), src);

// Una frase para una persona: con tildes, eñes o signos del español, dos palabras o una palabra con mayúscula
// («Hecho»). Los identificadores («servicio», «prov:», «sin-datos») no lo son.
const isPhrase = (s) => /[áéíóúñüÁÉÍÓÚÑ¿¡«»]/.test(s) || /\p{L}{2,}\s+\p{L}{2,}/u.test(s) || /^\p{Lu}\p{Ll}+[.!?]?$/u.test(s);
// Lo que no se le escribe a nadie: el registro del servidor.
const isLog = (src, start) => /\blog\??\.(?:info|warn|error)\(\s*$/.test(src.slice(Math.max(0, start - 40), start));

const scanned = sources.map(([file, src]) => {
  const { literals, comments } = literalsOf(src);
  return [file, src, keysOf(withoutComments(src, comments)), literals];
});
const allKeys = new Set(scanned.flatMap(([, , keys]) => keys.map((k) => k.key)));
// Las que se traducen sin estar escritas en el código: los nombres de los tipos de vehículo del registro.
const dynamicKeys = new Set([...MODES.flatMap((m) => [m.noun, m.nounPlural]), 'vehículo', 'vehículos', ...NAME_WORDS]);
const varsOf = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('cada frase del bot que pasa por t(), tn() o frase() está en el diccionario inglés', () => {
  const missing = [];
  for (const [file, , keys] of scanned) for (const { key, line } of keys) if (!Object.hasOwn(EN, key)) missing.push(`${file}:${line} «${key}»`);
  assert.deepEqual(missing, []);
});

test('ninguna frase del bot se escribe sin pasar por t(): una frase nueva sin traducir no se cuela', () => {
  const loose = [];
  for (const [file, src, keys, literals] of scanned) {
    const covered = new Set(keys.flatMap((k) => k.starts));
    for (const { start, text } of literals) {
      if (covered.has(start) || !isPhrase(text) || isLog(src, start)) continue;
      loose.push(`${file}:${lineOf(src, start)} «${text.slice(0, 80)}»`);
    }
  }
  assert.deepEqual(loose, [], 'escríbela con t(\'…\') (o frase(\'…\') si se traduce más tarde) y añádela a server/domain/seguidos/en.js');
});

test('ninguna frase de t() lleva ${…}: las variables van entre llaves, si no la clave cambia cada vez', () => {
  const bad = [];
  for (const [file, , keys] of scanned) for (const { key, line } of keys) if (key.includes('${')) bad.push(`${file}:${line}`);
  assert.deepEqual(bad, []);
});

test('los nombres de los tipos de vehículo y las palabras de los nombres están en el diccionario', () => {
  assert.deepEqual([...dynamicKeys].filter((k) => !Object.hasOwn(EN, k)), []);
});

test('el diccionario no guarda frases que el bot ya no dice', () => {
  assert.deepEqual(Object.keys(EN).filter((k) => !allKeys.has(k) && !dynamicKeys.has(k)), []);
});

test('cada traducción lleva las mismas variables, y en inglés de verdad: sin signos del español ni sus órdenes', () => {
  const enCommands = new Set([...COMMANDS.map((c) => c.en), 'start']);
  const toEn = Object.fromEntries(COMMANDS.map((c) => [c.name, c.en]));
  const bad = [];
  for (const [es, en] of Object.entries(EN)) {
    if (typeof en !== 'string' || !en.trim()) bad.push(`«${es}»: vacía`);
    else if (varsOf(es).join() !== varsOf(en).join()) bad.push(`«${es}»: variables`);
    else if (/[¿¡]/.test(en)) bad.push(`«${es}»: signos del español`);
    else {
      // Las órdenes que cita, con su nombre en inglés: /seguir → /follow.
      const cited = (s) => [...s.matchAll(/\/([a-z]+)\b/g)].map((m) => m[1]);
      if (cited(en).some((c) => !enCommands.has(c))) bad.push(`«${es}»: una orden en español`);
      else if (cited(es).map((c) => toEn[c] ?? c).join() !== cited(en).join()) bad.push(`«${es}»: no cita las mismas órdenes`);
    }
  }
  assert.deepEqual(bad, []);
});

test('las órdenes: en inglés valen las dos formas, y cada idioma enseña la suya en el menú', () => {
  for (const c of COMMANDS) {
    assert.equal(parseCommand(`/${c.en} x`).command, c.name, c.en);
    assert.equal(parseCommand(`/${c.name} x`).command, c.name, c.name);
  }
  assert.equal(parseCommand('/language').command, 'idioma');
  assert.equal(parseCommand('/stop').command, 'baja');
  assert.equal(parseCommand('/constructor').command, 'desconocida', 'nada de las propiedades de un objeto');
  assert.deepEqual(commandsFor('en')[0], ['follow', 'Follow a train, bus, metro or line: /follow 08058, /follow C4 Madrid']);
  assert.deepEqual(commandsFor('es')[0], ['seguir', 'Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid']);
  for (const lang of ['es', 'en']) {
    for (const [name, about] of commandsFor(lang)) {
      assert.match(name, /^[a-z0-9_]{1,32}$/, 'lo que admite Telegram');
      assert.ok(about.length >= 3 && about.length <= 256);
    }
  }
  const [es, en] = botProfiles();
  assert.equal(es.lang, 'es', 'el primero, el de siempre');
  assert.equal(en.lang, 'en');
  for (const p of [es, en]) {
    assert.ok(p.description.length <= 512 && p.shortDescription.length <= 120, 'los topes de Telegram');
  }
  assert.match(en.description, /^I alert you about what you follow on Radar España/);
});

test('el idioma: qué se ofrece, qué se entiende y qué trae un enlace', () => {
  for (const code of ['en', 'en-GB', 'de', 'pt-br', 'fr']) assert.equal(offerEnglish(code), true, code);
  for (const code of ['es', 'es-ES', 'es-419', 'ca', 'eu', 'gl', undefined, '', 'x', '<script>']) assert.equal(offerEnglish(code), false, String(code));
  assert.equal(parseLang('English'), 'en');
  assert.equal(parseLang('inglés'), 'en');
  assert.equal(parseLang('Español'), 'es');
  assert.equal(parseLang('francés'), null);
  assert.deepEqual(parseStartPayload('en-s-renfe-8058'), { lang: 'en', rest: 's-renfe-8058' });
  assert.deepEqual(parseStartPayload('en-prov-valencia'), { lang: 'en', rest: 'prov-valencia' });
  assert.deepEqual(parseStartPayload('en'), { lang: 'en', rest: '' });
  assert.deepEqual(parseStartPayload('s-renfe-8058'), { lang: null, rest: 's-renfe-8058' }, 'los enlaces de siempre, igual');
  assert.deepEqual(parseStartPayload('prov-valencia'), { lang: null, rest: 'prov-valencia' });
  assert.deepEqual(parseStartPayload('fr-s-renfe-8058'), { lang: null, rest: 'fr-s-renfe-8058' }, 'un idioma que el bot no tiene');
});

test('horas: 24 h y también como se escriben en inglés', () => {
  assert.equal(parseHour('7pm'), '19:00');
  assert.equal(parseHour('7:30 am'), '07:30');
  assert.equal(parseHour('12am'), '00:00');
  assert.equal(parseHour('12:15 PM'), '12:15');
  assert.equal(parseHour('13pm'), null);
  assert.equal(parseHour('7:61pm'), null);
  assert.equal(parseHour('19:45'), '19:45');
});

test('fechas: día/mes y 24 h en hora de Madrid, en los dos idiomas', () => {
  const at = Date.parse('2026-11-10T23:05:00Z'); // 00:05 del 11 en Madrid
  assert.equal(translator('es').when(at), '11/11, 00:05');
  assert.equal(translator('en').when(at), '11/11, 00:05');
});

test('los nombres de lo que se sigue: nuestras palabras en inglés, los nombres de dentro tal cual', () => {
  const { t } = translator('en');
  const en = (name) => nameText(name, t);
  const C10 = lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C10' });
  const cases = [
    [describeFollow(lineKey({ operator: 'EMT Málaga', line: '27' }), { modeLabel: 'Autobús', operator: 'EMT Málaga' }), 'Bus 27 · EMT Málaga'],
    [describeFollow(C10, { operator: 'Renfe' }), 'Line C10 · Renfe (Madrid)'],
    [describeFollow(lineKey({ operator: 'Renfe', scope: 'Madrid', line: 'C4a' }), { operator: 'Renfe', service: 'Cercanías' }), 'Cercanías C4a · Renfe (Madrid)'],
    [describeFollow(lineKey({ operator: 'Metro Bilbao' }), { operator: 'Metro Bilbao' }), 'Metro Bilbao: whole network'],
    [describeFollow(numberedServiceKey({ operator: 'Renfe', number: '08058' }), { operator: 'Renfe', service: 'Avant', number: '08058' }), 'Avant 08058'],
    [describeFollow(scheduledServiceKey({ operator: 'Euskotren', line: 'E4', origin: 'x', departure: 13 * 3600 + 600 }),
      { operator: 'Euskotren', line: 'E4', modeLabel: 'Tren', origin: 'Matiko-Bilbao' }), 'Train E4 · Euskotren, departing 13:10, from Matiko-Bilbao'],
    ['Estación Valladolid-Campo Grande', 'Valladolid-Campo Grande station'],
    ['Tranvía T1 · Metro Ligero Oeste', 'Tram T1 · Metro Ligero Oeste'],
  ];
  for (const [es, want] of cases) assert.equal(en(es), want, es);
  // Lo que no se ve ahora (directorio.js guessedName y follow-bot.js): ninguna palabra nuestra en español.
  const dir = updateDirectory(new Map(), { vehicles: [{ id: 'v', mode: 'bus', operator: 'EMT Málaga', line: '27', follow: [lineKey({ operator: 'EMT Málaga', line: '27' })] }], now: 0 });
  const known = knownNames(dir);
  const guessed = [
    guessedName('l-desconocida-1', known), guessedName('s-desconocida-1', known), guessedName(lineKey({ operator: 'EMT Málaga', line: 'Línea larga' }), known),
    guessedName(numberedServiceKey({ operator: 'EMT Málaga', number: 'X1-Y' }), known), guessedName(lineKey({ operator: 'EMT Málaga' }), known),
    guessedName(scheduledServiceKey({ operator: 'EMT Málaga', line: '27', origin: 'x', departure: 7 * 3600 }), known),
    'esa estación', 'eso',
  ];
  const SPANISH = /\b(de|del|la|las|el|esa|ese|eso|una|un|línea|servicio|estación|ahora|se|ve|toda|red|desde)\b/i;
  for (const name of guessed) assert.doesNotMatch(en(name).replace('EMT Málaga', ''), SPANISH, `${name} → ${en(name)}`);
  assert.equal(en('Línea 27 · EMT Málaga, el de las 07:00'), 'Line 27 · EMT Málaga, departing 07:00');
  assert.equal(nameText('Autobús 27 · EMT Málaga', translator('es').t), 'Autobús 27 · EMT Málaga', 'en español, igual');
});

test('trayectos y carreteras: sus nombres y sus días en inglés; y lo que se escribe en inglés también vale', () => {
  const { t, days } = translator('en');
  const en = (name) => nameText(name, t);
  const route = 'Alcalá de Henares → Madrid-Atocha Cercanías';
  assert.equal(en(`${route} (07:00-09:00, de lunes a viernes)`), `${route} (07:00-09:00, Monday to Friday)`);
  assert.equal(en(`${route} (07:00-09:00, todos los días)`), `${route} (07:00-09:00, every day)`);
  assert.equal(en(`${route} (07:00-09:00, los sábados)`), `${route} (07:00-09:00, Saturdays)`);
  assert.equal(en(`${route} (07:00-09:00, lunes, miércoles y viernes)`), `${route} (07:00-09:00, Mondays, Wednesdays and Fridays)`);
  assert.equal(en(`${route} (07:00-09:00, de viernes a lunes)`), `${route} (07:00-09:00, Friday to Monday)`);
  // Todas las máscaras: el nombre guardado en español (daysText) se lee y sale en inglés, sin nada en español.
  for (let mask = 1; mask <= 0x7f; mask++) {
    assert.equal(en(`A → B (07:00-09:00, ${daysText(mask)})`), `A → B (07:00-09:00, ${days(mask)})`, String(mask));
    assert.doesNotMatch(days(mask), /\b(?:de|los|y|lunes|martes|jueves|viernes|domingos?|todos|días)\b|á|é/, String(mask));
    assert.equal(parseDays(days(mask)), mask, `lo que dice en inglés se entiende al escribirlo: ${days(mask)}`);
  }
  assert.equal(translator('es').days(0x1f), 'de lunes a viernes', 'en español, como siempre');
  assert.equal(en('Carretera A-7'), 'A-7 road');
  assert.equal(en('Carretera TE-V-1121 (Teruel)'), 'TE-V-1121 road (Teruel)');
  for (const [text, mask] of [['Mon-Fri', 0x1f], ['Monday to Friday', 0x1f], ['weekdays', 0x1f], ['weekends', 0x60], ['Sat-Sun', 0x60],
    ['Saturdays and Sundays', 0x60], ['Mon,Wed,Fri', 0x15], ['Fri-Mon', 0x71], ['every day', 0x7f], ['on Tuesdays', 0x02]]) assert.equal(parseDays(text), mask, text);
  assert.deepEqual(provinceOption('Granada fires'), { place: 'Granada', fires: true });
  assert.deepEqual(provinceOption('fires in Granada'), { place: 'Granada', fires: true });
  assert.deepEqual(provinceOption('Granada no fires'), { place: 'Granada', fires: false });
  assert.equal(parseRoadRequest('the A-7 in Málaga').key, 'c-A7-malaga');
});
