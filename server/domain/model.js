// Modelo del dominio. No importa nada de infraestructura: sólo tipos y reglas puras.

/**
 * @typedef {'av'|'ld'|'md'|'cercanias'|'metro'|'tranvia'|'bus'|'otros'} Mode  Tipo de vehículo: los que hay
 *   dados de alta en domain/modos.js (MODES), con su nombre y su familia. Uno nuevo se da de alta allí.
 * @typedef {'baja'|'media'|'alta'|'muy alta'} Severity
 * @typedef {'ferroviario'|'cancelacion'|'sin-datos'|'carretera'|'sismo'|'meteo'|'incendio'|'catastrofe'|'emergencia'} EventCategory
 *   sin-datos: trenes que según su horario deberían estar circulando y de los que su operador no publica nada.
 */

/**
 * Vehículo en circulación, normalizado desde cualquier operador.
 * @typedef {object} Vehicle
 * @property {string} id              Único entre fuentes (prefijado por operador).
 * @property {string} [source]        Id de la fuente que lo publicó.
 * @property {Mode} mode
 * @property {string} operator
 * @property {string} [service]       Producto comercial (AVE, Alvia, Cercanías...).
 * @property {string|null} line
 * @property {string} label           Número de tren o unidad.
 * @property {string[]} [follow]      Lo que se puede seguir de él, como claves estables entre días (servicio, línea;
 *   ver domain/seguir.js). Las pone el adaptador de su fuente, que es el que sabe qué es estable en sus datos:
 *   todas traen al menos su línea (o toda la red de su operador, si la fuente no la dice).
 * @property {number} lat
 * @property {number} lon
 * @property {number|null} delay      Minutos; null si la fuente no lo publica.
 * @property {boolean|null} [late]    Para fuentes que sólo dicen "en hora / con retraso".
 * @property {string|null} [origin]
 * @property {string|null} [destination]
 * @property {string|null} [current]
 * @property {boolean} [stopped]      Parado en `current` (si no, `current` es la última estación por la que pasó).
 * @property {string|null} [next]
 * @property {string|null} [nextEta]
 * @property {string|null} [platform] Vía de la estación en la que está parado o, si no, de la próxima.
 * @property {string|null} [shape]    Trazado (shape_id del GTFS de Cercanías o de Metro Bilbao) que sigue su viaje.
 * @property {[number, number]|null} [end]  Donde acaba su viaje ([lon, lat]): lo que le queda se dibuja hasta ahí.
 * @property {number|null} [fixTime]  Epoch ms del último GPS, si la fuente lo da.
 * @property {number} [farFromStop] Km entre la posición y la estación en la que la fuente dice que está parado, si pasa de 1,5: la posición no está al día (Cercanías).
 * @property {boolean} [estimated]    Posición calculada a partir del horario, no GPS. No cuenta para alertas ni KPIs.
 * @property {boolean} [ahead]        Lo que le queda hasta su final lo calcula el servidor (/api/ahead/<id>): posiciones
 *   estimadas (con su horario), Cercanías (por las paradas que le quedan) y AV/LD/MD (por la vía de Adif).
 * @property {boolean} [stops]        Se saben las paradas de su viaje (/api/stops/<id>): de dónde viene, por dónde pasa y
 *   adónde va, con su hora si la hay (ver domain/trip-stops.js).
 */

