// Diccionario inglés de «El día en cifras»: el-dia-en-cifras.html, dia.js y dia-graficas.js (ver en.js).
export default {
  // el-dia-en-cifras.html
  'El día en cifras: trenes, retrasos y cancelaciones de hoy': "The day in figures: today's trains, delays and cancellations",
  'Abrir el mapa en directo →': 'Open the live map →',
  'Estás en': 'You are here',
  '<a href="/">Radar España</a> › El día en cifras': '<a href="/">Radar España</a> › The day in figures',
  'El día en cifras': 'The day in figures',
  'Lo que el radar ha visto en tiempo real a lo largo del día: cuántos trenes, metros, tranvías y autobuses circulaban, con qué retraso, qué se ha cancelado y qué avisos de emergencia ha habido. El día en curso se actualiza cada minuto.':
    'What the radar has seen live throughout the day: how many trains, metro trains, trams and buses were running, how late they were, what was cancelled and which emergency warnings there were. The current day is updated every minute.',
  'Elegir el día': 'Choose the day',
  '← Día anterior': '← Previous day',
  Día: 'Day',
  'Día siguiente →': 'Next day →',
  'Volver a hoy': 'Back to today',
  'Cargando el día…': 'Loading the day…',
  'Cómo se cuenta': 'How it is counted',
  '<strong>Vehículos vistos en tiempo real</strong>: los que publican su posición en ese momento las fuentes que lee el radar, de media en cada hora. No son todos los que circulan: hay operadores que no publican nada, y los que sólo se dibujan con su horario (posición estimada) no cuentan. Tampoco dice si se han cumplido unos servicios mínimos ni qué parte del servicio programado ha circulado.':
    '<strong>Vehicles seen live</strong>: those whose position the sources read by the radar are publishing at that moment, averaged over each hour. They are not all the vehicles running: some operators publish nothing, and those drawn only from their timetable (estimated position) are not counted. Nor does it say whether minimum services were met or what share of the scheduled service ran.',
  '<strong>Mismo día de la semana anterior</strong>: la línea gris, para comparar con un día parecido. Antes de que el radar guardara este resumen sólo hay datos de los trenes, metros y tranvías con posición real.':
    '<strong>Same day of the previous week</strong>: the grey line, to compare with a similar day. Before the radar started saving this summary, there is only data for trains, metro trains and trams with a real position.',
  '<strong>Retraso</strong>: sólo de los vehículos cuyo operador publica su retraso. «Con retraso» es 5 minutos o más, como en el resto del radar. Cada vehículo cuenta una vez por cada minuto que se ve.':
    '<strong>Delay</strong>: only for vehicles whose operator publishes their delay. “Delayed” means 5 minutes or more, as everywhere else on the radar. Each vehicle counts once for every minute it is seen.',
  '<strong>Cancelaciones</strong>: los viajes que su operador da como cancelados o con paradas suprimidas en su tiempo real a lo largo del día, también los que después ha dejado de publicar. Cada viaje cuenta una vez.':
    '<strong>Cancellations</strong>: trips that their operator reports in its live data as cancelled or with skipped stops during the day, including those it later stopped publishing. Each trip counts once.',
  '<strong>Trenes sin datos</strong>: los que según su horario debían circular y de los que su operador no publicaba nada en algún momento del día. No es una cancelación.':
    '<strong>Trains with no data</strong>: those that should have been running according to their timetable and about which their operator published nothing at some point in the day. It is not a cancellation.',
  '<strong>Avisos</strong>: los meteorológicos naranja y rojo de AEMET, los terremotos del día, los avisos oficiales de emergencias y cortes de luz y las alertas de GDACS que estuvieron en vigor. Ante una emergencia, llama al <strong>112</strong>.':
    '<strong>Warnings</strong>: AEMET orange and red weather warnings, the day’s earthquakes, official emergency and power cut notices, and GDACS alerts that were in force. In an emergency, call <strong>112</strong>.',
  'Radar España no es una web oficial: muestra los datos que publican sus fuentes, que pueden tener errores o faltar. Las fuentes y sus licencias están en <a href="/legal#fuentes">fuentes y licencias</a>.':
    'Radar España is not an official website: it shows the data its sources publish, which may contain errors or be missing. The sources and their licences are listed under <a href="/legal#fuentes">sources and licences</a> (in Spanish).',
  'Más información': 'More information',
  '<a href="/">Mapa en directo</a> · <a href="/que-es-radar-espana">Qué es Radar España</a> · <a href="/trenes-en-tiempo-real">Trenes en tiempo real</a> · <a href="/metro-tranvia-autobus">Metro, tranvía y autobús</a> · <a href="/incidencias-y-emergencias">Incidencias y emergencias</a> · <a href="/legal">Aviso legal, privacidad y fuentes</a>':
    '<a href="/?lang=en">Live map</a> · <a href="/en">What is Radar España</a> · <a href="/en/live-trains">Live trains</a> · <a href="/en/metro-tram-bus">Metro, tram and bus</a> · <a href="/en/incidents-and-emergencies">Incidents and emergencies</a> · <a href="/legal">Legal notice, privacy and sources (in Spanish)</a>',
  'Radar España es un proyecto independiente de <a href="https://florintodor.dev" rel="author">Florin Emanuel Todor Gliga</a>.':
    'Radar España is an independent project by <a href="https://florintodor.dev" rel="author">Florin Emanuel Todor Gliga</a>.',

  // dia.js: carga y navegación
  'La fecha {day} no existe.': 'The date {day} does not exist.',
  'No hay datos de {day}. El radar guarda los últimos 90 días.': 'There is no data for {day}. The radar keeps the last 90 days.',
  'hoy todavía': 'today yet',
  'No se ha podido cargar el día. Se volverá a intentar en un momento.': 'The day could not be loaded. It will try again in a moment.',
  'Elige un día': 'Choose a day',
  hoy: 'today',
  Hoy: 'Today',

  // dia.js: cifras
  'sin dato': 'no data',
  'de este día no se guardó': 'not saved for this day',
  Cancelaciones: 'Cancellations',
  '{whole} sin circular y {partial} con paradas suprimidas, de {operators}': '{whole} not running and {partial} with skipped stops, from {operators}',
  '{n} operador': '{n} operator',
  '{n} operadores': '{n} operators',
  'Ningún viaje cancelado': 'No trips cancelled',
  'Máximo a la vez': 'Most at once',
  'trenes, metros y tranvías vistos en tiempo real a las {time}': 'trains, metro trains and trams seen live at {time}',
  'vehículos vistos en tiempo real a las {time}': 'vehicles seen live at {time}',
  'Con 5 min o más de retraso': '5 min or more late',
  'de los que publican su retraso': 'of those that publish their delay',
  'ningún operador publicó su retraso': 'no operator published its delay',
  'Trenes sin datos': 'Trains with no data',
  'en algún momento del día': 'at some point in the day',
  'Alertas del radar': 'Radar alerts',
  '{n} de gravedad alta': '{n} of high severity',
  'aún no se ha leído': 'not read yet',
  'Avisos de emergencia': 'Emergency warnings',
  '{n} de AEMET': '{n} from AEMET',
  '{n} terremotos': '{n} earthquakes',
  '{n} oficiales': '{n} official',

  // dia.js: vehículos por horas
  'Vehículos vistos en tiempo real, por horas': 'Vehicles seen live, by hour',
  'Media de cada hora.': 'Average for each hour.',
  'En gris, el {day}, el mismo día de la semana anterior.': 'In grey, {day}, the same day of the previous week.',
  'Máximo a la vez: {n} {noun}': 'Most at once: {n} {noun}',
  // Los tipos de vehículo del registro de modos (server/domain/modos.js), que llegan del servidor
  tren: 'train',
  trenes: 'trains',
  metro: 'metro train',
  metros: 'metro trains',
  tranvía: 'tram',
  tranvías: 'trams',
  autobús: 'bus',
  autobuses: 'buses',
  vehículo: 'vehicle',
  vehículos: 'vehicles',
  '{label}: vehículos vistos en tiempo real por horas, con el mismo día de la semana anterior. Los valores están en la tabla.':
    '{label}: vehicles seen live by hour, with the same day of the previous week. The values are in the table.',
  '{label}: vehículos vistos en tiempo real por horas. Los valores están en la tabla.': '{label}: vehicles seen live by hour. The values are in the table.',

  // dia.js: retraso
  Retraso: 'Delay',
  'Con 5 min o más de retraso, por horas': '5 min or more late, by hour',
  'Porcentaje de los vehículos que publican su retraso. Sin barra, las horas con muy pocos (menos de 5 de media): con tan pocos, el porcentaje no dice nada':
    'Share of the vehicles that publish their delay. No bar for hours with very few of them (under 5 on average): with so few, the percentage means nothing',
  '{share} % con 5 min o más': '{share} % 5 min or more late',
  'Porcentaje de vehículos con 5 min o más de retraso, por horas. Los valores están en la tabla.': 'Share of vehicles 5 min or more late, by hour. The values are in the table.',
  'Con 5 min o más': '5 min or more',

  // dia.js: cancelaciones y trenes sin datos
  'Sin dato: {why} (el radar empezó a guardar las cancelaciones de cada día más tarde).': 'No data: {why} (the radar started saving each day’s cancellations later).',
  'Ningún operador ha dado viajes por cancelados en su tiempo real.': 'No operator has reported any trips as cancelled in its live data.',
  '{n} viajes cancelados o con paradas suprimidas': '{n} trips cancelled or with skipped stops',
  '{n} de {label}': '{n} {label}',
  'Dónde más cancelaciones': 'Where most cancellations were',
  '{n} con paradas suprimidas': '{n} with skipped stops',
  'Por operador': 'By operator',
  '{n} tren debía circular según su horario y su operador no publicaba nada de él en algún momento. No es una cancelación: no se sabe si circularon.':
    '{n} train should have been running according to its timetable and its operator published nothing about it at some point. It is not a cancellation: nobody knows whether it ran.',
  '{n} trenes debían circular según su horario y su operador no publicaba nada de ellos en algún momento. No es una cancelación: no se sabe si circularon.':
    '{n} trains should have been running according to their timetable and their operator published nothing about them at some point. It is not a cancellation: nobody knows whether they ran.',
  'Dónde más trenes sin datos': 'Where most trains had no data',

  // dia.js: alertas y avisos
  '{n} alertas (trenes detenidos, saltos de retraso, fuentes caídas, avisos…), de {situations} situaciones distintas: una misma situación se cuenta cada vez que vuelve a abrirse. Las de más gravedad:':
    '{n} alerts (stopped trains, delay jumps, sources down, warnings…), from {situations} different situations: the same situation is counted each time it reopens. The most severe:',
  '{n} alertas (trenes detenidos, saltos de retraso, fuentes caídas, avisos…). Las de más gravedad:': '{n} alerts (stopped trains, delay jumps, sources down, warnings…). The most severe:',
  'desde las {time}': 'since {time}',
  '{n} veces': '{n} times',
  amarillo: 'yellow',
  naranja: 'orange',
  rojo: 'red',
  verde: 'green',
  'Sin dato: {why}.': 'No data: {why}.',
  'Meteorología (AEMET)': 'Weather (AEMET)',
  '{total} avisos naranja o rojo: {red} rojos y {orange} naranjas': '{total} orange or red warnings: {red} red and {orange} orange',
  Terremotos: 'Earthquakes',
  '{total} en el día; {felt} de magnitud 3 o más': '{total} during the day; {felt} of magnitude 3 or more',
  'Avisos oficiales': 'Official notices',
  '{n} avisos de protección civil, 112 y gobiernos autonómicos; {power} de cortes de luz': '{n} notices from civil protection, 112 services and regional governments; {power} about power cuts',
  '{n} avisos de protección civil, 112 y gobiernos autonómicos': '{n} notices from civil protection, 112 services and regional governments',
  'Catástrofes en el mundo (GDACS)': 'Disasters worldwide (GDACS)',
  '{n} alertas naranja o roja': '{n} orange or red alerts',

  // dia.js: tabla, fuentes y cobertura
  '% con 5 min o más': '% 5 min or more late',
  'Ver los datos por horas en una tabla': 'See the hourly data in a table',
  Hora: 'Hour',
  'Entre paréntesis, el {day}.': 'In brackets, {day}.',
  Fuentes: 'Sources',
  'En curso: datos hasta las {time}.': 'In progress: data up to {time}.',
  'De este día sólo se guardan los trenes, metros y tranvías con posición real y las alertas: las cancelaciones, los trenes sin datos y los avisos empezaron a guardarse después.':
    'For this day, only trains, metro trains and trams with a real position and the alerts were saved: cancellations, trains with no data and warnings started being saved later.',
  'Una hora de este día sólo con los trenes, metros y tranvías con posición real (antes de que se guardara este resumen).':
    'One hour of this day has only trains, metro trains and trams with a real position (before this summary was being saved).',
  '{n} horas de este día sólo con los trenes, metros y tranvías con posición real (antes de que se guardara este resumen).':
    '{n} hours of this day have only trains, metro trains and trams with a real position (before this summary was being saved).',
  'Alguna lista llegó a su tope: las cifras de ese apartado se quedan cortas.': 'A list reached its limit: the figures in that section fall short.',

  // dia.js: ficha de las gráficas
  '{from} a {to}': '{from} to {to}',

  // dia-graficas.js
  '{h} h': '{h}:00',
  'la mitad, {n} min o menos': 'half of them {n} min or less',
  'retraso mediano: entre {from} y {to} min': 'median delay: between {from} and {to} min',
  'retraso mediano: {from} min o más': 'median delay: {from} min or more',
  '{n} %': '{n}%',
  ' %': '%',
  'Sin nombre': 'No name',
};
