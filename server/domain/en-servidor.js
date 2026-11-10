// Textos que escribe el servidor con sus propias palabras (títulos de alertas, incidencias de tráfico,
// cancelaciones…), en inglés. Los usan la web (tx() en public/js/i18n.js, que lo carga por
// public/js/i18n/en-servidor.js) y el bot de Telegram (domain/seguidos/idioma.js): por eso está en el dominio y
// se sirve tal cual al navegador, como seguir.js. Puro y sin importar nada. Lo que publica cada fuente y los
// nombres no se tocan.
//
// Cada patrón copia la plantilla exacta del servidor (el fichero va al lado) y deja tal cual sus partes
// variables: nombres de estaciones, líneas, vehículos, carreteras, lugares, y los textos que publica la
// fuente (el motivo de una cancelación, el aviso del operador, la descripción de un aviso de AEMET…).
// No se traducen, a propósito:
// - los avisos de AEMET («Aviso naranja por lluvias · …»): su licencia pide darlos sin alterar;
// - los avisos oficiales de protección civil y los 112, los de Renfe, Rodalies, EMT y demás operadores, y los
//   títulos de GDACS: son sus textos;
// - las atribuciones con su fórmula («Fuente: Red Eléctrica», «© AEMET»…);
// - los nombres de lugares, también los de las zonas de los terremotos del EMSC («Golfo de Vizcaya»).
// test/public/i18n-servidor.test.js genera los textos con el propio servidor: si cambia una plantilla, avisa.

/**
 * Fuentes cuyos títulos se parecen a los nuestros pero son suyos y su licencia pide no alterarlos: Tráfico de
 * Euskadi (Open Data Euskadi) pone su causa con la misma forma que la DGT («Obras · BI-631 km 12»).
 */
export const VERBATIM_SOURCES = new Set(['trafico-euskadi']);

/** «26.543,2» (como escribe los números el servidor, en español) → «26,543.2». */
const enNum = (s) => s.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'));
const many = (n, one, other) => (Number(n) === 1 ? one : other);

// Los ficheros de tiempo real que se citan en las cancelaciones (cancelaciones.js, renfe.js, gtfs-horario.js…).
const FEEDS = {
  'GTFS-RT de actualizaciones de viaje': 'GTFS-RT trip updates',
  'GTFS-RT de avisos de servicio': 'GTFS-RT service alerts',
  'GTFS-RT de Cercanías y Rodalies': 'GTFS-RT for Cercanías and Rodalies',
  'GTFS-RT de Alta Velocidad, Larga y Media Distancia': 'GTFS-RT for High Speed, Long and Medium Distance',
  'GTFS-RT de Alta Velocidad, Larga y Media Distancia (posiciones y actualizaciones de viaje)':
    'GTFS-RT for High Speed, Long and Medium Distance (positions and trip updates)',
};
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Los conocidos (los largos primero: uno contiene a otro) y, si llega uno nuevo, cualquiera que empiece por GTFS-RT.
const FEED = `(?:${Object.keys(FEEDS).sort((a, b) => b.length - a.length).map(reEscape).join('|')}|GTFS-RT[^()]*?)`;
const feed = (s) => FEEDS[s] ?? s;

/** Quién se cancela («Línea 5 de AUVASA», «Autobús 3 de AMB», «Tren 12345»); el resto son nombres. */
function who(s) {
  let m = /^Línea (.+?) de (.+)$/.exec(s);
  if (m) return `${m[2]} line ${m[1]}`;
  m = /^Autobús (?:(.+?) )?de (.+)$/.exec(s);
  if (m) return m[1] ? `${m[2]} bus ${m[1]}` : `${m[2]} bus`;
  m = /^Tren (.+)$/.exec(s);
  if (m) return `Train ${m[1]}`;
  return s;
}

