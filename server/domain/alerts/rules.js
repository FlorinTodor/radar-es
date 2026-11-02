// Reglas de alerta. Cada regla es una función pura (contexto) => Alert[].
// Para añadir una nueva: escribirla aquí y añadirla a RULES.
//
// Son heurísticas sobre datos públicos con decenas de segundos de latencia: sirven
// para vigilar y dar contexto, no para decisiones de seguridad operativa.
import { distanceKm, pointInGeometry } from '../geo.js';
import { vehicleLabel } from '../model.js';
import { stationarySince } from '../tracking.js';
import { SISTEMAS_AISLADOS } from '../lugares.js';

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

const MADRID_TIME = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
const madridTime = (ms) => MADRID_TIME.format(ms);

/** Trenes sin moverse fuera de estación. Calcula `ctx.stopped`, que usa la regla de bloqueos. */
export function stoppedOutsideStation(ctx) {
  const { now, vehicles, tracks, nearestStation, thresholds: th } = ctx;
  const alerts = [];
  ctx.stopped = [];
  for (const v of vehicles) {
    const track = tracks.get(v.id);
    if (!track?.length) continue;
    // La fuente lo da parado en una estación que queda lejos de su posición: la posición no está al día
    // y el recorrido se queda en la última buena (ver domain/tracking.js). Que no se mueva no dice nada
    // de dónde está el tren: no se avisa de que está detenido en plena vía.
    if (v.farFromStop) continue;

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

/**
 * Subida brusca del retraso: suele indicar una incidencia en ruta. Ir adelantado cuenta como ir en
 * hora: un tren que espera en su estación de origen antes de su hora sale con retraso negativo (en
 * Renfe, -23 o -36 min) y pasar de ahí a 0 al llegar su hora no es un retraso.
 */
export function delayJumps(ctx) {
  const th = ctx.thresholds;
  const windowStart = ctx.now - th.delayJumpWindowMin * 60_000;
  const alerts = [];
  for (const v of ctx.vehicles) {
    if (v.delay === null || v.delay === undefined) continue;
    const before = (ctx.tracks.get(v.id) ?? []).find((p) => p.t >= windowStart && p.delay !== null && p.delay !== undefined);
    if (!before) continue;
    const from = Math.max(0, before.delay);
    const rise = v.delay - from;
    if (rise < th.delayJumpMinutes) continue;
    alerts.push({
      id: `salto-retraso:${v.id}`, type: 'salto-retraso', vehicleId: v.id, lat: v.lat, lon: v.lon, severity: 'alta',
      title: `${vehicleLabel(v)}: el retraso sube ${rise} min de golpe`,
      description: `De ${from} a ${v.delay} min en menos de ${th.delayJumpWindowMin} min.`,
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

/** Atribución de la fuente de un suceso, que su licencia pide citar también en las alertas. */
const creditOf = (ctx, e) => e.credit ?? ctx.health.find((s) => s.id === e.source)?.license ?? null;

/**
 * Avisos oficiales agrupados por aviso: uno que declara lo mismo en tres islas o tres pueblos es una
 * sola alerta que señala los tres puntos.
 */
function byNotice(events) {
  const groups = new Map();
  for (const e of events) {
    const key = e.group ?? e.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  return [...groups.entries()];
}
const areasOf = (list) => [...new Set(list.map((e) => e.area).filter(Boolean))].join(', ');

/**
 * Cortes de luz que publican los avisos oficiales de protección civil y de los 112 autonómicos. Su
 * texto se cita tal cual; Radar España sólo añade dónde situarlo.
 */
export function officialPowerCuts(ctx) {
  const cuts = ctx.events.filter((e) => e.category === 'emergencia' && e.power);
  return byNotice(cuts).map(([key, list]) => {
    const e = list[0];
    return {
      id: `apagon:${key}`, type: 'apagon', severity: e.severity === 'baja' ? 'media' : e.severity,
      eventIds: list.map((x) => x.id), lat: e.lat ?? undefined, lon: e.lon ?? undefined,
      title: `Corte de luz · ${areasOf(list)}`,
      description: `Aviso oficial: «${e.description || e.title}»${list.every((x) => x.approx === 'comunidad') ? ' (el aviso no dice el lugar exacto)' : ''}.`,
      credit: creditOf(ctx, e),
    };
  });
}

/** Planes de protección civil en alerta o emergencia (las prealertas se quedan en el mapa, sin alerta). */
export function officialEmergencyPlans(ctx) {
  const plans = ctx.events.filter((e) => e.category === 'emergencia' && !e.power && e.type === 'plan'
    && (e.severity === 'alta' || e.severity === 'muy alta'));
  return byNotice(plans).map(([key, list]) => {
    const e = list[0];
    const areas = areasOf(list);
    return {
      id: `emergencia:${key}`, type: 'emergencia', severity: e.severity,
      eventIds: list.map((x) => x.id), lat: e.lat ?? undefined, lon: e.lon ?? undefined,
      title: areas && !e.title.includes(areas) ? `${e.title} · ${areas}` : e.title,
      description: e.description ?? '',
      credit: creditOf(ctx, e),
    };
  });
}

const mw = (v) => v.toLocaleString('es-ES', { maximumFractionDigits: 1 });

/**
 * Apagón de un sistema eléctrico aislado (una isla o un grupo de islas de Canarias, Ceuta, Melilla):
 * su demanda real cae muy por debajo de la esperada, que es la programada para ese momento o, si es
 * mayor, la que tenía en las dos últimas horas (tras un apagón REE reprograma la prevista, en La Palma
 * a 0 durante una hora, y el corte parecería normal). Llega minutos después del corte, antes que los
 * avisos oficiales: el 2-11-2026 en La Palma, a los 3 minutos; el Gobierno de Canarias, a la hora.
 */
export function isolatedGridBlackouts(ctx) {
  const th = ctx.thresholds;
  const alerts = [];
  for (const s of ctx.metrics['esios-sistemas-aislados']?.systems ?? []) {
    if (!Number.isFinite(s.real)) continue;
    if (!s.at || ctx.now - s.at > th.isolatedGridStaleMinutes * 60_000) continue; // dato viejo: no se sabe
    const programmed = Number.isFinite(s.programmed) ? s.programmed : 0;
    const expected = Math.max(programmed, Number.isFinite(s.recentMax) ? s.recentMax : 0);
    if (expected < 1) continue; // sin referencia (o un sistema minúsculo): no se puede decir nada
    const ratio = s.real / expected;
    if (ratio > th.isolatedGridDrop) continue;
    const zero = ratio <= th.isolatedGridZero;
    const place = SISTEMAS_AISLADOS.find((p) => p.name === s.name);
    alerts.push({
      id: `red-aislada:${s.id}`, type: 'red-electrica', severity: zero ? 'muy alta' : 'alta',
      lat: place?.lat, lon: place?.lon,
      title: zero ? `Posible apagón total en ${s.name}: demanda a ${mw(s.real)} MW`
        : `Demanda eléctrica de ${s.name} un ${Math.round((1 - ratio) * 100)} % por debajo de lo esperado`,
      description: `Real ${mw(s.real)} MW a las ${madridTime(s.at)} (hora peninsular) frente a ${mw(expected)} MW `
        + `${expected === programmed ? 'programados' : 'que consumía en las dos últimas horas'}. `
        + 'Estimación de Radar España con datos de Red Eléctrica: confírmalo con los avisos oficiales.',
      credit: 'Fuente: Red Eléctrica',
    });
  }
  return alerts;
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
  officialPowerCuts,
  officialEmergencyPlans,
  gridDemandDrop,
  isolatedGridBlackouts,
  fleetDrop,
  feedHealth,
];

/** @param {RuleContext} ctx */
export function evaluateRules(ctx, rules = RULES) {
  const scoped = { ...ctx };
  return rules.flatMap((rule) => rule(scoped));
}
