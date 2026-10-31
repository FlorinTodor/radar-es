// Reglas de alerta. Cada regla es una función pura (contexto) => Alert[].
// Para añadir una nueva: escribirla aquí y añadirla a RULES.
//
// Son heurísticas sobre datos públicos con decenas de segundos de latencia: sirven
// para vigilar y dar contexto, no para decisiones de seguridad operativa.
import { distanceKm, pointInGeometry } from '../geo.js';
import { vehicleLabel } from '../model.js';
import { stationarySince } from '../tracking.js';

/**
 * @typedef {object} RuleContext
 * @property {number} now
 * @property {import('../model.js').Vehicle[]} vehicles  Sólo trenes, metros y tranvías con GPS.
 * @property {Map<string, import('../tracking.js').TrackPoint[]>} tracks
 * @property {import('../model.js').IncidentEvent[]} events
 * @property {Record<string, any>} metrics
 * @property {Array<{id: string, name: string, kind: string, enabled: boolean, ok: boolean|null, lastOk: number|null, interval: number, sourceTime: number|null, error: string|null}>} health
 * @property {{ vehicles: number }} kpis
 * @property {Array<{ t: number, vehicles: number }>} kpiHistory
 * @property {(lat: number, lon: number) => { station: import('../model.js').Station, km: number } | null} nearestStation
 * @property {typeof import('./thresholds.js').DEFAULT_THRESHOLDS} thresholds
 * @property {StoppedVehicle[]} [stopped]
 *
 * @typedef {{ v: import('../model.js').Vehicle, minutes: number, near: { station: import('../model.js').Station, km: number } | null }} StoppedVehicle
 */

const madridTime = (ms) => new Date(ms).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });

/** Trenes sin moverse fuera de estación. Calcula `ctx.stopped`, que usa la regla de bloqueos. */
export function stoppedOutsideStation(ctx) {
  const { now, vehicles, tracks, nearestStation, thresholds: th } = ctx;
  const alerts = [];
  ctx.stopped = [];
  for (const v of vehicles) {
    const track = tracks.get(v.id);
    if (!track?.length) continue;

    // Con hora de GPS podemos distinguir "parado" de "sin señal".
    if (v.fixTime && now - v.fixTime > th.staleFixMinutes * 60_000) {
      const near = nearestStation(v.lat, v.lon);
      if (!near || near.km > th.awayFromStationKm) {
        alerts.push({
          id: `sin-gps:${v.id}`, type: 'sin-gps', severity: 'baja', vehicleId: v.id, lat: v.lat, lon: v.lon,
          title: `${vehicleLabel(v)} sin posición actualizada`,
          description: `Último GPS hace ${Math.round((now - v.fixTime) / 60_000)} min, fuera de estación` +
            `${near ? ` (a ${near.km.toFixed(1)} km de ${near.station.name})` : ''}.`,
        });
      }
      continue;
    }

    const minutes = (now - stationarySince(track, th.stoppedRadiusKm)) / 60_000;
    if (minutes < th.stoppedMinutes) continue;
    const near = nearestStation(v.lat, v.lon);
    if (near && near.km <= th.awayFromStationKm) continue;

    ctx.stopped.push({ v, minutes, near });
    alerts.push({
      id: `detenido:${v.id}`, type: 'detenido', vehicleId: v.id, lat: v.lat, lon: v.lon,
      severity: minutes >= 20 ? 'alta' : 'media',
      title: `${vehicleLabel(v)} detenido en plena vía`,
      description: `Sin moverse desde hace ${Math.round(minutes)} min${near ? `, a ${near.km.toFixed(1)} km de ${near.station.name}` : ''}. ` +
        (v.fixTime ? '' : 'Esta fuente no publica la hora del GPS: también puede ser una posición congelada. ') +
        `${v.origin ?? '?'} → ${v.destination ?? '?'}.`,
    });
  }
  return alerts;
}

/** Varios trenes detenidos cerca entre sí: posible corte de vía o accidente. */
export function stoppedClusters(ctx) {
  const stopped = ctx.stopped ?? [];
  const used = new Set();
  const alerts = [];
  for (const a of stopped) {
    if (used.has(a.v.id)) continue;
    const group = stopped.filter((b) => !used.has(b.v.id) && distanceKm(a.v.lat, a.v.lon, b.v.lat, b.v.lon) <= ctx.thresholds.clusterKm);
    if (group.length < 2) continue;
    group.forEach((g) => used.add(g.v.id));
    const lat = group.reduce((s, g) => s + g.v.lat, 0) / group.length;
    const lon = group.reduce((s, g) => s + g.v.lon, 0) / group.length;
    const near = ctx.nearestStation(lat, lon);
    alerts.push({
      id: `bloqueo:${group.map((g) => g.v.id).sort().join('+')}`, type: 'bloqueo', severity: 'muy alta', lat, lon,
      vehicleIds: group.map((g) => g.v.id),
      title: `${group.length} trenes detenidos cerca${near ? ` de ${near.station.name}` : ''}`,
      description: `Posible corte o incidencia en la vía: ${group.map((g) => `${vehicleLabel(g.v)} (${Math.round(g.minutes)} min)`).join(', ')}.`,
    });
  }
  return alerts;
}

