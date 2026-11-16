import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_CATEGORIES, renderEventFilters, renderEvents } from '../../public/js/panels.js';

test('los filtros de Incidencias llevan «Todas · Ninguna» y cada tipo, pulsado si se ve', () => {
  const el = { innerHTML: '' };
  renderEventFilters(el, { eventCats: ['sismo'], obras: false });
  assert.match(el.innerHTML, /data-cats="all"[^>]*>Todas</);
  assert.match(el.innerHTML, /data-cats="none"[^>]*>Ninguna</);
  assert.match(el.innerHTML, /data-cat="sismo" aria-pressed="true"/);
  assert.equal((el.innerHTML.match(/aria-pressed="false"/g) ?? []).length, EVENT_CATEGORIES.length); // los demás y las obras
});

test('sin ningún tipo elegido, la lista dice cómo volver a verlos', () => {
  const el = { innerHTML: '' };
  renderEvents(el, [], undefined, { noCategory: true });
  assert.match(el.innerHTML, /No has elegido ningún tipo/);
  renderEvents(el, []);
  assert.match(el.innerHTML, /No hay incidencias con estos filtros/);
});
