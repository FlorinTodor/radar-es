import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { EN, PARTS } from '../../public/js/i18n/en.js';
import { PATTERNS } from '../../public/js/i18n/en-servidor.js';
import { pickLang, t, tn, tx, useLang } from '../../public/js/i18n.js';

// La web en inglés: que no falte ninguna frase en el diccionario y que las traducciones lleven las mismas
// variables que el original. Las claves salen del propio código (t('…'), tn('…', '…')) y del HTML
// (data-i18n, data-i18n-attr y <title>), así una frase nueva sin traducir no pasa los tests.
const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const HTML_PAGES = ['index.html', 'el-dia-en-cifras.html'];

const jsFiles = (await readdir(`${PUBLIC}js`, { recursive: true }))
  .filter((f) => f.endsWith('.js') && f !== 'i18n.js' && !f.startsWith('i18n/') && !f.startsWith('i18n\\'));

// Un literal de JS: '…', "…" o `…` (sin ${}: las variables van entre llaves).
const LIT = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\x60(?:[^\x60\\]|\\.)*\x60`;
const unquote = (lit) => lit.slice(1, -1).replace(/\\(.)/g, (all, c) => ({ n: '\n', t: '\t' }[c] ?? c));

/** Las claves de un fichero de la web, con la línea en que salen. */
function keysOf(src) {
  const out = [];
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  for (const m of src.matchAll(new RegExp(String.raw`\btn\(\s*(${LIT})\s*,\s*(${LIT})`, 'g'))) {
    out.push([unquote(m[1]), lineOf(m.index)], [unquote(m[2]), lineOf(m.index)]);
  }
  for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*(${LIT})`, 'g'))) out.push([unquote(m[1]), lineOf(m.index)]);
  return out;
}

const varsOf = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const sources = await Promise.all(jsFiles.map(async (f) => [f, await readFile(`${PUBLIC}js/${f}`, 'utf8')]));

test('cada frase de la web que pasa por t() o tn() está en el diccionario inglés', () => {
  const missing = [];
  for (const [file, src] of sources) {
    for (const [key, line] of keysOf(src)) if (!(key in EN)) missing.push(`${file}:${line} «${key}»`);
  }
  assert.deepEqual(missing, []);
});

test('ninguna frase de t() lleva ${…}: las variables van entre llaves, si no la clave cambia cada vez', () => {
  const bad = [];
  for (const [file, src] of sources) {
    for (const [key, line] of keysOf(src)) if (key.includes('${')) bad.push(`${file}:${line}`);
  }
  assert.deepEqual(bad, []);
});

test('los ficheros que traducen no tapan t ni tn con una variable propia', () => {
  const bad = [];
  for (const [file, src] of sources) {
    if (!/from '\.\/i18n\.js'/.test(src)) continue;
    const shadow = /\b(?:const|let|var)\s+(?:t|tn)\s*=|[(,]\s*(?:t|tn)\s*(?:,|\)\s*=>)|\bfunction\s*\w*\s*\([^)]*\b(?:t|tn)\b[^)]*\)/;
    src.split('\n').forEach((l, i) => { if (shadow.test(l) && !l.includes('import')) bad.push(`${file}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(bad, []);
});

// Lo que el navegador da como innerHTML de un elemento: su contenido con los espacios juntados.
function htmlKeys(html) {
  const keys = [];
  const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
  if (title) keys.push(['<title>', title.replaceAll('&amp;', '&')]);
  for (const m of html.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const [open, tag, attrs] = m;
    for (const name of attrs.match(/\sdata-i18n-attr="([^"]+)"/)?.[1].split(/\s+/) ?? []) {
      const value = attrs.match(new RegExp(String.raw`\s${name}="([^"]*)"`))?.[1];
      if (value) keys.push([`${tag} ${name}`, value.replaceAll('&amp;', '&').replaceAll('&quot;', '"')]);
    }
    if (!/\sdata-i18n(?=\s|$)/.test(attrs)) continue;
    // Hasta su etiqueta de cierre, contando las del mismo tipo que haya dentro.
    const re = new RegExp(String.raw`<(/?)${tag}\b[^>]*>`, 'g');
    re.lastIndex = m.index + open.length;
    let depth = 1;
    let end = -1;
    for (let x; depth && (x = re.exec(html));) {
      depth += x[1] ? -1 : 1;
      if (!depth) end = x.index;
    }
    keys.push([`<${tag}>`, html.slice(m.index + open.length, end).replace(/\s+/g, ' ').trim()]);
  }
  return keys;
}

test('cada texto del HTML marcado para traducir está en el diccionario inglés', async () => {
  const missing = [];
  for (const page of HTML_PAGES) {
    const html = await readFile(`${PUBLIC}${page}`, 'utf8');
    for (const [where, key] of htmlKeys(html)) if (!(key in EN)) missing.push(`${page} ${where} «${key}»`);
  }
  assert.deepEqual(missing, []);
});

test('cada traducción lleva las mismas variables que la frase en español', () => {
  const bad = Object.entries(EN).filter(([es, en]) => typeof en !== 'string' || !en.trim() || varsOf(es).join() !== varsOf(en).join());
  assert.deepEqual(bad.map(([es]) => es), []);
});

test('una frase que sale en dos partes del diccionario se traduce igual en las dos', () => {
  const seen = new Map();
  const clash = [];
  for (const [part, dict] of Object.entries(PARTS)) {
    for (const [es, en] of Object.entries(dict)) {
      if (seen.has(es) && seen.get(es)[1] !== en) clash.push(`«${es}»: ${seen.get(es)[0]} y ${part}`);
      else seen.set(es, [part, en]);
    }
  }
  assert.deepEqual(clash, []);
});

test('los patrones de los textos del servidor encajan de principio a fin', () => {
  for (const [re] of PATTERNS) {
    assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `${re} sin ^…$: traduciría trozos de textos de las fuentes`);
  }
});

test('el idioma: español por defecto, el de la dirección antes que el guardado y nada raro', () => {
  assert.equal(pickLang('', null), 'es');
  assert.equal(pickLang('', 'en'), 'en');
  assert.equal(pickLang('?lang=en', null), 'en');
  assert.equal(pickLang('?lang=es', 'en'), 'es');
  assert.equal(pickLang('?lang=fr', null), 'es');
  assert.equal(pickLang('?lang=de', 'en'), 'en');
  assert.equal(pickLang('', 'xx'), 'es');
});

test('t, tn y tx: en español, igual; en inglés, del diccionario y con sus variables', async () => {
  assert.equal(t('Desde las {time}', { time: '10:00' }), 'Desde las 10:00');
  assert.equal(tn('{n} tren', '{n} trenes', 12345), '12.345 trenes');
  assert.equal(tx('Aviso Renfe · C1'), 'Aviso Renfe · C1');
  await useLang('en');
  try {
    const [es, en] = Object.entries(EN).find(([k]) => varsOf(k).length === 0);
    assert.equal(t(es), en);
    assert.equal(t('Una frase que no está'), 'Una frase que no está', 'lo que falta sale en español');
    assert.equal(tx('Un texto de una fuente'), 'Un texto de una fuente');
  } finally {
    await useLang('es');
  }
});