export function largeDelays(ctx) {
  const th = ctx.thresholds;
  return ctx.vehicles
    .filter((v) => v.delay !== null && v.delay !== undefined && v.delay >= th.delayMedium)
    .map((v) => ({
      id: `retraso:${v.id}`, type: 'retraso', vehicleId: v.id, lat: v.lat, lon: v.lon,
      severity: v.delay >= th.delayHigh ? 'alta' : 'media',
      title: `${vehicleLabel(v)} con ${v.delay} min de retraso`,
      description: `${v.origin ?? '?'} → ${v.destination ?? '?'}.${v.next ? ` Próxima parada: ${v.next}.` : v.current ? ` En ${v.current}.` : ''}`,
    }));
}

/** Subida brusca del retraso: suele indicar una incidencia en ruta. */
export function delayJumps(ctx) {
  const th = ctx.thresholds;
  const windowStart = ctx.now - th.delayJumpWindowMin * 60_000;
  const alerts = [];
  for (const v of ctx.vehicles) {
    if (v.delay === null || v.delay === undefined) continue;
    const before = (ctx.tracks.get(v.id) ?? []).find((p) => p.t >= windowStart && p.delay !== null && p.delay !== undefined);
    if (!before || v.delay - before.delay < th.delayJumpMinutes) continue;
    alerts.push({
      id: `salto-retraso:${v.id}`, type: 'salto-retraso', vehicleId: v.id, lat: v.lat, lon: v.lon, severity: 'alta',
      title: `${vehicleLabel(v)}: el retraso sube ${v.delay - before.delay} min de golpe`,
      description: `De ${before.delay} a ${v.delay} min en menos de ${th.delayJumpWindowMin} min.`,
    });
  }
  return alerts;
}

export function earthquakesNearTrains(ctx) {
  const th = ctx.thresholds;
  const alerts = [];
  for (const e of ctx.events) {
    if (e.category !== 'sismo' || !(e.magnitude >= th.quakeMinMagnitude)) continue;
    if (!e.start || ctx.now - e.start > th.quakeWindowHours * 3600_000) continue;
    const radius = 25 * (e.magnitude - 2); // M3.5 → 37 km, M5 → 75 km
    const near = ctx.vehicles.filter((v) => distanceKm(e.lat, e.lon, v.lat, v.lon) <= radius);
    alerts.push({
      id: `sismo:${e.id}`, type: 'sismo', lat: e.lat, lon: e.lon, eventIds: [e.id],
      severity: e.magnitude >= 4.5 ? 'muy alta' : near.length ? 'alta' : 'media',
      vehicleIds: near.map((v) => v.id),
      title: e.title,
      description: near.length ? `${near.length} trenes en un radio de ${Math.round(radius)} km.` : `Sin trenes en un radio de ${Math.round(radius)} km.`,
    });
  }
  return alerts;
}

/** Avisos naranja o rojo; si traen polígono, se cuentan los trenes que circulan dentro. */
export function severeWeather(ctx) {
  const alerts = [];
  for (const e of ctx.events) {
    if (e.category !== 'meteo' || (e.level !== 'rojo' && e.level !== 'naranja')) continue;
    if (e.start && e.start > ctx.now) continue; // aún no ha empezado
    const inside = e.geometry ? ctx.vehicles.filter((v) => pointInGeometry(v.lon, v.lat, e.geometry)) : [];
    alerts.push({
      id: `meteo:${e.id}`, type: 'meteo', severity: e.level === 'rojo' ? 'muy alta' : 'alta', eventIds: [e.id],
      lat: e.lat ?? undefined, lon: e.lon ?? undefined,
      vehicleIds: inside.map((v) => v.id),
      title: inside.length ? `${e.title} · ${inside.length} trenes dentro` : e.title,
      description: [
        e.description,
        inside.length ? `Trenes en la zona: ${inside.slice(0, 8).map(vehicleLabel).join(', ')}${inside.length > 8 ? '…' : ''}.` : '',
        e.end ? `Vigente hasta ${madridTime(e.end)}.` : '',
      ].filter(Boolean).join(' '),
    });
  }
  return alerts;
}

