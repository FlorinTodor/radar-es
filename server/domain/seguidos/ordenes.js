// Las órdenes del bot «Sigue tu tren» y los textos fijos que contesta. Puro: sólo texto.

/** Lo que se lee de un mensaje: más que esto no es una orden ni una búsqueda razonable. */
export const INPUT_MAX = 200;

/** Órdenes, con su descripción para el menú del bot (setMyCommands): el mismo orden que la ayuda. */
export const COMMANDS = [
  ['seguir', 'Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid'],
  ['estado', 'Cómo va ahora lo que sigues, o lo que busques'],
  ['provincia', 'Avisos de tu provincia: AEMET, terremotos y emergencias'],
  ['mis', 'Lo que sigues'],
  ['dejar', 'Dejar de seguir algo'],
  ['parte', 'Un resumen cada día a la hora que digas: /parte 07:30'],
  ['datos', 'Qué guardo de este chat'],
  ['baja', 'Borrar todo lo de este chat'],
  ['ayuda', 'Cómo funciona'],
];

const ALIASES = { help: 'ayuda', start: 'start', borrar: 'baja', stop: 'baja', misavisos: 'mis', lista: 'mis' };
const KNOWN = new Set(['start', ...COMMANDS.map(([c]) => c)]);

/**
 * Qué pide un mensaje: una orden con su argumento («/seguir C4 Madrid», «/seguir@RadarBot C4») o, si es texto
 * sin orden, una búsqueda (`buscar`).
 * @param {string} text
 * @returns {{ command: string, arg: string }}  command: el de COMMANDS, 'start', 'buscar' o 'desconocida'
 */
export function parseCommand(text) {
  const t = String(text ?? '').slice(0, INPUT_MAX).trim();
  const m = /^\/([A-Za-z_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(t);
  if (!m) return { command: t ? 'buscar' : 'ayuda', arg: t };
  const name = m[1].toLowerCase();
  const command = ALIASES[name] ?? (KNOWN.has(name) ? name : 'desconocida');
  return { command, arg: (m[2] ?? '').replace(/\s+/g, ' ').trim() };
}

/** ¿Es «HH:MM» (o «7:30», «0730») una hora válida? La devuelve como «HH:MM»; si no, null. */
export function parseHour(text) {
  const m = /^(\d{1,2})[:.h]?(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

export function helpText({ webUrl, limits }) {
  return [
    'Te aviso de lo que sigas: cualquier tren, autobús, metro o tranvía que publique el radar, su línea o una estación, y los avisos de tu provincia.',
    'Órdenes:',
    COMMANDS.map(([c, d]) => `/${c}: ${d}`).join('\n'),
    'También puedes escribirme sin orden lo que buscas («08058», «C4 Madrid», «27 EMT Málaga»).',
    `Desde la web, en la ficha de un vehículo o de una estación, el botón «Avísame por Telegram» lo sigue directamente: ${webUrl}`,
    `Avisos: si se cancela o se suprimen paradas, si va con ${limits.delayMin} min de retraso o más (y otra vez si empeora), si su operador deja de publicarlo y los avisos del operador sobre su línea. Puedes seguir hasta ${limits.subsPerChat} cosas.`,
    'Los datos son los que publican los operadores y organismos: el radar no es oficial y puede fallar. No lo uses para decisiones de seguridad.',
  ].join('\n\n');
}

export function welcomeText({ webUrl, limits }) {
  return `Hola. Soy el bot de Radar España.\n\n${helpText({ webUrl, limits })}`;
}

/**
 * Lo que se guarda de un chat, para /datos.
 * @param {{ id: number|string, since: number, subs: Array<{ name: string }>, provinces: Array<{ name: string }>, digest: string|null }|null} chat
 */
export function dataText(chat, { fmtWhen }) {
  if (!chat) {
    return 'De este chat no guardo nada: no sigues nada. Si sigues algo, guardaré el número de este chat, lo que sigues y desde cuándo; nada más (ni tu nombre ni tu teléfono). Se borra todo con /baja.';
  }
  return [
    'Esto es todo lo que guardo de este chat:',
    `- Número del chat: ${chat.id}`,
    `- Desde: ${fmtWhen(chat.since)}`,
    `- Lo que sigues: ${chat.subs.length ? chat.subs.map((s) => s.name).join('; ') : 'nada'}`,
    `- Provincias: ${chat.provinces.length ? chat.provinces.map((p) => p.name).join(', ') : 'ninguna'}`,
    `- Parte diario: ${chat.digest ?? 'no'}`,
    'Nada más: ni tu nombre, ni tu usuario, ni tu teléfono. Lo uso sólo para avisarte y se borra con /baja (también si bloqueas el bot). Telegram, que transporta los mensajes, tiene su propia política de privacidad.',
  ].join('\n');
}
