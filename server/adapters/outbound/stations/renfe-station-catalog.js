// Catálogo de estaciones de Renfe a partir de sus datos abiertos (CC BY 4.0, "Origen de los
// datos: Renfe Operadora"): la lista oficial de estaciones (coordenadas, población) y, para
// tener los nombres bien escritos, las paradas de sus GTFS de Cercanías y de AV/LD/MD.
// Los códigos coinciden con los stopId del GTFS-RT. Se refresca una vez al día.
import { distanceKm } from '../../../domain/geo.js';
import { csvRows, openGtfs } from '../gtfs/gtfs-reader.js';
import { RETIRED_PHOTOS_VERSION, loadStationExtras, padCode, wheelchair } from './station-extras.js';
import { createStationStore } from './station-store.js';

const REFRESH_MS = 24 * 3600_000;
// Si algo ha fallado al rehacerlo (Wikidata, Commons, un GTFS), se vuelve a intentar a la hora y no
// al día siguiente: mientras, se usa lo que sí se ha conseguido.
const RETRY_MS = 3600_000;
export const RENFE_FILES = {
  stations: 'https://ssl.renfe.com/ftransit/Fichero_estaciones/estaciones.csv',
  cercanias: 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
  largaDistancia: 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
};

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s(/'-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

const plainName = (s) => s.normalize('NFD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/**
 * La lista oficial trae algunas estaciones repetidas que no salen en ningún horario: la misma con
 * otro código y el nombre escrito de otra forma («Madrid - Atocha Cercanías» y «Madrid-Atocha
 * Cercanías», a 12 m) y las paradas de los trenes turísticos (códigos 99…, «Oviedo-Tur») pegadas a
 * la estación normal. En el mapa salían como dos puntos. Se quitan las que no tienen horarios y
 * tienen al lado otra que sí; las estaciones distintas que están cerca (Bilbao Concordia y Abando)
 * se quedan.
 */
export function withoutDuplicates(stations, scheduled) {
  const withTimes = stations.filter((s) => scheduled.has(s.code));
  const duplicate = (s) => withTimes.some((o) => {
    const km = distanceKm(s.lat, s.lon, o.lat, o.lon);
    return (km < 1 && plainName(o.name) === plainName(s.name)) || (km < 0.3 && s.code.startsWith('99'));
  });
  return stations.filter((s) => scheduled.has(s.code) || !duplicate(s));
}

/**
 * Añade a cada estación lo que haya de otras fuentes (station-extras.js). La accesibilidad de Renfe
 * manda; la de Wikidata sólo cubre las estaciones de las que Renfe no dice nada. Cada dato lleva su
 * fuente.
 */
export function withExtras(stations, extras) {
  return stations.map((s) => {
    const { accessible, ...more } = extras.get(s.code) ?? {};
    const fromWikidata = s.accessible === null && accessible !== undefined;
    return {
      ...s,
      accessible: fromWikidata ? accessible : s.accessible,
      accessibleSource: fromWikidata ? 'Wikidata' : s.accessible === null ? null : 'Renfe',
      ...more,
    };
  });
}

/** CSV de Renfe: separado por ';', cada campo entre comillas y en Latin-1. */
function* semicolonRows(bytes) {
  const split = (line) => line.split(';').map((c) => c.trim().replace(/^"|"$/g, ''));
  const [header, ...lines] = new TextDecoder('latin1').decode(bytes).split(/\r?\n/).filter((l) => l.trim()).map(split);
  for (const cells of lines) yield Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
}

/**
 * @param {{ cache: ReturnType<typeof import('../http/file-cache.js').createFileCache>, cacheDir: URL,
 *           log: import('../../../application/ports.js').LoggerPort, now?: () => number }} deps
 *   now: reloj con el que se fecha y se renueva la copia (para los tests).
 * @returns {import('../../../application/ports.js').StationCatalogPort}
 */
export function createRenfeStationCatalog({ cache, cacheDir, log, now = Date.now }) {
  // v3: con dirección, provincia, ancho métrico, accesibilidad y los datos de Wikidata y Commons
  // (las cachés anteriores no los tienen).
  const cacheFile = new URL('renfe-stations-v3.json', cacheDir);
  // Versión de lo que se calcula: si cambia, se recalcula aunque la caché sea de hoy; mientras, se
  // enseña la anterior. 4: fotos de Commons también para las estaciones que Wikidata no tiene.
  // 5: autor como pide cada foto (Attribution), sin fotos sólo GFDL ni sin autor si la licencia lo exige.
  // 6: todas las fotos de Wikidata y candidatas en orden, sin derechos de imagen ni fotos repetidas dudosas.
  // 7: lista de fotos retiradas; su huella va detrás, así que retirar una foto también recalcula.
  const CATALOG_VERSION = `7-${RETIRED_PHOTOS_VERSION}`;

  async function download(log) {
    // Paradas de los GTFS oficiales: nombres bien escritos y estaciones que faltan en la lista
    // (muchas de Cercanías sólo están ahí).
    const gtfsStops = new Map();
    for (const [url, cercanias] of [[RENFE_FILES.largaDistancia, false], [RENFE_FILES.cercanias, true]]) {
      try {
        const files = await openGtfs(await cache.bytes(url, `renfe-${url.split('/').at(-1)}`, REFRESH_MS), ['stops.txt']);
        for (const s of csvRows(files['stops.txt'])) {
          const code = padCode(s.stop_id);
          if (!gtfsStops.has(code)) {
            gtfsStops.set(code, { name: s.stop_name, lat: Number(s.stop_lat), lon: Number(s.stop_lon), cercanias, accessible: wheelchair(s.wheelchair_boarding) });
          }
        }
      } catch (err) {
        log.warn(`[estaciones] ${url}: ${err.message}`);
      }
    }
    const list = new Map();
    for (const r of semicolonRows(await cache.bytes(RENFE_FILES.stations, 'renfe-estaciones.csv', REFRESH_MS))) {
      const lat = Number(r.LATITUD);
      const lon = Number(r.LONGITUD);
      if (!r.CODIGO || !Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) continue;
      const code = padCode(r.CODIGO);
      list.set(code, {
        code,
        name: gtfsStops.get(code)?.name ?? titleCase(r.DESCRIPCION),
        place: r.POBLACION ? titleCase(r.POBLACION) : null,
        province: r.PROVINCIA ? titleCase(r.PROVINCIA) : null,
        address: r.DIRECION ? r.DIRECION.replace(/\s+/g, ' ') : null,
        postalCode: r.CP || null,
        lat,
        lon,
        cercanias: r.CERCANIAS === 'SI',
        metricGauge: r['ANCHO MÉTRICO'] === 'SI',
        accessible: gtfsStops.get(code)?.accessible ?? null,
      });
    }
    for (const [code, s] of gtfsStops) {
      if (!list.has(code) && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        list.set(code, { code, name: s.name, place: null, province: null, address: null, postalCode: null, lat: s.lat, lon: s.lon, cercanias: s.cercanias, metricGauge: false, accessible: s.accessible });
      }
    }
    const stations = withoutDuplicates([...list.values()], new Set(gtfsStops.keys()));
    const complete = withExtras(stations, await loadStationExtras({ cache, log, maxAgeMs: REFRESH_MS, stations }));
    // La ficha cita la fuente y la fecha de sus datos, como pide la licencia de Renfe.
    const source = { credit: 'Origen de los datos: Renfe Operadora', downloaded: new Date(now()).toISOString() };
    for (const s of complete) s.source = source;
    return complete;
  }

  // Cualquier aviso mientras se rehace quiere decir que falta algo (fotos, fichas, nombres): se
  // reintenta a la hora. Recalcular son minutos (Wikidata, las fotos de Commons, las fichas de Renfe)
  // y el servidor no escucha hasta que hay estaciones: con una copia guardada, aunque sea de otra
  // versión o de hace días, se arranca con ella y se recalcula detrás. Sólo se espera si no hay ninguna.
  const store = createStationStore({
    cacheFile, cacheDir, version: CATALOG_VERSION, refreshMs: REFRESH_MS, retryMs: RETRY_MS, log, now, download,
    waitIfEmpty: true,
    saved: (count) => `[estaciones] ${count} estaciones de Renfe (lista oficial + paradas GTFS)`,
    failed: (err, count) => `[estaciones] no se pudo descargar el catálogo (${err.message}); ${count} en caché`,
  });
  /** @type {Map<string, import('../../../domain/model.js').Station & { cercanias: boolean }>} */
  const { stations } = store;

  return {
    load: store.load,

    get: (code) => (code ? stations.get(padCode(code)) : undefined),

    name(code) {
      if (!code) return null;
      return stations.get(padCode(code))?.name ?? `Estación ${code}`;
    },

    nearest: store.nearest,

    all: () => [...stations.values()],
  };
}
