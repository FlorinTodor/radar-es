// Los avisos de Renfe de una estación (domain/avisos-estacion.js) para quien la sigue: su texto, tal cual lo
// publica su fuente, y que un mismo aviso no le llegue dos veces en la misma ronda (si además sigue la línea de la
// que habla, le llegaría por las dos). Puro: sólo texto.

/**
 * Un aviso con su título y su texto sin alterar (la licencia de Renfe lo pide): sólo se cambian los saltos de
 * línea de Windows («\r\n») por los normales y se quitan los espacios de los extremos.
 * @param {{ title?: string, description?: string }} e
 */
export function noticeText(e) {
  const text = String(e.description ?? '').replace(/\r\n?/g, '\n').trim();
  const title = String(e.title ?? '').trim();
  return text ? (title ? `${title}: ${text}` : text) : title;
}

/** El hecho de un aviso de la estación: su id es el del aviso, el mismo que tiene en su línea (avisos.js). */
export const stationNoticeFact = (e, credit) => ({ id: e.id, kind: 'aviso', text: noticeText(e), credit });

/**
 * Los hechos que aún no se le han contado a un chat en esta ronda: un aviso que ya va en el mensaje de otra cosa que
 * sigue (la estación y su línea) no se repite. Sólo los avisos: una cancelación se cuenta en cada cosa a la que
 * afecta, con lo que tiene de cada una (la hora en la estación). Apunta en `sent` los que deja.
 * @param {Array<{ id: string, kind: string }>} facts
 * @param {Set<string>} sent  los avisos ya contados a ese chat en esta ronda
 */
export function withoutRepeats(facts, sent) {
  return facts.filter((f) => {
    if (f.kind !== 'aviso') return true;
    if (sent.has(f.id)) return false;
    sent.add(f.id);
    return true;
  });
}
