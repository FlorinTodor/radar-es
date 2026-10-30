// Lectura de GTFS estático: descomprime sólo los ficheros pedidos (el stop_times de
// Cercanías ocupa 290 MB y no hace falta) y recorre los CSV fila a fila.
import { strFromU8, unzipSync } from 'fflate';

/** @returns {Record<string, Uint8Array>} nombre de fichero → contenido */
export function openGtfs(zipBytes, files) {
  const entries = unzipSync(zipBytes, { filter: (f) => files.includes(f.name.split('/').pop()) });
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name.split('/').pop(), data]));
}

function parseLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c !== '"') cur += c;
      else if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Filas de un CSV GTFS como objetos, con claves y valores recortados (Renfe deja espacios). */
export function* csvRows(bytes) {
  if (!bytes) return;
  const text = strFromU8(bytes);
  let header = null;
  let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    const cells = parseLine(line.replace(/\r$/, '')).map((s) => s.trim());
    if (!header) {
      header = cells;
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] ?? '';
    yield row;
  }
}
