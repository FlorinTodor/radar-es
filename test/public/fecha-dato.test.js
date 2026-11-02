// La fecha de los datos de cada fuente: sola la hora si es de hoy (en Madrid); si no, con el día.
// Varias licencias piden la fecha de la última actualización, y «14:12» a secas parece de hoy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDataTime } from '../../public/js/format.js';

test('dato de hoy: la hora; de otro día: el día y la hora (hora de Madrid)', () => {
  const now = Date.UTC(2026, 10, 2, 13, 0); // 2-nov-2026, 14:00 en Madrid
  assert.equal(fmtDataTime(Date.UTC(2026, 10, 2, 11, 30), now), 'de las 12:30');
  assert.equal(fmtDataTime(Date.UTC(2026, 10, 1, 13, 12), now), 'del 01/11/2026 a las 14:12');
  // 23:30 UTC del 1-nov ya es el 2-nov en Madrid: es de hoy.
  assert.equal(fmtDataTime(Date.UTC(2026, 10, 1, 23, 30), now), 'de las 00:30');
  assert.equal(fmtDataTime(null, now), '—');
});
