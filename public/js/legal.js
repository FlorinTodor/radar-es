// Página legal: datos del titular (de /api/about), contador y estado de cada capa.
// Va en un fichero aparte y no en línea para que la CSP pueda prohibir los scripts en línea.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'medium' });
const day = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short' });
// En el móvil cada fila se ve como una ficha: cada celda lleva el nombre de su columna.
const labelCells = (table) => {
  const names = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
  for (const tr of table.querySelectorAll('tbody tr')) [...tr.cells].forEach((td, i) => { if (names[i]) td.dataset.label = names[i]; });
};
document.querySelectorAll('.doc-body table').forEach(labelCells);

fetch('/api/about').then((r) => r.json()).then((about) => {
  for (const el of document.querySelectorAll('[data-about]')) {
    const value = about[el.dataset.about];
    if (!value) continue;
    el.textContent = value;
    if (el.dataset.about === 'contact' && value.includes('@')) el.innerHTML = `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
  }
  for (const el of document.querySelectorAll('[data-analitica]')) el.hidden = (el.dataset.analitica === 'si') !== Boolean(about.goatcounter);
}).catch(() => {});

fetch('/api/health').then((r) => r.json()).then((health) => {
  document.getElementById('estado-filas').innerHTML = health.map((s) => {
    // Fecha que da la propia fuente; en las posiciones estimadas, la de su horario en el NAP.
    const last = s.sourceTime ? when.format(s.sourceTime)
      : s.datasetUpdatedFrom ? `Horarios actualizados entre el ${day.format(s.datasetUpdatedFrom)} y el ${day.format(s.datasetUpdated)}`
      : s.datasetUpdated ? `Horario actualizado el ${when.format(s.datasetUpdated)}`
        : s.lastOk ? `Leída el ${when.format(s.lastOk)}` : '—';
    const status = !s.enabled ? 'Desactivada' : s.ok === null ? 'Pendiente' : s.ok ? 'Operativa' : 'Con errores';
    return `<tr><td>${esc(s.name)}</td><td>${esc(s.license)}</td><td>${esc(last)}</td><td>${status}</td></tr>`;
  }).join('');
  labelCells(document.getElementById('estado-filas').closest('table'));
}).catch(() => {
  document.getElementById('estado-filas').innerHTML = '<tr><td colspan="4">No se pudo cargar el estado.</td></tr>';
});
