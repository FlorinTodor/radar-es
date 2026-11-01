// DGT: incidencias de tráfico activas en carreteras (DATEX II v3.7, Punto de Acceso
// Nacional de Tráfico). ~1.000 situaciones y ~4 MB de XML: se lee cada 5 minutos.
import { arr, findKey, lookup, num, text, xmlParser } from './parse.js';

const URL_DGT = 'https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml';

const CAUSES = {
  accident: 'Accidente',
  vehicleObstruction: 'Vehículo detenido u obstáculo',
  roadMaintenance: 'Obras',
  obstruction: 'Obstáculo en la vía',
  abnormalTraffic: 'Retención',
  environmentalObstruction: 'Fenómeno meteorológico o ambiental',
  infrastructureDamageObstruction: 'Daños en la infraestructura',
  roadOrCarriagewayOrLaneManagement: 'Restricción de carriles',
  poorEnvironment: 'Condiciones adversas',
  equipmentOrSystemFault: 'Avería de equipamiento',
};

const SEVERITY = { highest: 'muy alta', high: 'alta', medium: 'media', low: 'baja', lowest: 'baja' };

function coords(p) {
  return p?.pointCoordinates ? { lat: num(p.pointCoordinates.latitude), lon: num(p.pointCoordinates.longitude) } : null;
}

function locate(record) {
  const loc = record.locationReference ?? {};
  const linear = loc.tpegLinearLocation;
  const fallback = findKey(loc, 'pointCoordinates');
  return {
    from: coords(linear?.from) ?? (fallback ? { lat: num(fallback.latitude), lon: num(fallback.longitude) } : null),
    to: coords(linear?.to),
  };
}

/**
 * Incidencias de un documento DATEX II de la DGT. Analizar sus ~4 MB de XML bloquea el hilo medio
 * segundo: es una función pura para poder hacerlo en un hilo de cálculo (workers/tasks.js).
 * @param {string} xml
 * @returns {import('../../../domain/model.js').SourceResult}
 */
export function parseDgt(xml) {
  const doc = xmlParser.parse(xml).payload ?? {};
  const events = [];
  for (const sit of arr(doc.situation)) {
    for (const r of arr(sit.situationRecord)) {
      const { from, to } = locate(r);
      if (!from?.lat || !from?.lon) continue;
      const cause = text(findKey(r.cause, 'causeType'));
      const detail = r.cause?.detailedCauseType ? Object.values(r.cause.detailedCauseType).map(text).find(Boolean) ?? null : null;
      const loc = r.locationReference;
      const road = text(findKey(loc, 'roadName'));
      const km = num(text(findKey(loc?.tpegLinearLocation?.from ?? loc, 'kilometerPoint')));
      const place = [text(findKey(loc, 'municipality')), text(findKey(loc, 'province'))].filter(Boolean).join(', ');
      const closed = text(r.roadOrCarriagewayOrLaneManagementType) === 'roadClosed';
      events.push({
        id: `dgt:${r['@_id'] ?? sit['@_id']}`,
        category: 'carretera',
        type: cause ?? 'otro',
        subtype: detail,
        severity: lookup(SEVERITY, text(r.severity)) ?? 'media',
        closed,
        title: `${lookup(CAUSES, cause) ?? cause ?? 'Incidencia'}${road ? ` · ${road}` : ''}${km !== null ? ` km ${km.toFixed(1)}` : ''}`,
        description: place + (closed ? ' · Carretera cortada' : ''),
        lat: from.lat,
        lon: from.lon,
        lat2: to?.lat ?? null,
        lon2: to?.lon ?? null,
        start: Date.parse(text(findKey(r.validity, 'overallStartTime'))) || null,
      });
    }
  }
  const published = Date.parse(text(doc.publicationTime));
  return { events, sourceTime: Number.isNaN(published) ? null : published };
}

/**
 * @param {{ http: import('../http/http-client.js').HttpClient, pool?: import('../workers/cpu-pool.js').CpuPool }} deps
 *   pool: hilos de cálculo para analizar el XML; sin él, en el hilo principal.
 */
export function createDgtSource({ http, pool }) {
  return {
    id: 'dgt',
    name: 'DGT incidencias de tráfico (DATEX II)',
    kind: 'events',
    interval: 300_000,
    url: URL_DGT,
    license: 'Fuente: DGT (Punto de Acceso Nacional de Tráfico y Movilidad, nap.dgt.es) · Creative Commons Attribution',
    async fetch() {
      const xml = await http.text(URL_DGT, { timeout: 60_000 });
      return pool ? pool.run('dgt', [xml]) : parseDgt(xml);
    },
  };
}