// Lugar de un terremoto del IGN (ign-place.js): «al noreste de Gójar (Granada)», «al sur del cabo de San Vicente».
const DIRECTIONS = {
  norte: 'north', noreste: 'north-east', este: 'east', sureste: 'south-east',
  sur: 'south', suroeste: 'south-west', oeste: 'west', noroeste: 'north-west',
};
const COUNTRIES = { Argelia: 'Algeria', Francia: 'France', Marruecos: 'Morocco' };
function quakePlace(s) {
  if (s === 'zona sin nombre') return 'unnamed area';
  const m = /^al (norte|noreste|este|sureste|sur|suroeste|oeste|noroeste) (?:del cabo( .+)|de (.+))$/.exec(s);
  const place = m ? `${DIRECTIONS[m[1]]} of ${m[2] ? `Cabo${m[2]}` : m[3]}` : s;
  return place.replace(/ \((Argelia|Francia|Marruecos)\)$/, (all, c) => ` (${COUNTRIES[c]})`);
}
// «10/11/26, 14:05» o «10/11/26, 13:05 (hora de Canarias)» (domain/sismos.js).
const quakeWhen = (s) => s.replace(/ \(hora de Canarias\)$/, ' (Canary Islands time)');
// Quién localiza un terremoto del EMSC (emsc-sismos.js, AUTHOR).
const AUTHORS = {
  'el EMSC': 'the EMSC', 'el IPMA (Portugal)': 'the IPMA (Portugal)', 'el ReNaSS (Francia)': 'the ReNaSS (France)',
  'el LDG-CEA (Francia)': 'the LDG-CEA (France)', 'el CRAAG (Argelia)': 'the CRAAG (Algeria)',
  'el CNRST (Marruecos)': 'the CNRST (Morocco)', 'una red sísmica': 'a seismic network',
};

// Incidencias de tráfico: nuestras etiquetas de los códigos DATEX II de la DGT (dgt.js, CAUSES) y de los
// tipos del Servei Català de Trànsit (trafico-autonomico.js, SCT_TYPES); «Incidencia» si no hay ninguna.
const ROAD_CAUSES = {
  Accidente: 'Accident',
  'Vehículo detenido u obstáculo': 'Stopped vehicle or obstruction',
  Obras: 'Roadworks',
  'Obstáculo en la vía': 'Obstruction on the road',
  Retención: 'Traffic queue',
  'Fenómeno meteorológico o ambiental': 'Weather or environmental hazard',
  'Daños en la infraestructura': 'Infrastructure damage',
  'Restricción de carriles': 'Lane restriction',
  'Condiciones adversas': 'Adverse conditions',
  'Avería de equipamiento': 'Equipment fault',
  Incidencia: 'Incident',
};

/** Frases fijas: el texto entero. */
export const EXACT = {
  ...FEEDS,
  // Títulos por defecto de los avisos de los operadores, cuando su aviso no trae título (renfe.js, rodalies.js,
  // emt-madrid.js, emergencias-extra.js); con título, el título es suyo y no se toca.
  'Aviso Renfe': 'Renfe notice',
  'Aviso Rodalies': 'Rodalies notice',
  'Aviso EMT Madrid': 'EMT Madrid notice',
  'Alerta GDACS': 'GDACS alert',
  // alerts/rules.js
  'Puede ser una caída de la fuente de datos o una interrupción generalizada del servicio.':
    'It may be an outage of the data source or a widespread service disruption.',
  // Fuentes en pausa (sources/index.js) y errores de lectura (http-client.js)
  'En pausa mientras su web no responda a nuestro servidor': 'Paused while its website does not respond to our server',
  'el fichero llega vacío (0 bytes)': 'the file arrives empty (0 bytes)',
};

