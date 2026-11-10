// Los avisos de Renfe de una estación (domain/avisos-estacion.js) para quien la sigue: su texto, tal cual lo
// publica su fuente, y que un mismo aviso no le llegue dos veces en la misma ronda (si además sigue la línea de la
// que habla, le llegaría por las dos). Puro: sólo texto.
import { ES } from './idioma.js';

/**
 * Un aviso con su título y su texto sin alterar (la licencia de Renfe lo pide): sólo se cambian los saltos de
 * línea de Windows («\r\n») por los normales y se quitan los espacios de los extremos. El título por defecto
 * («Aviso Renfe», cuando el aviso no trae título) es nuestro: en otro idioma, con las plantillas de la web
 * (tr.server, como en los avisos de una línea); el de Renfe y su texto, tal cual.
 * @param {{ title?: string, description?: string, source?: string }} e
 * @param {import('./idioma.js').Translator} [tr]
 */
export function noticeText(e, tr = ES) {
  const text = String(e.description ?? '').replace(/\r\n?/g, '\n').trim();
  const title = String(tr.server(String(e.title ?? '').trim(), e.source) ?? '');
  return text ? (title ? `${title}: ${text}` : text) : title;
}

/** El hecho de un aviso de la estación: su id es el del aviso, el mismo que tiene en su línea (avisos.js). */
export const stationNoticeFact = (e, credit, tr = ES) => ({ id: e.id, kind: 'aviso', text: noticeText(e, tr), credit });

/**
 * Los hechos que aún no se le han contado a un chat en esta ronda: un aviso que ya va en el mensaje de otra cosa que
 * sigue (la estación y su línea) no se repite. Sólo los avisos: una cancelación se cuenta en cada cosa a la que
 * afecta, con lo que tiene de cada una (la hora en la estación). Apunta en `sent` los que deja.
 * @param {Array<{ id: string, kind: string }>} facts
 * @param {Set<string>} sent  los avisos ya contados a ese chat en esta ronda
 */
export function withoutRepeats(facts, sent) {
  return facts.filter((f) => {
    // Avisos de Renfe (estación y línea) y tráfico (carretera y provincia): el mismo, una vez por ronda.
    if (f.kind !== 'aviso' && f.kind !== 'carretera') return true;
    if (sent.has(f.id)) return false;
    sent.add(f.id);
    return true;
  });
}
