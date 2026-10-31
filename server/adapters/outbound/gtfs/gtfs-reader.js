// Lectura de GTFS estático: descomprime sólo los ficheros pedidos (el stop_times de
// Cercanías ocupa 290 MB y no hace falta) y recorre los CSV fila a fila.
import { inflateRaw } from 'node:zlib';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';

const inflate = promisify(inflateRaw);
const CHUNK_BYTES = 1 << 20;

/**
 * Ritmo para los bucles largos (un stop_times de millones de filas): tras cada ~20 ms de trabajo
 * cede el hilo un instante para que el servidor siga atendiendo peticiones. Sin esto, al arrancar
 * o al cambiar de día dejaba de responder durante minutos y el chequeo de salud lo daba por caído.
 *   const pace = createPacer();
 *   for (const row of csvRows(bytes)) { if (pace.due()) await pace.pause(); … }
 */
export function createPacer(sliceMs = 20) {
  let last = performance.now();
  let n = 0;
  return {
    due: () => (++n & 63) === 0 && performance.now() - last >= sliceMs,
    pause: () => new Promise((resolve) => setImmediate(() => {
      last = performance.now();
      resolve();
    })),
  };
}

/**
 * Descomprime los ficheros pedidos con zlib asíncrono, en los hilos de libuv y no en el principal:
 * descomprimir de golpe un GTFS de 20 MB dejaba el servidor sin responder medio segundo. Los ZIP64
 * (tamaños o posiciones que no caben en 32 bits) van por fflate, síncrono, como antes.
 * - Cada fichero se descomprime en un solo bloque del tamaño final que dice el ZIP: con los bloques
 *   de 16 KB por defecto, zlib juntaba al final dos copias (el stop_times de Cercanías son 290 MB)
 *   y dejaba la memoria fragmentada: el pico subía de ~580 a ~920 MB.
 * - Uno detrás de otro, no a la vez: así sólo hay un fichero grande en memoria a medio hacer.
 * - Antes de descomprimir nada se comprueba todo el ZIP, para que un fichero dañado sea un error
 *   normal (que quien llama registra) y no una promesa rechazada sin dueño que tumbe el proceso.
 * @returns {Promise<Record<string, Uint8Array>>} nombre de fichero → contenido
 */
export async function openGtfs(zipBytes, files) {
  const zip = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  const entries = centralDirectory(zip);
  if (!entries) {
    const all = unzipSync(zipBytes, { filter: (f) => files.includes(f.name.split('/').pop()) });
    return Object.fromEntries(Object.entries(all).map(([name, data]) => [name.split('/').pop(), data]));
  }
  const wanted = entries.filter((e) => files.includes(e.name)).map((e) => {
    if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name}: compresión ${e.method} no soportada`);
    if (e.offset + 30 > zip.length || zip.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`${e.name}: cabecera local del ZIP dañada`);
    const start = e.offset + 30 + zip.readUInt16LE(e.offset + 26) + zip.readUInt16LE(e.offset + 28);
    if (start + e.size > zip.length) throw new Error(`${e.name}: el ZIP está cortado`);
    return { ...e, data: zip.subarray(start, start + e.size) };
  });
  const out = {};
  for (const e of wanted) {
    out[e.name] = e.method === 0 ? e.data : await inflate(e.data, { chunkSize: Math.min(Math.max(e.usize, MIN_CHUNK), MAX_CHUNK), maxOutputLength: MAX_CHUNK });
  }
  return out;
}

// El tamaño descomprimido lo declara el propio ZIP: se acota por si viene mal (si se queda corto,
// zlib sigue con más bloques; si es enorme, no se reserva de golpe más de 512 MB). Ningún fichero
// puede pasar de 512 MB descomprimido: un ZIP malicioso (bomba de descompresión) da error.
const MIN_CHUNK = 64 * 1024;
const MAX_CHUNK = 512 * 1024 * 1024;

/** Entradas del directorio central ({ name, method, size, usize, offset }), o null si es ZIP64. */
function centralDirectory(zip) {
  let end = -1; // registro de fin: en los últimos 22 bytes más un comentario de hasta 64 KB
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('el fichero no es un ZIP');
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) return null;
  const out = [];
  for (let k = 0; k < count; k++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('directorio del ZIP dañado');
    const size = zip.readUInt32LE(p + 20);
    const usize = zip.readUInt32LE(p + 24);
    const offset = zip.readUInt32LE(p + 42);
    if (size === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) return null;
    const nameLength = zip.readUInt16LE(p + 28);
    out.push({ name: zip.toString('utf8', p + 46, p + 46 + nameLength).split('/').pop(), method: zip.readUInt16LE(p + 10), size, usize, offset });
    p += 46 + nameLength + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
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
