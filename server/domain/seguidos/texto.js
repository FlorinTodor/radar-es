// Recortes de texto para los mensajes del bot sin partir un carácter: un emoji o cualquier carácter fuera del
// plano básico son dos unidades UTF-16 (un par sustituto) y, cortado entre las dos, deja un texto que no es
// UTF-8 válido (Telegram rechaza el mensaje entero). Puro: sólo texto.

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

/**
 * El texto tal cual si cabe en `max` unidades UTF-16 (lo que mide `length`); si no, recortado sin partir un
 * par sustituto, sin espacios al final y con `ellipsis` (que cuenta dentro de `max`).
 * @param {string} text  @param {number} max  @param {string} [ellipsis]
 */
export function cutText(text, max, ellipsis = '…') {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  let end = Math.max(0, max - ellipsis.length);
  if (end > 0 && isHigh(t.charCodeAt(end - 1)) && isLow(t.charCodeAt(end))) end--;
  return `${t.slice(0, end).trimEnd()}${ellipsis}`;
}