/**
 * Incidencia o suceso georreferenciado (aviso, accidente, terremoto...).
 * @typedef {object} IncidentEvent
 * @property {string} id
 * @property {string} [source]
 * @property {EventCategory} category
 * @property {string} type
 * @property {Severity} severity
 * @property {string} title
 * @property {string} [description]
 * @property {number|null} lat
 * @property {number|null} lon
 * @property {number|null} [start]
 * @property {number|null} [end]     Fin previsto, si la fuente lo da (obras de la DGT, avisos de AEMET).
 * @property {number|null} [updated] Última revisión de la incidencia en su fuente (DGT).
 * @property {number|null} [issued]  Epoch ms en que se emitió el aviso (AEMET pide mostrarlo; avisos oficiales).
 * @property {boolean} [issuedDayOnly]  La fuente sólo da el día de emisión, sin hora (notas de prensa de Cantabria).
 * @property {string|null} [url]     Página del aviso o del suceso en su fuente (el mapa la enlaza con safeLink).
 * @property {'verde'|'amarillo'|'naranja'|'rojo'} [level]  Nivel del aviso: meteorológicos de AEMET (amarillo a
 *   rojo) y catástrofes de GDACS (verde a rojo). Las reglas sólo avisan de los naranja y rojo.
 * @property {number} [magnitude]    Terremotos (category 'sismo'): magnitud.
 * @property {boolean} [backup]      Terremotos de una fuente de respaldo (EMSC): se quitan si la principal (IGN) publica el mismo.
 * @property {number} [frp]          Focos de calor (category 'incendio'): potencia radiativa del fuego, en MW.
 * @property {{ type: 'Polygon'|'MultiPolygon', coordinates: number[][][]|number[][][][] }} [geometry]  Zona afectada (avisos).
 * @property {boolean} [power]   Avisos oficiales (category 'emergencia'): habla de un corte de luz.
 * @property {string} [area]     Isla, municipio, provincia o comunidad a la que se refiere.
 * @property {'isla'|'municipio'|'provincia'|'comunidad'} [approx]  Con qué precisión está situado en el mapa
 *   (el centro de la isla, del municipio…): los avisos oficiales no traen coordenadas.
 * @property {string} [group]    Mismo aviso publicado para varios lugares (un evento por lugar).
 * @property {string} [credit]   Atribución que pide la licencia de su fuente, para mostrarla junto al dato.
 * @property {number} [expires]  Epoch ms a partir del cual deja de estar en vigor aunque su fuente no
 *   vuelva a responder (avisos oficiales: lo que dura uno sin noticias de su fin, ver domain/emergencias.js;
 *   terremotos: dos días, domain/sismos.js; tráfico: su fin o una hora sin leerlo, domain/carreteras.js;
 *   cancelaciones: una hora sin leerla, o hasta medianoche las retiradas, domain/cancelaciones.js; trenes sin
 *   datos: diez minutos).
 * @property {object} [trip]     Cancelaciones (category 'cancelacion', type 'cancelado' o 'parcial') y trenes sin
 *   datos (category 'sin-datos'): el viaje, con su operador, producto, línea, número, origen, destino, día (si se
 *   sabe), salida y llegada y la hora de cada parada según el horario, las paradas suprimidas, su motivo y los
 *   avisos del operador sobre él o su línea, por dónde iría (sin datos), quién lo publica y en qué fichero, y
 *   en qué otros ficheros publica el mismo tren (`alsoIn`; ver domain/cancelaciones.js, cancellationEvent,
 *   mergeSameTrain y missingTrainEvent).
 * @property {number} [seen]     Cancelaciones y trenes sin datos: epoch ms en que el radar la vio (o lo echó en
 *   falta) por primera vez (sus fuentes no dicen cuándo la publicaron).
 * @property {number} [withdrawn]  Cancelaciones que su fuente ha dejado de publicar: epoch ms en que lo hizo. Se
 *   siguen dando hasta medianoche (domain/cancelaciones.js, withdrawnCancellation).
 * @property {boolean} [seenAtStart]  Ya estaba en la primera lectura de su fuente tras arrancar el radar: pudo
 *   publicarse antes de `seen`.
 */

/**
 * Estado público de una fuente (/api/health): sus datos fijos y cómo fue su última lectura. Lo leen
 * las reglas (fuentes caídas, atribución de los avisos) y la web.
 * @typedef {object} SourceHealth
 * @property {string} id
 * @property {string} name
 * @property {'vehicles'|'events'|'metrics'} kind
 * @property {number} interval                ms entre lecturas.
 * @property {string|null} license             Atribución que pide su licencia (la citan las alertas de sus avisos).
 * @property {Record<string, string>|null} operatorLicenses  La de cada operador, si agrupa a varios.
 * @property {string|null} url                 Ficha pública o dirección de la fuente, sin claves.
 * @property {boolean} enabled
 * @property {string|null} reason              Por qué está desactivada.
 * @property {boolean|null} ok                 Si la última lectura fue bien; null si aún no se ha leído.
 * @property {number|null} lastOk
 * @property {number|null} lastError
 * @property {string|null} error
 * @property {number|null} count
 * @property {number|null} sourceTime
 * @property {number|null} datasetUpdated
 * @property {number|null} datasetUpdatedFrom
 * @property {Record<string, number>|null} datasetUpdatedBy
 * @property {string|null} datasetValidUntil   Último día con servicio de su horario, 'YYYY-MM-DD' (ver SourceResult).
 * @property {string|null} datasetValidUntilOf  En los grupos, el operador del horario que antes se acaba.
 * @property {number|null} ms                  Lo que tardó la última lectura.
 */

