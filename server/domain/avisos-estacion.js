// Los avisos de Renfe de una estación (ascensores fuera de servicio, accesos cerrados…): los que su fuente sitúa
// en ella. Renfe da en cada aviso la estación de la que trata y el aviso lleva sus coordenadas; los de Rodalies,
// las de la primera estación que nombra su texto. Lo usan la ficha de la estación en la web
// (public/js/station-board.js, y con ella el servidor MCP) y el bot de Telegram al seguir una estación: así los
// dos cuentan los mismos. Puro y sin importar nada: el navegador lo carga tal cual (/server/domain/, ver
// SHARED_DOMAIN_MODULES en http-server.js).

/** Un aviso es de la estación si está a menos de esto (km): llega con las coordenadas de la estación. */
export const NOTICE_KM = 0.3;

const km = (aLat, aLon, bLat, bLon) => Math.hypot((aLat - bLat) * 110.54, (aLon - bLon) * 111.32 * Math.cos((aLat * Math.PI) / 180));
/** El texto de un aviso para compararlo: sin mayúsculas ni espacios de más. */
const sameText = (e) => String(e.description ?? e.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Los avisos ferroviarios de una estación de Renfe, una vez cada texto (Renfe publica a veces el mismo aviso
 * dos veces, con otro id). Las estaciones de otras redes (metro, tranvía…: llevan `network`) no tienen: los
 * avisos de Renfe son de sus estaciones.
 * @param {{ lat: number, lon: number, network?: string, networkId?: string }|null} station
 * @param {object[]} events  los sucesos en vigor
 * @returns {object[]}  los avisos, en el orden en que llegan
 */
export function noticesAtStation(station, events) {
  if (!station || station.network || station.networkId || !Number.isFinite(station.lat) || !Number.isFinite(station.lon)) return [];
  const out = [];
  const texts = new Set();
  for (const e of events ?? []) {
    if (e?.category !== 'ferroviario' || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    if (km(station.lat, station.lon, e.lat, e.lon) > NOTICE_KM) continue;
    const text = sameText(e);
    if (texts.has(text)) continue;
    texts.add(text);
    out.push(e);
  }
  return out;
}
