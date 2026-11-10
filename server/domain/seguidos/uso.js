// Cuánto se usa el bot, en conjunto: cuántos chats siguen algo, cuántas cosas y de qué tipo, cuántos piden el
// parte diario y qué es lo más seguido, con cuántos chats lo siguen; y los totales desde que se empezó a contar
// (altas, bajas, avisos y mensajes por orden), que se guardan con lo demás del bot y siguen tras cada arranque o
// relevo. Es lo que ve la monitorización (deploy/monitor/, panel «Bot de Telegram»): sin el número de ningún chat
// ni nada que diga quién sigue qué. Puro: sin red, ni reloj, ni disco.
import { followKind, isRoadKey } from '../seguir.js';
import { provinceById } from '../provincias.js';

/** Tipos de lo que se sigue, en el orden del panel: los de las claves `follow` (con los trayectos), las carreteras y
 * las provincias. */
export const USAGE_KINDS = Object.freeze(['servicio', 'linea', 'parada', 'trayecto', 'carretera', 'provincia']);
/** Lo más seguido que se enseña, como mucho (cada cosa es una serie en Prometheus). */
export const USAGE_TOP = 100;
/** Por qué deja un chat el bot: deja de seguirlo todo, escribe /baja o lo bloquea (o ya no existe). */
export const REMOVAL_REASONS = Object.freeze(['dejar', 'baja', 'bloqueo']);
/** Lo que manda el bot sin que se lo pidan: avisos de lo seguido y partes diarios. */
export const NOTICE_KINDS = Object.freeze(['aviso', 'parte']);
// Las órdenes son de una lista corta (ordenes.js, más «enlace», «boton» y «limite»); por si acaso, un tope.
const COMMAND_RE = /^[a-z]{1,20}$/;
const COMMANDS_MAX = 40;

/**
 * Los totales, a cero, desde `now`.
 * @returns {{ since: number, added: number, removed: Record<string, number>, notices: Record<string, number>,
 *   commands: Record<string, number> }}
 */
export function emptyTotals(now) {
  return {
    since: now,
    added: 0,
    removed: Object.fromEntries(REMOVAL_REASONS.map((r) => [r, 0])),
    notices: Object.fromEntries(NOTICE_KINDS.map((k) => [k, 0])),
    commands: {},
  };
}

/**
 * Cuenta algo en los totales (los cambia): `alta`, `baja` (detail: el motivo), `aviso` (detail: aviso o parte)
 * u `orden` (detail: cuál). Lo que no es de esas listas no se cuenta.
 */
export function countEvent(totals, event, detail = '') {
  if (event === 'alta') totals.added++;
  else if (event === 'baja' && REMOVAL_REASONS.includes(detail)) totals.removed[detail]++;
  else if (event === 'aviso' && NOTICE_KINDS.includes(detail)) totals.notices[detail]++;
  else if (event === 'orden' && COMMAND_RE.test(detail)) {
    // Object.hasOwn: «constructor» o «tostring» no son del objeto, aunque `in` diga que sí.
    const had = Object.hasOwn(totals.commands, detail);
    if (had || Object.keys(totals.commands).length < COMMANDS_MAX) totals.commands[detail] = (had ? totals.commands[detail] : 0) + 1;
  }
}

/** Los totales guardados, tal cual si están bien; lo que llegue mal se descarta (y sin nada, a cero desde `now`). */
export function parseTotals(saved, now) {
  const out = emptyTotals(Number.isSafeInteger(saved?.since) && saved.since > 0 ? saved.since : now);
  if (!saved || typeof saved !== 'object') return out;
  const n = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
  out.added = n(saved.added);
  for (const r of REMOVAL_REASONS) out.removed[r] = n(saved.removed?.[r]);
  for (const k of NOTICE_KINDS) out.notices[k] = n(saved.notices?.[k]);
  const commands = saved.commands && typeof saved.commands === 'object' ? Object.entries(saved.commands) : [];
  for (const [name, value] of commands.slice(0, COMMANDS_MAX)) {
    if (COMMAND_RE.test(name) && n(value)) out.commands[name] = n(value);
  }
  return out;
}

/**
 * @param {Iterable<{ subs: Map<string, { name: string, guessed?: boolean }>, provinces: Map<string, unknown>,
 *   digest: string|null }>} chats  Lo que sigue cada chat (los de follow-bot).
 * @param {{ top?: number }} [options]
 * @returns {{ chats: number, digest: number, follows: Record<string, number>, distinct: Record<string, number>,
 *   top: Array<{ kind: string, key: string, name: string, chats: number }> }}
 *   follows: cosas seguidas por tipo (una cosa que siguen tres chats cuenta tres); distinct: cosas distintas por
 *   tipo; top: las más seguidas, de más a menos chats (a igualdad, por tipo y nombre).
 */
export function usageOf(chats, { top = USAGE_TOP } = {}) {
  const follows = Object.fromEntries(USAGE_KINDS.map((k) => [k, 0]));
  const distinct = Object.fromEntries(USAGE_KINDS.map((k) => [k, 0]));
  /** @type {Map<string, { kind: string, key: string, name: string, chats: number, guessed: boolean }>} */
  const items = new Map();
  let total = 0;
  let digest = 0;
  const add = (kind, key, name, guessed) => {
    follows[kind]++;
    const item = items.get(key);
    if (!item) {
      distinct[kind]++;
      items.set(key, { kind, key, name, chats: 1, guessed });
      return;
    }
    item.chats++;
    // Cada chat guarda su nombre: mejor uno de verdad que uno provisional (de algo que se siguió sin verse).
    if (item.guessed && !guessed) Object.assign(item, { name, guessed: false });
  };
  for (const chat of chats) {
    total++;
    if (chat.digest) digest++;
    for (const [key, s] of chat.subs) {
      const kind = followKind(key) ?? (isRoadKey(key) ? 'carretera' : null);
      if (kind) add(kind, key, s.name, s.guessed === true);
    }
    for (const id of chat.provinces.keys()) add('provincia', `prov-${id}`, provinceById(id)?.name ?? id, false);
  }
  const order = (a, b) => b.chats - a.chats || USAGE_KINDS.indexOf(a.kind) - USAGE_KINDS.indexOf(b.kind)
    || a.name.localeCompare(b.name, 'es') || (a.key < b.key ? -1 : 1);
  return {
    chats: total,
    digest,
    follows,
    distinct,
    top: [...items.values()].sort(order).slice(0, Math.max(0, top)).map(({ kind, key, name, chats: n }) => ({ kind, key, name, chats: n })),
  };
}