// ---------- Cancelaciones (domain/cancelaciones.js) ----------
// Su descripción junta varias frases: el motivo que da el operador (suyo, va primero), lo que publica, el
// horario, las dudas, su aviso sobre el viaje (suyo), lo que dice en otro de sus ficheros y, si ya no lo
// publica, cuándo lo retiró. Se traducen sólo nuestras frases, cada una por su forma; quien lo publica y
// los nombres se copian tal cual. Una frase empieza al principio o tras «. ».
const S = '(?<=^|\\. )';
const SENTENCES = [
  // Lo que publica
  [new RegExp(`${S}([^.]+?) lo da como cancelado en su tiempo real \\((${FEED})\\)\\.`, 'g'),
    (all, pub, f) => `${pub} reports it as cancelled in its real-time feed (${feed(f)}).`],
  [new RegExp(`${S}([^.]+?) da como suprimidas en su tiempo real \\((${FEED})\\) todas sus paradas\\.`, 'g'),
    (all, pub, f) => `${pub} reports all its stops as skipped in its real-time feed (${feed(f)}).`],
  [new RegExp(`${S}([^.]+?) da como suprimidas en su tiempo real \\((${FEED})\\) (?:esta parada|estas (\\d+) paradas)(?: en (\\d+) expediciones)?: `, 'g'),
    (all, pub, f, n, trips) => `${pub} reports ${n ? `these ${n} stops` : 'this stop'} as skipped${trips ? ` on ${trips} trips` : ''} in its real-time feed (${feed(f)}): `],
  // El horario
  [new RegExp(`${S}Según el horario, salía de (.+?) a las (\\d{1,2}:\\d\\d) y llegaba a (.+?) a las (\\d{1,2}:\\d\\d)\\.`, 'g'),
    (all, o, dep, d, arr) => `According to the timetable, it left ${o} at ${dep} and arrived at ${d} at ${arr}.`],
  [new RegExp(`${S}Según el horario, salía de (.+?) a las (\\d{1,2}:\\d\\d)\\.`, 'g'),
    (all, o, dep) => `According to the timetable, it left ${o} at ${dep}.`],
  [new RegExp(`${S}Según el horario, llegaba a (.+?) a las (\\d{1,2}:\\d\\d)\\.`, 'g'),
    (all, d, arr) => `According to the timetable, it arrived at ${d} at ${arr}.`],
  // Las dudas
  [new RegExp(`${S}([^.]+?) también publica su retraso o su posición: puede que circule en parte\\.`, 'g'),
    (all, pub) => `${pub} also publishes its delay or position: it may be partly running.`],
  [new RegExp(`${S}([^.]+?) además lo marca como cancelado en otra entrada de su tiempo real\\.`, 'g'),
    (all, pub) => `${pub} also marks it as cancelled in another entry of its real-time feed.`],
  // Su aviso sobre el viaje: sólo la entrada; el aviso es suyo.
  [new RegExp(`${S}Aviso de ([^.]+?) sobre este viaje: `, 'g'), (all, pub) => `Notice from ${pub} about this trip: `],
  // El mismo tren en otro fichero del operador
  [new RegExp(`(?<=^|[.!?»"')] |\\S )([^.]+?) también lo (publica|publicaba) en su (${FEED}), como (.+?)(?: \\((.+?) → (.+?)\\))?(, y allí ya no lo publica)?\\.( Allí lo da como cancelado\\.| Allí sólo suprime algunas paradas\\.)?`, 'g'),
    (all, pub, tense, f, as, o, d, gone, what) => `${pub} ${tense === 'publica' ? 'also publishes' : 'also used to publish'} it in its ${feed(f)}, as ${who(as)}`
      + `${o ? ` (${o} → ${d})` : ''}${gone ? ', and no longer publishes it there' : ''}.`
      + `${what ? (what.includes('cancelado') ? ' There it reports it as cancelled.' : ' There it only skips some stops.') : ''}`],
  // Cuándo lo retiró (withdrawnCancellation)
  [new RegExp(`(?<=^|[.!?»"')] |\\S )([^.]+?) dejó de publicarlo a las (\\d{1,2}:\\d\\d)(, después de su hora de llegada: lo hace con los viajes que ya han pasado\\.|, antes de su hora de llegada: puede que al final circule, o que lo haya retirado por otro motivo\\.|\\.)`, 'g'),
    (all, pub, clock, when) => `${pub === 'La fuente' ? 'The source' : pub} stopped publishing it at ${clock}`
      + `${when.startsWith(', después') ? ', after its arrival time: it does this with trips that have already run.'
        : when.startsWith(', antes') ? ', before its arrival time: it may run after all, or it may have been withdrawn for another reason.' : '.'}`],
];

