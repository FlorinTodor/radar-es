// Ciclo de vida de las alertas: se abren, pueden escalar de gravedad y se resuelven
// cuando la condición deja de cumplirse.
import { SEVERITY_RANK } from '../model.js';

/**
 * Actualiza `active` con los candidatos de esta evaluación y devuelve los cambios.
 * @param {Map<string, import('../model.js').Alert>} active
 * @param {import('../model.js').Alert[]} candidates
 * @param {number} now
 */
export function reconcileAlerts(active, candidates, now) {
  const opened = [];
  const escalated = [];
  const resolved = [];
  const seen = new Set();

  for (const a of candidates) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const prev = active.get(a.id);
    if (!prev) {
      const alert = { ...a, since: now, updated: now };
      active.set(a.id, alert);
      opened.push(alert);
      continue;
    }
    const alert = { ...a, since: prev.since, updated: now };
    active.set(a.id, alert);
    if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[prev.severity]) escalated.push(alert);
  }

  for (const [id, a] of active) {
    if (seen.has(id)) continue;
    active.delete(id);
    resolved.push({ ...a, resolvedAt: now });
  }
  return { opened, escalated, resolved };
}

export function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.since - a.since);
}
