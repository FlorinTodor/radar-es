export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** @param {import('./model.js').Vehicle[]} vehicles */
export function computeKpis(vehicles, now) {
  const delays = vehicles.map((v) => v.delay).filter((d) => d !== null && d !== undefined);
  const byMode = {};
  for (const v of vehicles) byMode[v.mode] = (byMode[v.mode] ?? 0) + 1;
  return {
    t: now,
    vehicles: vehicles.length,
    byMode,
    delayed: delays.filter((d) => d >= 5).length,
    withDelayInfo: delays.length,
    medianDelay: median(delays),
    maxDelay: delays.length ? Math.max(...delays) : null,
  };
}
