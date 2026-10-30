// Caso de uso: evaluar las reglas del dominio sobre el estado actual, actualizar las
// alertas activas, registrar los cambios en el histórico y publicarlos.
import { evaluateRules } from '../../domain/alerts/rules.js';
import { reconcileAlerts, sortAlerts } from '../../domain/alerts/lifecycle.js';
import { DEFAULT_THRESHOLDS } from '../../domain/alerts/thresholds.js';
import { computeKpis } from '../../domain/kpis.js';
import { monitoredVehicles } from '../../domain/model.js';

const KPI_SAMPLE_MS = 60_000;
const KPI_HISTORY_MAX = 24 * 60;

/**
 * @param {{ situation: import('../ports.js').SituationRepositoryPort, stations: import('../ports.js').StationCatalogPort,
 *           history: import('../ports.js').HistoryPort, publisher: import('../ports.js').EventPublisherPort,
 *           clock: import('../ports.js').ClockPort, thresholds?: object }} deps
 */
export function makeDetectAlerts({ situation, stations, history, publisher, clock, thresholds = DEFAULT_THRESHOLDS }) {
  let lastSample = 0;

  return function detectAlerts() {
    const now = clock.now();
    const all = situation.vehicles();
    const vehicles = monitoredVehicles(all);
    const kpis = computeKpis(vehicles, now);

    const candidates = evaluateRules({
      now,
      vehicles,
      tracks: situation.tracks(),
      events: situation.events(),
      metrics: situation.metrics(),
      health: situation.health(),
      kpis,
      kpiHistory: situation.kpiHistory(),
      nearestStation: (lat, lon) => stations.nearest(lat, lon),
      thresholds,
    });

    const { opened, escalated, resolved } = reconcileAlerts(situation.activeAlerts(), candidates, now);
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

    const alerts = sortAlerts(situation.activeAlerts().values());
    publisher.publish('alerts.updated', { alerts, kpis, changed: opened.length + escalated.length + resolved.length });
    return { alerts, kpis };
  };
}