function cancellationDescription(text) {
  return SENTENCES.reduce((s, [re, to]) => s.replace(re, to), text);
}

// Quién: un vehículo (vehicleLabel: servicio, línea y número, «Cercanías C3 20071»), un tren («Alvia 00291»,
// «Tren 12345») o una línea («Línea 129 de AMB»). Palabras que empiezan por mayúscula o número, más «de», «la»…
// sin signos de frase: así no encaja un texto de una fuente que acabe igual («El tren 123 circula con 20 min de
// retraso», «Servicio cancelado»), que lleva palabras en minúscula.
const WHO = String.raw`[\p{Lu}\p{N}][^\s·«»:;.!?]*(?: (?:de|del|la|las|los|el|i|y|[\p{Lu}\p{N}][^\s·«»:;.!?]*))*`;
// Además tiene que llevar un número (el del tren o la línea) o, si es una línea sin número, su operador
// («Línea Circular de TUSSAM»): «Servicio cancelado» o «Línea 5 no para en Plaza de España», de un aviso, no
// encajan (se quedan como están).
const isWho = (w) => (/^(?:Línea|Autobús) /.test(w)
  ? /^(?:Línea|Autobús)(?: [\p{Lu}\p{N}]\S*)* de [\p{Lu}\p{N}]/u.test(w)
  : /\p{N}/u.test(w));
/** [patrón con WHO, sustitución]: si lo que encaja como WHO no es quién, el texto se queda igual. */
function whoPattern(source, to) {
  const re = new RegExp(source.replaceAll('WHO', `(${WHO})`), 'u');
  return [re, (all, w, ...rest) => {
    if (!isWho(w)) return all;
    return typeof to === 'string' ? all.replace(re, to) : to(all, w, ...rest);
  }];
}

