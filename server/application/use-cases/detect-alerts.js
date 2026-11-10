// Caso de uso: evaluar las reglas del dominio sobre el estado actual, actualizar las
// alertas activas y registrar los cambios en el histórico.
import { GRID_METRICS, evaluateRules } from '../../domain/alerts/rules.js';
import { withCurrentCuts } from '../../domain/emergencias.js';
import { withoutRepeatedQuakes } from '../../domain/sismos.js';
import { reconcileAlerts, sortAlerts } from '../../domain/alerts/lifecycle.js';
import { DEFAULT_THRESHOLDS } from '../../domain/alerts/thresholds.js';
import { computeKpis } from '../../domain/kpis.js';
import { inForce, monitoredVehicles } from '../../domain/model.js';

const KPI_SAMPLE_MS = 60_000;
// Un día de muestras de minuto en minuto. Es el único tope del histórico: el repositorio guarda las
// que se le dicen (pushKpiSample) y no tiene otro por defecto.
const KPI_HISTORY_MAX = 24 * 60;

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           history: import('../ports.js').HistoryPort, clock: import('../ports.js').ClockPort,
 *           log?: import('../ports.js').LoggerPort, thresholds?: object }} deps
 *   log: con él, una regla que falla no deja sin evaluar las demás y queda en el registro como error (la
 *   monitorización lo ve, como el fallo de la ronda entera). Sin él, el fallo sube como hasta ahora.
 */
export function makeDetectAlerts({ situation, stations, history, clock, log, thresholds = DEFAULT_THRESHOLDS }) {
  let lastSample = 0;
  const onError = log ? (rule, err) => log.error(`[alertas] regla ${rule}: ${err?.stack ?? err}`) : null;

  return function detectAlerts() {
    const now = clock.now();
    const all = situation.vehicles();
    const vehicles = monitoredVehicles(all);
    const kpis = computeKpis(vehicles, now);

    const metrics = situation.metrics();
    // Los avisos que ya no están en vigor no dan alertas, aunque su fuente no haya vuelto a responder;
    // y un corte de luz que ya no lo es (al día, o con la demanda de su isla normal) cuenta como plan.
    // Un terremoto que publican el IGN y el EMSC cuenta una vez (se queda el del IGN).
    const events = withoutRepeatedQuakes(withCurrentCuts(situation.events().filter((e) => inForce(e, now)),
      { now, grid: metrics[GRID_METRICS.aislados]?.systems, thresholds }));
    const candidates = evaluateRules({
      now,
      vehicles,
      tracks: situation.tracks(),
      events,
      metrics,
      health: situation.health(),
      kpis,
      kpiHistory: situation.kpiHistory(),
      nearestStation: (lat, lon) => stations.nearest(lat, lon),
      thresholds,
    }, undefined, onError);

    const { opened, escalated, resolved } = situation.updateActiveAlerts((active) => reconcileAlerts(active, candidates, now));
    situation.addResolved(resolved);
    for (const a of opened) history.append('alerts', { ...a, event: 'nueva' });
    for (const a of escalated) history.append('alerts', { ...a, event: 'escalada' });
    for (const a of resolved) history.append('alerts', { ...a, event: 'resuelta' });

    kpis.alerts = situation.activeAlerts().size;
    situation.setKpis(kpis);
    if (now - lastSample >= KPI_SAMPLE_MS && vehicles.length) {
      lastSample = now;
      situation.pushKpiSample({ t: now, vehicles: kpis.vehicles, delayed: kpis.delayed, medianDelay: kpis.medianDelay }, KPI_HISTORY_MAX);
      history.append('kpis', kpis);
    }

    return { alerts: sortAlerts(situation.activeAlerts().values()), kpis };
  };
}