/**
 * Lo que devuelve una fuente en cada lectura.
 * @typedef {object} SourceResult
 * @property {Vehicle[]} [vehicles]
 * @property {IncidentEvent[]} [events]
 * @property {Record<string, unknown>} [metrics]
 * @property {number|null} [sourceTime]  Epoch ms de la última actualización según la fuente.
 * @property {number|null} [datasetUpdated]  Epoch ms en que la fuente actualizó el conjunto de datos estático
 *   (horario GTFS) del que se calcula el resultado. Lo exigen las licencias; no es la hora del dato.
 * @property {number|null} [datasetUpdatedFrom]  Si la fuente agrupa varios horarios: la fecha del más antiguo
 *   (datasetUpdated es entonces la del más reciente).
 * @property {Record<string, number>} [datasetUpdatedBy]  Si agrupa varios horarios: la fecha de cada operador.
 * @property {string|null} [datasetValidUntil]  Último día con servicio de su horario GTFS, 'YYYY-MM-DD'; en los
 *   grupos, el del que antes se acaba. Desde el día siguiente la fuente no tiene nada que mostrar.
 * @property {string} [datasetValidUntilOf]  En los grupos, de qué operador es ese horario.
 */

/**
 * Alerta generada por el motor de reglas.
 * @typedef {object} Alert
 * @property {string} id           Estable mientras dure la situación.
 * @property {string} type
 * @property {Severity} severity
 * @property {string} title
 * @property {string} description
 * @property {number} [lat]
 * @property {number} [lon]
 * @property {string} [vehicleId]
 * @property {string[]} [vehicleIds]
 * @property {string[]} [eventIds]   Sucesos (avisos, terremotos, focos…) que motivan la alerta.
 * @property {string|null} [credit]  Atribución que pide la licencia de la fuente del aviso (avisos oficiales).
 * @property {number} [since]
 * @property {number} [updated]
 * @property {number} [resolvedAt]
 */

/**
 * @typedef {object} Station
 * @property {string} code
 * @property {string} name
 * @property {string|null} place
 * @property {number} lat
 * @property {number} lon
 * @property {string|null} [province]
 * @property {string|null} [address]
 * @property {string|null} [postalCode]
 * @property {boolean} [cercanias]
 * @property {boolean} [metricGauge]   Ancho métrico (antigua FEVE)
 * @property {boolean|null} [accessible] Accesible en silla de ruedas según el GTFS; null si no lo dice
 */

export const SEVERITY_RANK = { 'muy alta': 4, alta: 3, media: 2, baja: 1 };

// Código de estación. Renfe: 5 cifras («71801»). Las demás redes: la red y el código de su GTFS
// («fgc:PC», «tmb:P.6660111»), con un tope de largo para que nadie pida claves enormes.
const RENFE_CODE = /^\d{5}$/;
const NETWORK_CODE = /^[a-z]+:[\w.:-]{1,64}$/;

/**
 * ¿Tiene `code` la forma de un código de estación? No dice si la estación existe: sólo que vale la
 * pena buscarla (la API rechaza lo demás sin mirar los catálogos).
 * @param {unknown} code @returns {boolean}
 */
export function isStationCode(code) {
  return typeof code === 'string' && (RENFE_CODE.test(code) || NETWORK_CODE.test(code));
}

/**
 * Vehículos que vigila el motor de alertas ferroviarias y que cuentan en los KPIs: trenes,
 * metros y tranvías con posición real. Las posiciones estimadas por horario, los autobuses
 * (que paran en cualquier sitio) se muestran pero no cuentan.
 */
const RAIL_MODES = new Set(['av', 'ld', 'md', 'cercanias', 'metro', 'tranvia', 'otros']);
/**
 * El suceso sigue en vigor a la hora `now`: los que traen `expires` dejan de mostrarse y de dar alertas
 * a esa hora, también si su fuente ha dejado de responder y el repositorio guarda su última lectura.
 * @param {IncidentEvent} e
 */
export const inForce = (e, now) => !(Number.isFinite(e.expires) && e.expires <= now);

