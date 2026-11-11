// Los avisos de Renfe de una estación (domain/avisos-estacion.js) para quien la sigue: su texto, tal cual lo
// publica su fuente, y que un mismo aviso no le llegue dos veces en la misma ronda (si además sigue la línea de la
// que habla, le llegaría por las dos). Puro: sólo texto.
import { ES } from './idioma.js';
import { sourceText } from './texto.js';

/**
 * Un aviso con su título y su texto sin alterar (la licencia de Renfe lo pide), con sus saltos de línea (sourceText:
 * los de Windows, normales; los espacios de cada línea, juntados; como mucho una línea en blanco). El título por defecto
 * («Aviso Renfe», cuando el aviso no trae título) es nuestro: en otro idioma, con las plantillas de la web
 * (tr.server, como en los avisos de una línea); el de Renfe y su texto, tal cual.
 * @param {{ title?: string, description?: string, source?: string }} e
 * @param {import('./idioma.js').Translator} [tr]
 */
export function noticeText(e, tr = ES) {
  const text = sourceText(e.description);
  const title = String(tr.server(String(e.title ?? '').trim(), e.source) ?? '');
  return text ? (title ? `${title}: ${text}` : text) : title;
}

/** El hecho de un aviso de la estación: su id es el del aviso, el mismo que tiene en su línea (avisos.js). */
export const stationNoticeFact = (e, credit, tr = ES) => ({ id: e.id, kind: 'aviso', text: noticeText(e, tr), credit });

// Lo que es lo mismo aunque se cuente distinto en cada cosa seguida: un aviso de Renfe (en la estación y en su línea),
// una incidencia de tráfico (en la carretera y en la provincia) y el retraso de un tren (seguido por su número y en un
// trayecto, con su hora en el origen).
const ONCE_BY_ID = new Set(['aviso', 'carretera', 'retraso']);

/**
 * Los hechos que aún no se le han contado a un chat en esta ronda: lo que ya va en el mensaje de otra cosa que sigue
 * no se repite. Los avisos, el tráfico y los retrasos, por su id; una cancelación sí se cuenta en cada cosa a la que
 * afecta, con lo que tiene de cada una (la hora en la estación), salvo que el texto sea el mismo (dos trayectos con la
 * misma estación de origen y la misma cancelación). Apunta en `sent` los que deja.
 * @param {Array<{ id: string, kind: string, text?: string }>} facts
 * @param {Set<string>} sent  lo ya contado a ese chat en esta ronda
 */
export function withoutRepeats(facts, sent) {
  return facts.filter((f) => {
    const k = ONCE_BY_ID.has(f.kind) ? f.id : `${f.id}\n${f.text}`;
    if (sent.has(k)) return false;
    sent.add(k);
    return true;
  });
}
