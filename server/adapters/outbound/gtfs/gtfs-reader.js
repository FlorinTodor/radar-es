// Lectura de GTFS estático: descomprime sólo los ficheros pedidos (el stop_times de
// Cercanías ocupa 290 MB y no hace falta) y recorre los CSV fila a fila.
import { unzipSync } from 'fflate';

const CHUNK_BYTES = 1 << 20;

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

/** Líneas de texto de un fichero UTF-8, decodificado por trozos de 1 MB: pasar de golpe a una sola
 * cadena un stop_times de 100 MB dispararía el pico de memoria al cargar los horarios grandes. */
function* textLines(bytes) {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, bytes.length);
    const text = rest + decoder.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      yield text.slice(start, nl);
      start = nl + 1;
    }
    rest = text.slice(start);
  }
  if (rest) yield rest;
}

/** Filas de un CSV GTFS como objetos, con claves y valores recortados (Renfe deja espacios). */
export function* csvRows(bytes) {
  if (!bytes) return;
  let header = null;
  for (let line of textLines(bytes)) {
    if (!header && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
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