export const monitoredVehicles = (vehicles) => vehicles.filter((v) => !v.estimated && RAIL_MODES.has(v.mode));

/** @param {Vehicle} v */
export function vehicleLabel(v) {
  const service = v.service && v.service !== v.line ? `${v.service} ` : '';
  return `${service}${v.line ?? ''} ${v.label ?? ''}`.replace(/\s+/g, ' ').trim();
}

// Retrasos imposibles: Renfe publica a veces, en los trenes que cruzan la medianoche, el retraso
// calculado contra el horario del día siguiente (-86.160 s = -1.436 min) u horas sin sentido
// (+1.008 min). No se corrigen (sería alterar el dato): se descartan como si no se publicaran.
const DELAY_MIN = -60;      // más de una hora de adelanto
const DELAY_MAX = 12 * 60;  // más de 12 horas de retraso

/** Retraso en minutos si es creíble; null si la fuente no lo da o es imposible. */
export function plausibleDelay(delay) {
  return Number.isFinite(delay) && delay >= DELAY_MIN && delay <= DELAY_MAX ? delay : null;
}

/**
 * Enlace externo que se puede mostrar: sólo http(s). Los feeds son de terceros y un
 * `javascript:` en un enlace se ejecutaría en nuestra web al pulsarlo.
 * @param {unknown} url @returns {string | null}
 */
export function safeLink(url) {
  if (typeof url !== 'string') return null;
  try {
    const { protocol } = new URL(url.trim());
    return protocol === 'https:' || protocol === 'http:' ? url.trim() : null;
  } catch {
    return null;
  }
}

// ---------- Lo que llega de las fuentes ----------

// Cada registro sale del JSON, XML o protobuf de un tercero, y hay adaptadores que copian sus valores tal
// cual (el `lin` de FGC, el vehicle.id de Renfe). Antes de guardarlo, cada campo que leen las rutas, el MCP
// y la web va con su tipo. Así, un número o una lista donde se espera un texto (el mapa llama a
// line.startsWith), un valor anidado miles de niveles (JSON.parse lo lee, pero JSON.stringify no puede
// volver a escribirlo y /api/live daría 500 a todos) o un instante fuera de lo que admite Date (el MCP y
// la web lo escriben con toISOString y los formateadores de fechas, que lanzan) afectan como mucho a ese
// registro, nunca a los de todas las fuentes.
const TEXT_MAX = 1000; // nombres, líneas, etiquetas, títulos… (ninguno pasa de unos cientos)
const LONG_TEXT_MAX = 20_000; // las descripciones de los avisos y las atribuciones de los grupos sí pueden ser largas
const ID_MAX = 1000; // más largo no se recorta (dos registros acabarían con el mismo): se descarta
const NESTING_MAX = 32; // lo que construyen los adaptadores (la zona de un aviso, el viaje de una cancelación) no pasa de 5
const TIME_MIN = Date.UTC(2000, 0, 1);
const TIME_AHEAD_MAX = 10 * 365 * 86_400_000;

// Campos de texto de cada tipo de registro. Los estructurados (geometry, trip, end) los construye el adaptador.
const VEHICLE_TEXTS = ['mode', 'operator', 'service', 'line', 'label', 'origin', 'destination', 'current', 'next', 'nextEta',
  'platform', 'area', 'shape', 'rollingStock'];
const EVENT_TEXTS = ['category', 'type', 'subtype', 'severity', 'title', 'area', 'approx', 'group', 'level'];
const EVENT_LONG_TEXTS = ['description', 'credit'];
// Instantes (epoch ms). El `end` de un vehículo no es uno: es el punto [lon, lat] donde acaba su viaje.
const VEHICLE_TIMES = ['fixTime'];
const EVENT_TIMES = ['start', 'end', 'issued', 'updated'];
const RESULT_TIMES = ['sourceTime', 'datasetUpdated', 'datasetUpdatedFrom'];

const given = (x) => x !== null && x !== undefined;
const isLat = (x) => Number.isFinite(x) && x >= -90 && x <= 90;
const isLon = (x) => Number.isFinite(x) && x >= -180 && x <= 180;
const isPoint = (p) => Array.isArray(p) && p.length === 2 && isLon(p[0]) && isLat(p[1]);

/**
 * Texto de una fuente: un texto, recortado a `max` caracteres, o un número finito escrito como texto.
 * null si es otra cosa (una lista, un objeto, un booleano…).
 * @param {unknown} value @param {number} [max] @returns {string | null}
 */
