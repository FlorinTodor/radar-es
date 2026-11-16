import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrometheusMetrics } from '../../server/adapters/outbound/metrics/prometheus-metrics.js';
import { emptyShareTotals } from '../../server/domain/compartir.js';

test('/metrics da los totales de los enlaces compartidos por tipo, estado y resultado, sin decir cuál', () => {
  const metrics = createPrometheusMetrics({ now: () => 1_000_000, cgroupDir: '/nonexistent' });
  const totals = emptyShareTotals(1_000_000);
  totals.pages.incidencia.activa = 3;
  totals.cards.dibujada = 2;
  const text = metrics.render({ share: { totals, ended: 4, cards: 2 }, now: 1_000_000 });
  metrics.close();
  assert.match(text, /^radar_compartir_paginas_total\{tipo="incidencia",estado="activa"\} 3$/m);
  assert.match(text, /^radar_compartir_tarjetas_total\{resultado="dibujada"\} 2$/m);
  assert.match(text, /^radar_compartir_terminadas 4$/m);
  assert.match(text, /^# TYPE radar_compartir_paginas_total counter$/m);
});
