// Idioma de la web: español por defecto; inglés si se elige con el interruptor ES/EN o si la dirección lleva
// ?lang=en (así se enlaza la web en inglés, p. ej. desde /en). Lo elegido se guarda en este navegador, para que
// siga en inglés al pasar del mapa a «El día en cifras» y al volver otro día.
//
// Se traduce lo que escribe Radar España: botones, pestañas, fichas, avisos del motor de alertas, fechas y
// números. Se deja tal cual lo que no es nuestro:
// - los nombres (estaciones, líneas, operadores, redes, lugares) y los textos que publica cada fuente (avisos
//   de Renfe, de AEMET, de protección civil, motivos de las cancelaciones…): varias licencias piden no alterar
//   su contenido, y un nombre traducido ya no es el que se ve en la estación;
// - las atribuciones que piden las licencias con unas palabras concretas («Origen de los datos: Renfe
//   Operadora», «© AEMET», «Powered by MITRAMS»…).
//
// Las claves del diccionario son las frases en español tal y como están en el código: con el idioma en
// español, t() las devuelve igual, y una frase que falte en el diccionario inglés sale en español (el test
// test/public/i18n.test.js comprueba que no falte ninguna). Las variables van entre llaves: t('Hace {n} min', { n }).
// Cambiar de idioma recarga la página (en el mismo punto del mapa, ver app.js): así cada módulo pinta ya en
// su idioma y no hay que volver a pintarlo todo.

export const LANG_KEY = 'radar-es:idioma';
export const LANGS = ['es', 'en'];

/** El idioma de esta visita: el de la dirección (?lang=en|es), el guardado o, si no, español. */
export function pickLang(search, stored) {
  let asked = null;
  try {
    asked = new URLSearchParams(search ?? '').get('lang');
  } catch { /* dirección rara: se ignora */ }
  if (LANGS.includes(asked)) return asked;
  return LANGS.includes(stored) ? stored : 'es';
}

function storedLang() {
  try {
    return globalThis.localStorage?.getItem(LANG_KEY) ?? null;
  } catch {
    return null; // almacenamiento bloqueado: español, o lo que diga la dirección
  }
}

const inBrowser = typeof document !== 'undefined' && typeof location !== 'undefined';
let current = inBrowser ? pickLang(location.search, storedLang()) : 'es';
if (inBrowser && current !== storedLang() && new URLSearchParams(location.search).has('lang')) {
  try {
    localStorage.setItem(LANG_KEY, current); // el de la dirección se queda para las páginas siguientes
  } catch { /* almacenamiento bloqueado: sólo esta página */ }
}
// El diccionario inglés sólo se descarga si hace falta: quien ve la web en español no lo baja.
let dict = current === 'en' ? (await import('./i18n/en.js')).EN : null;

/** 'es' o 'en'. */
export const lang = () => current;
/** Para los Intl.*Format: fechas y números a la manera de cada idioma (en inglés, día/mes y 24 h, como en Europa). */
export const locale = () => (current === 'en' ? 'en-GB' : 'es-ES');

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (all, k) => (k in params ? String(params[k] ?? '') : all)) : text);

/** La frase en el idioma de la web, con sus {variables} puestas. */
export function t(es, params) {
  return fill((dict && dict[es]) ?? es, params);
}

/** Singular o plural según n: tn('{n} tren', '{n} trenes', n). {n} lleva el número ya formateado. */
export function tn(one, other, n, params = {}) {
  return t(n === 1 ? one : other, { n: new Intl.NumberFormat(locale()).format(n), ...params });
}

/**
 * Textos que llegan escritos por el servidor (títulos de las alertas, de las incidencias de tráfico, de las
 * cancelaciones…). Sólo se traduce lo que escribe Radar España con sus propias palabras, por patrones que
 * conocen su forma exacta; los nombres y lo que publica la fuente que vayan dentro se quedan igual. Lo que
 * no encaja con ningún patrón (un aviso de Renfe, de AEMET…) se devuelve tal cual, y lo de las fuentes cuya
 * licencia pide no alterar su contenido aunque se parezca a lo nuestro (`source`, ver VERBATIM_SOURCES), también.
 */
export function tx(text, source = null) {
  if (!dict || typeof text !== 'string' || !text || verbatimSources.has(source)) return text;
  if (dict[text]) return dict[text];
  for (const [re, to] of serverPatterns) {
    if (re.test(text)) return text.replace(re, to);
  }
  return text;
}
let { PATTERNS: serverPatterns = [], VERBATIM_SOURCES: verbatimSources = new Set() } = dict ? await import('./i18n/en-servidor.js') : {};

/** Sólo para los tests: pinta en otro idioma sin navegador. */
export async function useLang(l) {
  current = LANGS.includes(l) ? l : 'es';
  dict = current === 'en' ? (await import('./i18n/en.js')).EN : null;
  ({ PATTERNS: serverPatterns = [], VERBATIM_SOURCES: verbatimSources = new Set() } = current === 'en' ? await import('./i18n/en-servidor.js') : {});
}

/**
 * Traduce lo que viene escrito en el HTML: el texto de los elementos con data-i18n (su contenido, con las
 * etiquetas que lleve y los espacios juntados, es la clave) y los atributos que diga data-i18n-attr
 * («title aria-label placeholder»). Además el título de la página y su <html lang>.
 */
export function translatePage(root = document) {
  if (!dict) return;
  document.documentElement.lang = 'en';
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.innerHTML.replace(/\s+/g, ' ').trim();
    if (dict[key]) el.innerHTML = dict[key];
  }
  for (const el of root.querySelectorAll('[data-i18n-attr]')) {
    for (const name of el.dataset.i18nAttr.split(/\s+/).filter(Boolean)) {
      const value = el.getAttribute(name);
      if (value && dict[value]) el.setAttribute(name, dict[value]);
    }
  }
  if (dict[document.title]) document.title = dict[document.title];
}

/**
 * Cambia de idioma: lo guarda en este navegador y recarga sin ?lang (si no se puede guardar, con ?lang).
 * `before` guarda lo que haga falta para volver al mismo punto (app.js: el encuadre del mapa y la pestaña).
 */
export function switchLang(to, before) {
  if (!LANGS.includes(to) || to === current) return;
  before?.();
  const url = new URL(location.href);
  url.searchParams.delete('lang');
  try {
    localStorage.setItem(LANG_KEY, to);
  } catch {
    url.searchParams.set('lang', to);
  }
  location.replace(url.href);
}

/** Los botones ES/EN de la página (`.lang-switch` con un botón por idioma, data-lang): marcan el actual y cambian al pulsarlos. */
export function mountLangSwitch(before) {
  for (const box of document.querySelectorAll('.lang-switch')) {
    for (const b of box.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === current));
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-lang]');
      if (b) switchLang(b.dataset.lang, before);
    });
  }
}

if (inBrowser) {
  translatePage();
  // Lo oculta idioma.js mientras se traduce, para que no se vea primero en español (ver style.css).
  document.documentElement.classList.remove('i18n-wait');
}