export function plainText(value, max = TEXT_MAX) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== 'string') return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Instante (epoch ms) creíble: desde el año 2000 hasta diez años después de `now`. null si no lo es: un
 * timestamp de GTFS-RT que no viene en segundos, o uno tan grande que Date no lo admite.
 * @param {unknown} t @param {number} now @returns {number | null}
 */
export function plausibleTime(t, now) {
  return Number.isFinite(t) && t >= TIME_MIN && t <= now + TIME_AHEAD_MAX ? t : null;
}

/** ¿Anida `value` más de `max` niveles de listas u objetos? Sin recursión, y para en cuanto pasa. */
function nestedDeeperThan(value, max) {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop();
    if (depth > max) return true;
    for (const child of Object.values(v)) if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * Lo común a vehículos y sucesos: una copia con el id (imprescindible), los textos y los instantes con su
 * tipo. null si no es un objeto o no tiene un id de texto.
 */
function typedRecord(record, texts, times, now) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = plainText(record.id, Infinity);
  if (!id || id.length > ID_MAX) return null;
  const out = { ...record, id };
  for (const k of texts) if (given(out[k])) out[k] = plainText(out[k]);
  for (const k of times) if (given(out[k])) out[k] = plausibleTime(out[k], now);
  return out;
}

/** Sin los demás campos que anidan más de lo que puede volver a escribirse (los que no se conocen, también). */
function withoutDeepNesting(out) {
  for (const [k, v] of Object.entries(out)) if (v !== null && typeof v === 'object' && nestedDeeperThan(v, NESTING_MAX)) delete out[k];
  return out;
}

/** Vehículo con sus campos tipados; null si le falta lo imprescindible: el id y una posición válida. */
function typedVehicle(v, now) {
  const out = typedRecord(v, VEHICLE_TEXTS, VEHICLE_TIMES, now);
  if (!out || !isLat(out.lat) || !isLon(out.lon)) return null;
  if (given(out.delay)) out.delay = plausibleDelay(out.delay);
  if (given(out.end) && !isPoint(out.end)) out.end = null;
  return withoutDeepNesting(out);
}

/**
 * Suceso con sus campos tipados; null si no tiene id o si su título (lo que se muestra de él) no es un
 * texto. Con unas coordenadas que no lo son, se queda sin ubicación.
 */
function typedEvent(e, now) {
  const out = typedRecord(e, EVENT_TEXTS, EVENT_TIMES, now);
  if (!out || (given(e.title) && out.title === null)) return null;
  for (const k of EVENT_LONG_TEXTS) if (given(out[k])) out[k] = plainText(out[k], LONG_TEXT_MAX);
  if ((given(out.lat) && !isLat(out.lat)) || (given(out.lon) && !isLon(out.lon))) Object.assign(out, { lat: null, lon: null });
  if ((given(out.lat2) && !isLat(out.lat2)) || (given(out.lon2) && !isLon(out.lon2))) Object.assign(out, { lat2: null, lon2: null });
  if ('url' in out) out.url = safeLink(out.url);
  return withoutDeepNesting(out);
}

/**
 * Lo que devuelve una lectura, listo para guardar: cada vehículo y cada suceso con sus campos tipados (los
 * que no tienen arreglo se descartan) y los instantes de la lectura, creíbles. No cambia `result`.
 * @param {SourceResult} result @param {number} now
 * @returns {{ result: SourceResult, dropped: number }} dropped: cuántos registros se han descartado
 */
export function typedSourceResult(result, now) {
  let dropped = 0;
  const keep = (list, typed) => {
    const out = [];
    for (const r of list) {
      const t = typed(r, now);
      if (t) out.push(t);
      else dropped++;
    }
    return out;
  };
  const out = { ...result };
  if (given(result.vehicles)) out.vehicles = keep(result.vehicles, typedVehicle);
  if (given(result.events)) out.events = keep(result.events, typedEvent);
  for (const k of RESULT_TIMES) if (given(out[k])) out[k] = plausibleTime(out[k], now);
  if (given(out.datasetUpdatedBy)) {
    out.datasetUpdatedBy = Object.fromEntries(Object.entries(out.datasetUpdatedBy).filter(([, t]) => plausibleTime(t, now) !== null));
  }
  return { result: out, dropped };
}
