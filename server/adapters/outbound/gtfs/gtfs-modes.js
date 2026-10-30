/** route_type GTFS (básico y extendido) → modo del dominio; null = no ferroviario (autobús, etc.). */
export function modeOf(routeType) {
  const n = Number(routeType);
  if (n === 0 || (n >= 900 && n < 1000)) return 'tranvia';
  if (n === 1 || (n >= 400 && n < 500)) return 'metro';
  if (n === 2 || (n >= 100 && n < 200)) return 'cercanias';
  if ([5, 6, 7, 12].includes(n) || (n >= 1300 && n < 1500)) return 'otros';
  return null;
}
