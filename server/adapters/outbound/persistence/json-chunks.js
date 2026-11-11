// JSON por trozos: el mismo texto que JSON.stringify, pero hecho y entregado poco a poco, para escribirlo en un
// fichero sin parar el servidor. Lo que guarda el bot con miles de chats son decenas de MB: JSON.stringify de golpe
// dejaba el servidor sin responder casi dos segundos en el VPS. Con esto, writeFile escribe cada trozo según sale,
// y entre trozo y trozo el servidor atiende lo demás.
//   await writeFileAtomic(file, jsonChunks(value));

/** Caracteres por trozo, más o menos: en el VPS, unos pocos ms de trabajo cada uno. */
const CHUNK_CHARS = 64 * 1024;

/** ¿Se recorre por dentro? Las listas y los objetos simples (sin toJSON); lo demás, a JSON.stringify tal cual. */
const isArray = Array.isArray;
const isPlainObject = (v) => {
  if (v === null || typeof v !== 'object' || typeof v.toJSON === 'function') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
/** Lo que JSON.stringify se salta en un objeto (y en una lista escribe null). */
const skipped = (v) => v === undefined || typeof v === 'function' || typeof v === 'symbol';
/** Como JSON.stringify: lo que tiene toJSON (una fecha) se cambia por lo que éste da, con su clave. */
const toJson = (v, key) => (v !== null && (typeof v === 'object' || typeof v === 'bigint') && typeof v.toJSON === 'function' ? v.toJSON(key) : v);

/**
 * Los trozos de texto de `value` (ya con su toJSON hecho): por dentro, la raíz y lo que hay en ella (dos niveles: las
 * listas grandes de lo guardado); lo de más adentro, cada elemento con JSON.stringify. (Si lo que da un toJSON tiene a
 * su vez toJSON, éste se haría otra vez: lo que guarda el bot no tiene nada así.)
 * @param {unknown} value  @param {number} depth
 * @returns {Generator<string>}
 */
function* pieces(value, depth = 0) {
  if (depth < 2 && isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) {
      if (i) yield ',';
      const x = toJson(value[i], String(i));
      if (skipped(x)) yield 'null';
      else yield* pieces(x, depth + 1);
    }
    yield ']';
  } else if (depth < 2 && isPlainObject(value)) {
    yield '{';
    let first = true;
    for (const [k, raw] of Object.entries(value)) {
      const v = toJson(raw, k);
      if (skipped(v)) continue;
      yield `${first ? '' : ','}${JSON.stringify(k)}:`;
      first = false;
      yield* pieces(v, depth + 1);
    }
    yield '}';
  } else {
    // Como JSON.stringify: lo que no se puede escribir (undefined en la raíz) no da nada.
    const text = JSON.stringify(value);
    if (text !== undefined) yield text;
  }
}

/**
 * El JSON de `value` (el mismo texto que JSON.stringify(value)), en trozos de unos `chunkChars` caracteres. Asíncrono
 * para que quien lo escribe (writeFile) espere a cada escritura antes de pedir el siguiente.
 * @param {unknown} value
 * @param {{ chunkChars?: number }} [opts]
 * @returns {AsyncGenerator<string>}
 */
export async function* jsonChunks(value, { chunkChars = CHUNK_CHARS } = {}) {
  let parts = [];
  let size = 0;
  for (const piece of pieces(toJson(value, ''))) {
    parts.push(piece);
    size += piece.length;
    if (size >= chunkChars) {
      yield parts.join('');
      parts = [];
      size = 0;
    }
  }
  if (parts.length) yield parts.join('');
}
