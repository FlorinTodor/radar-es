/**
 * route_type GTFS (básico y extendido) → modo del dominio; null = no ferroviario (autobús, etc.).
 * Con el fichero del NAP (`ficheroId`), las redes de NETWORK_MODE salen con su tipo, diga lo que diga route_type.
 */
export function modeOf(routeType, ficheroId = null) {
  const mode = gtfsMode(routeType);
  return mode && NETWORK_MODE.has(Number(ficheroId)) ? NETWORK_MODE.get(Number(ficheroId)) : mode;
}

function gtfsMode(routeType) {
  const n = Number(routeType);
  if (n === 0 || (n >= 900 && n < 1000)) return 'tranvia';
  if (n === 1 || (n >= 400 && n < 500)) return 'metro';
  if (n === 2 || (n >= 100 && n < 200)) return 'cercanias';
  if ([5, 6, 7, 12].includes(n) || (n >= 1300 && n < 1500)) return 'otros';
  return null;
}

/**
 * Redes de tranvía cuyo horario en el NAP declara alguna línea con otro tipo, y que salían en el mapa como
 * tren o metro: TRAM Baix (1329) da el T2 como tren (route_type 2, con «Description of Route» por
 * descripción) y TRAM d'Alacant (1167) su línea 4 como metro (route_type 1). Todas sus líneas ferroviarias
 * son tranvías; las de autobús, si un día las trajeran, siguen fuera (gtfsMode da null).
 * TRAM Besòs (1330) declara bien las suyas: va también para que la red de TRAM salga igual entera.
 */
export const NETWORK_MODE = new Map([[1329, 'tranvia'], [1330, 'tranvia'], [1167, 'tranvia']]);

/** Lo que se añade a la atribución de esas redes: su licencia pide decir qué se cambia de sus datos. */
export const modeFixNote = (ficheroId) => (NETWORK_MODE.has(Number(ficheroId))
  ? ' · Tipo de vehículo: todas sus líneas como tranvía (su horario declara alguna como tren o metro)' : '');