/** Frases con partes variables: [patrón (de principio a fin), sustitución]. La primera que encaja. */
export const PATTERNS = [
  // ---------- alerts/rules.js: títulos ----------
  whoPattern('^WHO sin posición actualizada$', '$1 without an updated position'),
  whoPattern('^WHO detenido en plena vía$', '$1 stopped between stations'),
  [/^(\d+) trenes detenidos cerca(?: de (.+))?$/, (all, n, st) => `${n} trains stopped close together${st ? ` near ${st}` : ''}`],
  whoPattern('^WHO con (\\d+) min de retraso$', '$1 running $2 min late'),
  whoPattern('^WHO: el retraso sube (\\d+) min de golpe$', '$1: delay jumps by $2 min'),
  [/^Posible incendio a menos de (\d+(?:\.\d+)?) km de (\d+) (?:tren|trenes)$/,
    (all, km, n) => `Possible fire less than ${km} km from ${n} ${many(n, 'train', 'trains')}`],
  [/^Demanda eléctrica (\d+) % por debajo de lo previsto$/, 'Electricity demand $1% below forecast'],
  [/^Corte de luz · (.+)$/, 'Power cut · $1'],
  [/^Posible apagón total en (.+): demanda a ([\d.,?]+) MW$/, (all, name, mw) => `Possible total blackout in ${name}: demand at ${enNum(mw)} MW`],
  [/^Demanda eléctrica de (.+) un (\d+) % por debajo de lo esperado$/, '$1 electricity demand $2% below expected'],
  [/^Desaparecen trenes del mapa: (\d+) frente a (\d+) hace 10 min$/, 'Trains disappearing from the map: $1 now against $2 10 min ago'],
  [/^(.+): sin respuesta$/, '$1: not responding'],
  [/^(.+): datos sin actualizar$/, '$1: data not updating'],
  // Aviso de AEMET con los trenes que circulan dentro: el aviso, tal cual; lo nuestro, el final.
  [/^(Aviso (?:amarillo|naranja|rojo) por .+) · (\d+) trenes dentro$/, (all, aviso, n) => `${aviso} · ${n} ${many(n, 'train', 'trains')} inside`],

  // ---------- alerts/rules.js: descripciones ----------
  [/^Último GPS hace (\d+) min, fuera de estación(?: \(a (\d+\.\d) km de (.+)\))?\.$/,
    (all, n, km, st) => `Last GPS fix ${n} min ago, away from any station${km ? ` (${km} km from ${st})` : ''}.`],
  [/^Sin moverse desde hace (\d+) min(?:, a (\d+\.\d) km de (.+?))?\. (Esta fuente no publica la hora del GPS: también puede ser una posición congelada\. )?(.+ → .+)\.$/s,
    (all, n, km, st, frozen, route) => `Not moving for ${n} min${km ? `, ${km} km from ${st}` : ''}. `
      + `${frozen ? 'This source does not publish the GPS time: it may also be a frozen position. ' : ''}${route}.`],
  [/^Posible corte o incidencia en la vía: (.+)\.$/s, 'Possible line blockage or incident: $1.'],
  [/^(.+ → .+\.) (?:Próxima parada: (.+)|En (.+))\.$/s, (all, route, next, at) => `${route} ${next ? `Next stop: ${next}` : `At ${at}`}.`],
  [/^De (-?\d+) a (-?\d+) min en menos de (\d+) min\.$/, 'From $1 to $2 min in less than $3 min.'],
  [/^(\d+) trenes en un radio de (\d+) km\.$/, (all, n, km) => `${n} ${many(n, 'train', 'trains')} within ${km} km.`],
  [/^Sin trenes en un radio de (\d+) km\.$/, 'No trains within $1 km.'],
  // Aviso de AEMET con nuestras frases detrás (su descripción, delante y tal cual).
  [/^(?=[\s\S]*(?:(?:^| )Trenes en la zona: [\s\S]+?\.|(?:^| )Vigente hasta \d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}\.)$)([\s\S]*?)((?:^| )Trenes en la zona: [\s\S]+?\.)?((?:^| )Vigente hasta \d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2}\.)?$/,
    (all, aemet, trains, until) => `${aemet}${trains ? trains.replace(/^( ?)Trenes en la zona: /, '$1Trains in the area: ') : ''}`
      + `${until ? until.replace(/^( ?)Vigente hasta /, '$1Valid until ') : ''}`],
  [/^(\d+) (?:detección|detecciones) por satélite \(potencia máx\. (-?\d+) MW\)\. Trenes: (.+)\. Puede ser una fuente de calor industrial: confirmar con fuentes oficiales\.$/s,
    (all, n, mw, trains) => `${n} satellite ${many(n, 'detection', 'detections')} (max. power ${mw} MW). Trains: ${trains}. `
      + 'It may be an industrial heat source: check with official sources.'],
  [/^Real ([\d.,?]+) MW(?: a las (\d{2}:\d{2}))? frente a ([\d.,?]+) MW previstos\. Una caída brusca puede indicar un apagón o un corte grande \(estimación de Radar España con datos de Red Eléctrica\)\.$/,
    (all, real, at, forecast) => `Actual ${enNum(real)} MW${at ? ` at ${at}` : ''} against ${enNum(forecast)} MW forecast. `
      + 'A sudden drop may point to a blackout or a large power cut (Radar España estimate with Red Eléctrica data).'],
  [/^Real ([\d.,?]+) MW a las (.+?) \(hora peninsular\) frente a ([\d.,?]+) MW (programados|que consumía en las dos últimas horas|que consumía antes del corte)\. Estimación de Radar España con datos de Red Eléctrica: confírmalo con los avisos oficiales\.$/,
    (all, real, at, expected, basis) => `Actual ${enNum(real)} MW at ${at} (mainland time) against ${enNum(expected)} MW `
      + `${{ programados: 'scheduled', 'que consumía en las dos últimas horas': 'used over the last two hours' }[basis] ?? 'used before the cut'}. `
      + 'Radar España estimate with Red Eléctrica data: check it against the official notices.'],
  // El aviso oficial va entre comillas y tal cual.
  [/^Aviso oficial: «([\s\S]*)»( \(el aviso no dice el lugar exacto\))?\.$/,
    (all, notice, approx) => `Official notice: «${notice}»${approx ? ' (the notice does not give the exact place)' : ''}.`],
  [/^Último error: ([\s\S]+)$/, (all, err) => `Last error: ${translate(err)}`],
  [/^La fuente no se actualiza desde hace (\d+) min\.$/, 'The source has not updated for $1 min.'],

  // ---------- Cancelaciones y trenes sin datos (domain/cancelaciones.js) ----------
  whoPattern('^WHO cancelado(: .+ → .+)?$', (all, w, route) => `${who(w)} cancelled${route ?? ''}`),
  whoPattern('^WHO no llega a (.+): termina en (.+)$', (all, w, d, end) => `${who(w)} does not reach ${d}: terminates at ${end}`),
  whoPattern('^WHO no sale de (.+): empieza en (.+)$', (all, w, o, start) => `${who(w)} does not start from ${o}: starts at ${start}`),
  whoPattern('^WHO no para en (\\d+) (estaciones|paradas)$', (all, w, n, kind) => `${who(w)} skips ${n} ${kind === 'paradas' ? 'stops' : 'stations'}`),
  whoPattern('^WHO no para en (.+)$', (all, w, stop) => `${who(w)} skips ${stop}`),
  whoPattern('^WHO sin datos de ([^:]+): (.+ → .+)$', (all, w, pub, route) => `${who(w)}: no data from ${pub}: ${route}`),
  [/^Según su horario debería estar circulando: salía de (.+?)(?: a las (\d{1,2}:\d\d))? y llega a (.+?)(?: a las (\d{1,2}:\d\d))?(?:; ahora iría entre (.+) y (.+?))?\. (.+?) no publica en su tiempo real ni su posición, ni su retraso, ni lo da como cancelado: el radar no puede saber si circula\.$/s,
    (all, o, dep, d, arr, a, b, pub) => `According to its timetable it should be running: it left ${o}${dep ? ` at ${dep}` : ''} and arrives at ${d}${arr ? ` at ${arr}` : ''}`
      + `${a ? `; it would now be between ${a} and ${b}` : ''}. ${pub} publishes neither its position nor its delay in its real-time feed, `
      + 'nor reports it as cancelled: the radar cannot tell whether it is running.'],
  // La descripción de una cancelación: la reconoce su frase de lo que publica el operador y su fichero.
  [new RegExp(`^(?=[\\s\\S]*(?:lo da como cancelado|da como suprimidas) en su tiempo real \\(GTFS-RT)[\\s\\S]+$`), (all) => cancellationDescription(all)],
  // Quién, suelto (la ficha lo enseña cuando el mismo tren sale en otro fichero del operador).
  whoPattern('^(?=Línea |Autobús |Tren \\d)WHO$', (all) => who(all)),

  // ---------- Terremotos (ign-sismos.js, emsc-sismos.js) ----------
  [/^Terremoto M(\d+\.\d) · (.+)$/, (all, m, place) => `Earthquake M${m} · ${quakePlace(place)}`],
  [/^Terremoto de magnitud (\d+\.\d)( a (\d+) km de profundidad)?(?:, (.+?),| \((.+?)\),) el (.+?)\. Localizado por el Instituto Geográfico Nacional \(IGN\)\.(?: Se sintió con intensidad ([IVX]{1,5}(?:-[IVX]{1,5})?)\.)?$/,
    (all, m, deep, km, near, zone, when, felt) => `Magnitude ${m} earthquake${deep ? ` at a depth of ${km} km` : ''}`
      + `${near ? `, ${quakePlace(near)},` : ` (${quakePlace(zone)}),`} on ${quakeWhen(when)}. Located by the Instituto Geográfico Nacional (IGN).`
      + `${felt ? ` Felt with intensity ${felt}.` : ''}`],
  [/^Terremoto de magnitud (\d+\.\d)( a (\d+) km de profundidad)?(?: cerca de (.+?)| \((.+?)\)), el (.+?)\. Localizado por (.+); datos del EMSC-CSEM SeismicPortal\.$/,
    (all, m, deep, km, near, zone, when, author) => `Magnitude ${m} earthquake${deep ? ` at a depth of ${km} km` : ''}`
      + `${near ? ` near ${quakePlace(near)}` : ` (${quakePlace(zone)})`}, on ${quakeWhen(when)}. Located by ${AUTHORS[author] ?? author}; data from the EMSC-CSEM SeismicPortal.`],

  // ---------- Focos de calor (firms.js) ----------
  [/^Foco de calor de (\d+) MW$/, 'Hotspot of $1 MW'],
  [/^Detectado por satélite \(VIIRS, NOAA-20\) a las (\d{2}:\d{2}) UTC, confianza (.+?)\. Puede ser un incendio, una quema agrícola o una fuente de calor industrial\.$/,
    'Detected by satellite (VIIRS, NOAA-20) at $1 UTC, confidence $2. It may be a wildfire, an agricultural burn or an industrial heat source.'],

  // ---------- Tráfico (dgt.js, trafico-autonomico.js) ----------
  [new RegExp(`^(${Object.keys(ROAD_CAUSES).map(reEscape).join('|')})( · .+| km -?\\d+\\.\\d)?$`), (all, cause, rest) => `${ROAD_CAUSES[cause]}${rest ?? ''}`],
  [/^(.*) · Carretera cortada$/, '$1 · Road closed'],

  // ---------- Avisos de los operadores sin título (gtfs-rt-avisos.js) y de Renfe con sus líneas (renfe.js) ----------
  [/^Aviso Renfe · (.+)$/, 'Renfe notice · $1'],
  [/^([^·]+) · Aviso$/, '$1 · Notice'],

  // ---------- Fuentes: por qué no se leen (main.js) y errores al leerlas (http-client.js) ----------
  [/^Falta (.+) en \.env$/, 'Missing $1 in .env'],
  [/^HTTP (\d{3}) en (.+)$/, 'HTTP $1 at $2'],
  [/^Respuesta que no es JSON en (.+)$/, 'Non-JSON response from $1'],
  [/^Respuesta de más de (\d+) MB en (.+)$/, 'Response over $1 MB from $2'],
  [/^Esquema no admitido en (.+)$/, 'Unsupported scheme at $1'],
  [/^Más de (\d+) redirecciones desde (.+)$/, 'More than $1 redirects from $2'],
  [/^Redirección no válida en (.+)$/, 'Invalid redirect at $1'],
  [/^Redirección de https a http en (.+): no se sigue$/, 'Redirect from https to http at $1: not followed'],
  [/^Redirección a (.+) en (.+): no se sigue$/, 'Redirect to $1 at $2: not followed'],
  [/^Redirección de (.+) a otro origen \((.+)\): no se sigue$/, 'Redirect from $1 to another origin ($2): not followed'],
];

/** Un texto del servidor dentro de otro (el error de «Último error: …»): igual que tx(). */
function translate(s) {
  if (Object.hasOwn(EXACT, s)) return EXACT[s];
  for (const [re, to] of PATTERNS) if (re.test(s)) return s.replace(re, to);
  return s;
}

/**
 * Un texto escrito por el servidor, en inglés si es una de sus plantillas; si no (lo que publica una fuente, un
 * nombre), tal cual. Lo de las fuentes cuya licencia pide no alterar su contenido (`source`, VERBATIM_SOURCES),
 * también tal cual. Es lo que hace tx() en la web sin su diccionario; lo usa el bot de Telegram.
 * @param {string} text  @param {string|null} [source]  id de la fuente que lo publica
 */
export function serverTextEn(text, source = null) {
  if (typeof text !== 'string' || !text || VERBATIM_SOURCES.has(source)) return text;
  return translate(text);
}