/** Focos de calor detectados por satélite cerca de trenes en circulación. */
export function firesNearTrains(ctx) {
  const th = ctx.thresholds;
  const fires = ctx.events.filter((e) => e.category === 'incendio' && e.start && ctx.now - e.start <= th.fireWindowHours * 3600_000);
  const used = new Set();
  const alerts = [];
  for (const f of fires) {
    if (used.has(f.id)) continue;
    const cluster = fires.filter((g) => !used.has(g.id) && distanceKm(f.lat, f.lon, g.lat, g.lon) <= th.fireClusterKm);
    cluster.forEach((g) => used.add(g.id));
    const near = ctx.vehicles.filter((v) => cluster.some((g) => distanceKm(g.lat, g.lon, v.lat, v.lon) <= th.fireNearKm));
    if (!near.length) continue;
    const maxFrp = Math.max(...cluster.map((g) => g.frp ?? 0));
    alerts.push({
      id: `incendio:${f.id}`, type: 'incendio', lat: f.lat, lon: f.lon, eventIds: cluster.map((g) => g.id),
      severity: cluster.length >= 3 || maxFrp >= 30 ? 'alta' : 'media',
      vehicleIds: near.map((v) => v.id),
      title: `Posible incendio a menos de ${th.fireNearKm} km de ${near.length} ${near.length === 1 ? 'tren' : 'trenes'}`,
      description: `${cluster.length} ${cluster.length === 1 ? 'detección' : 'detecciones'} por satélite (potencia máx. ${Math.round(maxFrp)} MW). ` +
        `Trenes: ${near.slice(0, 6).map(vehicleLabel).join(', ')}. Puede ser una fuente de calor industrial: confirmar con fuentes oficiales.`,
    });
  }
  return alerts;
}

/** Desplome de la demanda eléctrica frente a la prevista (huella de un apagón como el del 28-A). */
export function gridDemandDrop(ctx) {
  const m = ctx.metrics.ree;
  const th = ctx.thresholds;
  if (!m || m.deviation === null || m.deviation === undefined || m.deviation > th.gridDropHigh) return [];
  return [{
    id: 'red-electrica', type: 'red-electrica', severity: m.deviation <= th.gridDropCritical ? 'muy alta' : 'alta',
    title: `Demanda eléctrica ${Math.round(m.deviation * 100)} % por debajo de lo previsto`,
    description: `Real ${m.demandMW} MW frente a ${m.forecastMW} MW previstos. Una caída brusca puede indicar un apagón o un corte grande (estimación de Radar España con datos de Red Eléctrica).`,
  }];
}

/** Desaparición masiva de trenes del mapa. */
export function fleetDrop(ctx) {
  const ref = ctx.kpiHistory.find((k) => ctx.now - k.t <= 12 * 60_000 && ctx.now - k.t >= 8 * 60_000);
  if (!ref || ref.vehicles <= 50 || ctx.kpis.vehicles >= ref.vehicles * ctx.thresholds.fleetDropRatio) return [];
  return [{
    id: 'flota', type: 'flota', severity: 'alta',
    title: `Desaparecen trenes del mapa: ${ctx.kpis.vehicles} frente a ${ref.vehicles} hace 10 min`,
    description: 'Puede ser una caída de la fuente de datos o una interrupción generalizada del servicio.',
  }];
}

/** Alertas naranja o roja de GDACS (terremotos, inundaciones, ciclones, volcanes…) en la zona. */
export function disasterAlerts(ctx) {
  return ctx.events
    .filter((e) => e.category === 'catastrofe' && (e.level === 'naranja' || e.level === 'rojo'))
    .map((e) => ({
      id: `gdacs:${e.id}`, type: 'catastrofe', severity: e.level === 'rojo' ? 'muy alta' : 'alta', eventIds: [e.id],
      lat: e.lat, lon: e.lon, title: e.title, description: e.description,
    }));
}

/** Fuentes caídas o congeladas: un mapa con datos viejos puede engañar. */
export function feedHealth(ctx) {
  const alerts = [];
  for (const s of ctx.health) {
    if (!s.enabled) continue;
    const down = s.ok === false && (!s.lastOk || ctx.now - s.lastOk > s.interval * 3);
    const stale = s.kind === 'vehicles' && s.sourceTime && ctx.now - s.sourceTime > ctx.thresholds.staleFeedMinutes * 60_000;
    if (!down && !stale) continue;
    alerts.push({
      id: `fuente:${s.id}`, type: 'fuente', severity: s.kind === 'vehicles' ? 'media' : 'baja',
      title: `${s.name}: ${down ? 'sin respuesta' : 'datos sin actualizar'}`,
      description: down ? `Último error: ${s.error}` : `La fuente no se actualiza desde hace ${Math.round((ctx.now - s.sourceTime) / 60_000)} min.`,
    });
  }
  return alerts;
}

// El orden importa: stoppedOutsideStation prepara ctx.stopped para stoppedClusters.
export const RULES = [
  stoppedOutsideStation,
  stoppedClusters,
  largeDelays,
  delayJumps,
  earthquakesNearTrains,
  severeWeather,
  firesNearTrains,
  disasterAlerts,
  gridDemandDrop,
  fleetDrop,
  feedHealth,
];

/** @param {RuleContext} ctx */
export function evaluateRules(ctx, rules = RULES) {
  const scoped = { ...ctx };
  return rules.flatMap((rule) => rule(scoped));
}
