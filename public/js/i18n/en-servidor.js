// Textos que escribe el servidor con sus propias palabras, en inglés: están en el dominio
// (server/domain/en-servidor.js), porque también los usa el bot de Telegram, y el servidor lo sirve tal cual
// al navegador en /server/domain/, como seguir.js. Aquí sólo se reexporta, para tx() de ../i18n.js y en.js.
export { EXACT, PATTERNS, VERBATIM_SOURCES } from '../../../server/domain/en-servidor.js';
