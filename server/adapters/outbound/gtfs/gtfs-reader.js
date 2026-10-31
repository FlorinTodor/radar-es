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
    out[e.name] = e.method === 0 ? e.data : await inflate(e.data, { chunkSize: Math.min(Math.max(e.usize, MIN_CHUNK), MAX_CHUNK) });
  }
  return out;
}

// El tamaño descomprimido lo declara el propio ZIP: se acota por si viene mal (si se queda corto,
// zlib sigue con más bloques; si es enorme, no se reserva de golpe más de 512 MB).
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

/** Celdas de una línea con comillas, carácter a carácter. */
function parseQuotedLine(line) {
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

/** Texto de un fichero UTF-8 en trozos de ~1 MB que acaban en salto de línea: pasar de golpe a una
 * sola cadena un stop_times de 100 MB dispararía el pico de memoria al cargar los horarios grandes. */
function* textChunks(bytes) {
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
    const end = Math.min(off + CHUNK_BYTES, bytes.length);
    const text = rest + decoder.decode(bytes.subarray(off, end), { stream: end < bytes.length });
    const cut = text.lastIndexOf('\n') + 1;
    if (cut) yield text.slice(0, cut);
    rest = text.slice(cut);
  }
  if (rest) yield `${rest}\n`;
}

// Todos los espacios que quita String.prototype.trim son < 33 o >= 0xA0: si la cadena no empieza ni
// acaba por uno de esos códigos, no hay nada que recortar (y casi nunca lo hay).
const isSpace = (code) => code <= 32 || code >= 0xa0;
const trimCell = (s) => (s.length && (isSpace(s.charCodeAt(0)) || isSpace(s.charCodeAt(s.length - 1))) ? s.trim() : s);

/**
 * Recorre un CSV y da, por cada fila, un array con las columnas que pide `pick(cabecera)`, recortadas.
 * Leer un horario es sobre todo esto (millones de filas de stop_times), así que no se crea una cadena
 * por línea ni por celda: sólo las de las columnas pedidas, cortadas directamente del trozo de texto.
 * Las líneas con comillas van por el analizador lento, carácter a carácter.
 */
function* columns(bytes, pick) {
  if (!bytes) return;
  let template = null; // fila vacía: '' en las columnas pedidas que trae el fichero, undefined en las que no
  let slot = null; // columna del fichero → posición en la fila (-1: no se pide)
  let lastCol = -1; // última columna del fichero que hace falta leer
  for (const text of textChunks(bytes)) {
    let quote = text.indexOf('"'); // próxima comilla del trozo (-1: ninguna)
    for (let from = 0, nl = text.indexOf('\n'); nl !== -1; from = nl + 1, nl = text.indexOf('\n', from)) {
      let start = from;
      let end = nl > start && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      if (!slot && text.charCodeAt(start) === 0xfeff) start++;
      if (end === start || (isSpace(text.charCodeAt(start)) && !text.slice(start, end).trim())) continue;
      if (quote !== -1 && quote < start) quote = text.indexOf('"', start);
      const quoted = quote !== -1 && quote < end;
      if (!slot) {
        const line = text.slice(start, end);
        const header = (quoted ? parseQuotedLine(line) : line.split(',')).map(trimCell);
        const wanted = pick(header);
        template = wanted.map((name) => (header.includes(name) ? '' : undefined));
        slot = new Int32Array(header.length).fill(-1);
        // Con columnas repetidas manda la última, como cuando cada fila era un objeto.
        wanted.forEach((name, i) => {
          const col = header.lastIndexOf(name);
          if (col >= 0) slot[col] = i;
          lastCol = Math.max(lastCol, col);
        });
        continue;
      }
      const row = template.slice();
      if (quoted) {
        const cells = parseQuotedLine(text.slice(start, end));
        for (let c = 0; c <= lastCol && c < cells.length; c++) if (slot[c] >= 0) row[slot[c]] = trimCell(cells[c]);
      } else {
        for (let c = 0, p = start; c <= lastCol; c++) {
          let q = text.indexOf(',', p);
          if (q === -1 || q > end) q = end;
          if (slot[c] >= 0) row[slot[c]] = trimCell(text.slice(p, q));
          if (q === end) break;
          p = q + 1;
        }
      }
      yield row;
    }
  }
}

/**
 * Copia propia de una cadena. Las celdas de csvColumns son trozos (SlicedString de V8) del texto
 * del que salen: guardar una sola mantiene vivo en memoria todo su bloque de 1 MB. Al concatenar
 * y volver a cortar, V8 aplana la cadena en una nueva y el bloque queda libre.
 * @param {string} s
 */
export const own = (s) => (s ? `${s} `.slice(0, -1) : s);

/**
 * Filas de un CSV GTFS como arrays con las columnas `fields`, en ese orden y recortadas: '' si la
 * fila no llega a esa columna, undefined si el fichero no la trae (igual que las claves de csvRows).
 * Es la forma rápida para los ficheros grandes:
 *   for (const [tripId, stopId] of csvColumns(bytes, ['trip_id', 'stop_id'])) …
 * Las celdas que se vayan a guardar más allá del bucle, con own().
 * @param {Uint8Array|undefined} bytes
 * @param {string[]} fields
 * @returns {Generator<string[]>}
 */
export function csvColumns(bytes, fields) {
  return columns(bytes, () => fields);
}

/** Filas de un CSV GTFS como objetos, con claves y valores recortados (Renfe deja espacios). Los
 * valores son copias propias: se pueden guardar sin retener el texto del fichero. */
export function* csvRows(bytes) {
  let keys = null;
  for (const values of columns(bytes, (header) => (keys = header))) {
    const row = {};
    for (let i = 0; i < keys.length; i++) row[keys[i]] = own(values[i]);
    yield row;
  }
}
