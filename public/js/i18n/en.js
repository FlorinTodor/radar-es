// Diccionario inglés: frase en español → en inglés. Va repartido por partes de la web para que cada una
// se pueda revisar por separado; una misma frase en dos partes tiene que traducirse igual (lo comprueba
// test/public/i18n.test.js). Sólo lo descarga quien ve la web en inglés (ver ../i18n.js).
import web from './en-web.js';
import mapa from './en-mapa.js';
import fichas from './en-fichas.js';
import dia from './en-dia.js';
import { EXACT as servidor } from './en-servidor.js';

export const PARTS = { web, mapa, fichas, dia, servidor };
export const EN = Object.assign({}, ...Object.values(PARTS));
