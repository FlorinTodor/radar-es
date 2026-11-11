// Diccionario inglés del bot «Sigue tu tren»: frase en español (tal y como está en el código) → en inglés
// británico, claro y corto. Ver idioma.js. Las variables van entre llaves y tienen que ser las mismas en las dos, y
// las órdenes que se citan, con su nombre en inglés (/seguir → /follow): lo comprueba test/domain/bot-idioma.test.js,
// que también falla si una frase del bot no está aquí o si aquí sobra una que el bot ya no dice.
// Glosario, el mismo que la web: Following, follow, unfollow, cancelled/cancellation, skipped stop, trip, no data,
// delay, on time, official notice, emergency plan, power cut, earthquake, weather warning, daily summary (parte),
// province, road closure, accident, hotspot (foco de calor), journey (trayecto). Las comillas «» van como “”.
export const EN = {
  // ---------- Nombres de lo que se sigue (idioma.js nameText; se guardan en español) ----------
  Línea: 'Line',
  Servicio: 'Service',
  Tren: 'Train',
  Metro: 'Metro',
  Tranvía: 'Tram',
  Autobús: 'Bus',
  Vehículo: 'Vehicle',
  'esa línea (ahora no se ve)': 'that line (not visible right now)',
  'ese servicio (ahora no se ve)': 'that service (not visible right now)',
  'esa estación': 'that station',
  eso: 'that',
  '{who}: toda la red': '{who}: whole network',
  'una línea de {operator}': 'a {operator} line',
  'un servicio de {operator}': 'a {operator} service',
  'Estación {name}': '{name} station',
  'el de las {time}': 'departing {time}',
  'desde {place}': 'from {place}',
  '(sin nombre legible)': '(no readable name)',
  'Avisos en {province}': 'Alerts in {province}',
  // Una carretera (trafico.js roadTitle): «Carretera A-7 (Málaga)» → «A-7 road (Málaga)».
  'Carretera {road}': '{road} road',
  // Los días de un trayecto (idioma.js daysTextEn; los nombres de los días, de Intl).
  'todos los días': 'every day',
  'ningún día': 'no days',
  'de {from} a {to}': '{from} to {to}',
  'los {days}': '{days}',
  '{list} y {last}': '{list} and {last}',
  // Los tipos de vehículo del registro (domain/modos.js), como en la web.
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

  // ---------- Órdenes, menú y descripción del bot (ordenes.js) ----------
  'Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid': 'Follow a train, bus, metro or line: /follow 08058, /follow C4 Madrid',
  'Tus trenes de una estación a otra: /trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V':
    'Your trains from one station to another: /journey Alcalá de Henares > Atocha 7:00-9:00 Mon-Fri',
  'Cómo va ahora lo que sigues, o lo que busques': 'How what you follow is doing now, or anything you look up',
  'Avisos de tu provincia: AEMET, terremotos, emergencias, apagones y cortes de carretera':
    'Alerts for your province: AEMET, earthquakes, emergencies, power cuts and road closures',
  'Cortes y accidentes de una carretera: /carretera A-7, /carretera AP-7 Tarragona': 'Closures and accidents on a road: /road A-7, /road AP-7 Tarragona',
  'Lo que sigues': 'What you are following',
  'Dejar de seguir algo': 'Unfollow something',
  'Un resumen cada día a la hora que digas: /parte 07:30': 'A daily summary at the time you choose: /summary 07:30',
  'Qué guardo de este chat': 'What I store about this chat',
  'Borrar todo lo de este chat': 'Delete everything about this chat',
  'Cambiar de idioma: español o inglés': 'Change language: Spanish or English',
  'Cómo funciona': 'How it works',
  'Te aviso de lo que sigas en Radar España: cancelaciones, retrasos, avisos de tu línea y de tu provincia, y cortes y accidentes de tu carretera. Datos públicos de los operadores y de tráfico; no es un servicio oficial.':
    'I alert you about what you follow on Radar España: cancellations, delays, notices for your line, alerts for your province, and closures and accidents on your road. Public data from the operators and traffic authorities; not an official service.',
  'Avisos de trenes, autobuses, metro y tranvía de radarespana.es.': 'Train, bus, metro and tram alerts from radarespana.es.',

  // ---------- Ayuda, charla y /datos (ordenes.js) ----------
  'Hola. Soy el bot de Radar España.': "Hello. I'm the Radar España bot.",
  'Te aviso de lo que sigas: cualquier tren, autobús, metro o tranvía que publique el radar, su línea, una estación o tu trayecto de cada día, los avisos de tu provincia (y, si los pides, sus focos de calor) y los cortes y accidentes de una carretera.':
    'I alert you about what you follow: any train, bus, metro or tram the radar shows, its line, a station or your daily journey, the alerts for your province (and its hotspots, if you ask for them) and closures and accidents on a road.',
  'Órdenes:': 'Commands:',
  'También puedes escribirme sin orden lo que buscas («08058», «C4 Madrid», «27 EMT Málaga»).':
    'You can also just type what you are looking for (“08058”, “C4 Madrid”, “27 EMT Málaga”).',
  'Desde la web, en la ficha de un vehículo o de una estación, el botón «Avísame por Telegram» lo sigue directamente: {web}':
    'On the website, the “Alert me on Telegram” button on any vehicle or station card follows it straight away: {web}',
  'Avisos: si se cancela o se suprimen paradas, si va con {delay} min de retraso o más (y otra vez si empeora), si su operador deja de publicarlo y los avisos del operador sobre su línea. Puedes seguir hasta {max} cosas.':
    "Alerts: if it is cancelled or stops are skipped, if it is {delay} min or more late (and again if it gets worse), if its operator stops publishing it, and the operator's notices about its line. You can follow up to {max} things.",
  'Los datos son los que publican los operadores y organismos: el radar no es oficial y puede fallar. No lo uses para decisiones de seguridad.':
    'The data is what operators and public bodies publish: the radar is not official and may be wrong. Do not use it for safety decisions.',
  'Hola.': 'Hello.',
  'De nada.': "You're welcome.",
  'Dime qué quieres seguir: un número de tren («08058»), una línea con su ciudad u operador («C4 Madrid», «27 EMT Málaga») o una provincia (/provincia Valencia). /ayuda para ver todo lo que hago.':
    'Tell me what you want to follow: a train number (“08058”), a line with its city or operator (“C4 Madrid”, “27 EMT Málaga”) or a province (/province Valencia). /help to see everything I do.',
  'Si quieres seguir algo más, dime su número o su línea («08058», «C4 Madrid»). /mis para ver lo que sigues.':
    'To follow something else, tell me its number or its line (“08058”, “C4 Madrid”). /following to see what you follow.',
  español: 'Spanish',
  inglés: 'English',
  'De este chat no guardo nada: no sigues nada. Si sigues algo, guardaré el número de este chat, lo que sigues y desde cuándo; nada más (ni tu nombre ni tu teléfono). Se borra todo con /baja.':
    "I store nothing about this chat: you aren't following anything. If you follow something, I'll store this chat's number, what you follow and since when; nothing else (not your name or your phone number). /stop deletes it all.",
  'El idioma que has elegido sólo lo recuerdo en memoria, sin guardarlo, hasta que se reinicie el bot.':
    'I only keep the language you chose in memory, without storing it, until the bot restarts.',
  'Esto es todo lo que guardo de este chat:': 'This is everything I store about this chat:',
  '- Número del chat: {id}': '- Chat number: {id}',
  '- Desde: {when}': '- Since: {when}',
  '- Lo que sigues: {list}': '- Following: {list}',
  nada: 'nothing',
  '- Provincias: {list}': '- Provinces: {list}',
  ninguna: 'none',
  '- Parte diario: {hour}': '- Daily summary: {hour}',
  no: 'off',
  '- Idioma: {lang}': '- Language: {lang}',
  'En memoria, un rato y sin guardarlo: las listas de botones que te mando, cuántos mensajes me has escrito en el último minuto y si ya te he ofrecido el inglés.':
    "In memory, for a while and without storing it: the lists of buttons I send you, how many messages you have sent me in the last minute and whether I have already offered you English.",
  '- De cada cosa que sigues, desde cuándo y cuándo miré por última vez si había algo nuevo; del parte, el último día que te lo mandé; y, para no repetirte avisos, cuáles se han mandado ya de lo que sigues (eso, sin el número del chat).':
    "- For each thing you follow, since when and when I last checked for anything new; for the summary, the last day I sent it; and, so as not to repeat alerts, which ones have already been sent about what you follow (that, without the chat number).",
  'Nada más: ni tu nombre, ni tu usuario, ni tu teléfono. Lo uso sólo para avisarte y se borra con /baja (también si bloqueas el bot). Telegram, que transporta los mensajes, tiene su propia política de privacidad.':
    'Nothing else: not your name, your username or your phone number. I only use it to alert you, and /stop deletes it (so does blocking the bot). Telegram, which carries the messages, has its own privacy policy.',

  // ---------- Seguir, dejar, buscar, /estado, /parte, /baja… (follow-bot.js) ----------
  'Eso no es algo que se pueda seguir. Búscalo con /seguir o desde la web.': "That isn't something that can be followed. Look it up with /follow or on the website.",
  'Esa estación no la encuentro en el catálogo del radar. Búscala en el mapa y pulsa «Avísame por Telegram» en su ficha: {web}':
    "I can't find that station in the radar's catalogue. Find it on the map and tap “Alert me on Telegram” on its card: {web}",
  'Ya sigues {name}.': 'You already follow {name}.',
  'Ahora:': 'Now:',
  'Ahora no veo ninguna incidencia en ella, ni leve: comprueba que el nombre está bien escrito; si lo está, te aviso en cuanto haya algo.':
    'I can\'t see any incident on it right now, not even a minor one: check the name is spelt correctly; if it is, I\'ll alert you as soon as something happens.',
  'Ya sigues {n} cosas, el máximo. Deja alguna con /dejar.': 'You already follow {n} things, the maximum. Unfollow one with /unfollow.',
  'Ahora mismo no puedo atender a más gente. Prueba más tarde, por favor.': "I can't take on more people right now. Please try again later.",
  'Hecho: te aviso de {name}.': "Done: I'll alert you about {name}.",
  '/mis para ver lo que sigues · /dejar para dejar de seguirlo': '/following to see what you follow · /unfollow to stop following it',
  'Ya sigues los avisos de {province}.': 'You already follow the alerts for {province}.',
  'Ya sigues {n} provincias, el máximo. Deja alguna con /dejar.': 'You already follow {n} provinces, the maximum. Unfollow one with /unfollow.',
  'Hecho: te aviso en {province} de los avisos naranja y rojo de AEMET, de los terremotos que puedan sentirse y de los avisos oficiales (planes de emergencia y cortes de luz).':
    "Done: I'll alert you in {province} about orange and red AEMET weather warnings, earthquakes that may be felt and official notices (emergency plans and power cuts).",
  'La zona de cada provincia es aproximada: cerca de su límite puede llegarte alguno de la vecina.':
    "Each province's area is approximate: near its border you may get some from the neighbouring one.",
  'Ya sigues los avisos de {province} (con focos de calor).': 'You already follow the alerts for {province} (with hotspots).',
  '(con focos de calor)': '(with hotspots)',
  'Hecho: en {province} ahora también te aviso de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio confirmado. Para quitarlos: /provincia {province} sin incendios':
    "Done: in {province} I'll now also alert you about hotspots detected by satellite that may be a wildfire: only the clearest ones, and they are never a confirmed fire. To remove them: /province {province} no fires",
  'No sigues {province}. Para seguirla: /provincia {province}': "You don't follow {province}. To follow it: /province {province}",
  'En {province} no te aviso de los focos de calor; del resto de sus avisos, sí.': "In {province} I don't alert you about hotspots; I do about the rest of its alerts.",
  'Hecho: en {province} ya no te aviso de los focos de calor; del resto de sus avisos, sí.':
    "Done: in {province} I'll no longer alert you about hotspots; I still will about the rest of its alerts.",
  'No encuentro ningún vehículo ni línea así. Si es una carretera, para sus cortes y accidentes: /carretera {road}':
    "I can't find any vehicle or line like that. If it's a road, for its closures and accidents: /road {road}",
  'Ese trayecto no lo puedo seguir: alguna de sus estaciones no está en el catálogo del radar. Escríbelo con /trayecto.':
    "I can't follow that journey: one of its stations isn't in the radar's catalogue. Write it with /journey.",
  'Con esos nombres hay {total} trayectos posibles; aquí van los {n} primeros. Si no está el tuyo, escribe el nombre entero de las estaciones. ¿Cuál es?':
    "With those names there are {total} possible journeys; here are the first {n}. If yours isn't here, write the full names of the stations. Which one is it?",
  'Hay varias estaciones con esos nombres. ¿Cuál es tu trayecto?': 'There are several stations with those names. Which one is your journey?',
  'Dime también la provincia: /provincia Granada incendios (o, para quitarlos, /provincia Granada sin incendios).':
    'Tell me the province too: /province Granada fires (or, to remove them, /province Granada no fires).',
  '{island} es de la provincia de {province}: sigues la provincia entera, también sus otras islas.':
    '{island} belongs to the province of {province}: you follow the whole province, its other islands too.',
  'Ahora no veo ningún tren que vaya de {origin} a {destination}: si no hay trenes directos entre ellas, no te llegará nada; comprueba las estaciones.':
    "Right now I can't see any train going from {origin} to {destination}: if there are no direct trains between them, you won't get anything; check the stations.",
  'No sigues nada.': "You aren't following anything.",
  'Eso ya no lo sigues.': 'You no longer follow that.',
  'Hecho: ya no te aviso de {name}.': "Done: I'll no longer alert you about {name}.",
  'No sigues nada más, así que no guardo nada de este chat.': "You aren't following anything else, so I don't store anything about this chat.",
  'Hecho: ya no te mando los avisos de {province}.': "Done: I'll no longer send you the alerts for {province}.",
  'Hecho: ya no te aviso de la {road}.': "Done: I'll no longer alert you about the {road}.",
  'Hecho: ya no te aviso de la {road} en {province}.': "Done: I'll no longer alert you about the {road} in {province}.",
  'Dime qué quieres seguir: un número de tren («08058»), una línea con su ciudad u operador («C4 Madrid», «27 EMT Málaga») o una provincia (/provincia Valencia).':
    'Tell me what you want to follow: a train number (“08058”), a line with its city or operator (“C4 Madrid”, “27 EMT Málaga”) or a province (/province Valencia).',
  'No encuentro nada así entre lo que circula ahora o ha circulado hace poco. Prueba con el número («08058»), la línea y su ciudad u operador («C4 Madrid»), o búscalo en el mapa y pulsa «Avísame por Telegram» en su ficha: {web}':
    "I can't find anything like that among what is running now or ran recently. Try the number (“08058”), the line and its city or operator (“C4 Madrid”), or find it on the map and tap “Alert me on Telegram” on its card: {web}",
  '¿Quieres seguir esto?': 'Do you want to follow this?',
  'He encontrado {total}; aquí van las {n} primeras. Si no está la que buscas, añade la ciudad o el operador («C1 Madrid», «27 EMT Málaga»). ¿Cuál quieres seguir?':
    "I found {total}; here are the first {n}. If the one you want isn't here, add the city or the operator (“C1 Madrid”, “27 EMT Málaga”). Which one do you want to follow?",
  'He encontrado varias cosas. ¿Cuál quieres seguir?': 'I found several things. Which one do you want to follow?',
  'No sigues nada todavía. Dime qué quieres seguir con /seguir, o mira cómo va algo: /estado 08058.':
    "You aren't following anything yet. Tell me what to follow with /follow, or check how something is doing: /status 08058.",
  'No encuentro nada así entre lo que circula ahora o ha circulado hace poco.': "I can't find anything like that among what is running now or ran recently.",
  '…y otra cosa que no cabe aquí: pídela con /estado y su nombre, o mírala en la web.':
    "…and one more thing that doesn't fit here: ask for it with /status and its name, or check it on the website.",
  '…y {n} cosas más que no caben aquí: pídelas con /estado y su nombre, o míralas en la web.':
    "…and {n} more things that don't fit here: ask for them with /status and their name, or check them on the website.",
  'Dime la provincia: /provincia Valencia, /provincia A Coruña, /provincia Bizkaia…': 'Tell me the province: /province Valencia, /province A Coruña, /province Bizkaia…',
  'No conozco la provincia «{name}». Escríbela como en el mapa: /provincia Valencia, /provincia Illes Balears…':
    "I don't know the province “{name}”. Write it as on the map: /province Valencia, /province Illes Balears…",
  'No sigues nada. Dime qué quieres seguir con /seguir.': "You aren't following anything. Tell me what to follow with /follow.",
  'Sigues:': 'Following:',
  'Parte diario: a las {hour}.': 'Daily summary: at {hour}.',
  'Para dejar algo: /dejar (o /dejar y su número).': 'To unfollow something: /unfollow (or /unfollow and its number).',
  'En tu lista no hay un {n}: sólo tiene el 1. ¿Qué quieres dejar de seguir?': 'There is no {n} in your list: it only has 1. What do you want to unfollow?',
  'En tu lista no hay un {n}: va del 1 al {max}. ¿Qué quieres dejar de seguir?': 'There is no {n} in your list: it goes from 1 to {max}. What do you want to unfollow?',
  '¿Qué quieres dejar de seguir?': 'What do you want to unfollow?',
  'Primero sigue algo (/seguir): el parte cuenta cómo va lo que sigues.': 'Follow something first (/follow): the daily summary tells you how what you follow is doing.',
  'Hecho: ya no te mando el parte diario.': "Done: I'll no longer send you the daily summary.",
  'Dime la hora, en hora peninsular: /parte 07:30. Para quitarlo: /parte no.': 'Tell me the time, in mainland Spain time: /summary 07:30. To turn it off: /summary off.',
  'Hecho: cada día a las {hour} (hora peninsular) te mando cómo va lo que sigues.':
    "Done: every day at {hour} (mainland Spain time) I'll send you how what you follow is doing.",
  'Hecho: he borrado todo lo de este chat. Si vuelves a seguir algo, empezará de cero.':
    "Done: I've deleted everything about this chat. If you follow something again, it will start from scratch.",
  'De este chat no tenía nada guardado.': 'I had nothing stored about this chat.',
  'Parte de las {hour}:': 'Daily summary, {hour}:',
  '¿En qué idioma te escribo?': 'Which language should I write in?',
  'Hecho: a partir de ahora te escribo en {lang}. /ayuda para ver lo que hago; /idioma para cambiarlo.':
    "Done: from now on I'll write to you in {lang}. /help to see what I do; /language to change it.",
  '¿Prefieres que te escriba en inglés? Pulsa el botón, o escribe /idioma cuando quieras.':
    'Would you like me to write in English? Tap the button, or send /language at any time.',
  Hecho: 'Done',
  'Esa lista ya no vale: es de antes (has pedido otra después o ha pasado mucho rato). Vuelve a buscarlo, por favor.':
    "That list is no longer valid: it's an old one (you've asked for another since, or too much time has passed). Please look it up again.",
  'Lista caducada': 'List expired',
  'No está en la lista': 'Not in the list',
  'Demasiados mensajes seguidos. Espera un minuto, por favor.': 'Too many messages in a row. Please wait a minute.',
  'No conozco esa orden. Mira /ayuda.': "I don't know that command. See /help.",

  // ---------- Avisos y estado de lo que se sigue (avisos.js) ----------
  'Por esta estación pasaba a las {time}.': 'It was due to call at this station at {time}.',
  'Por esta estación pasaba a las {time} (es una de las suprimidas).': 'It was due to call at this station at {time} (one of the skipped stops).',
  'No se sabe si circula: su operador no publica nada de él.': "It isn't known whether it is running: its operator publishes nothing about it.",
  'Motivo: {reason}': 'Reason: {reason}',
  'Aviso del operador: {notice}': 'Operator notice: {notice}',
  'de {origin} a {destination}': 'from {origin} to {destination}',
  'hacia {destination}': 'towards {destination}',
  'Próxima parada: {stop}.': 'Next stop: {stop}.',
  '{name} va con {n} min de retraso': '{name} is running {n} min late',
  'desde {when}': 'from {when}',
  'hasta {when}': 'until {when}',
  'Emitido el {when}.': 'Issued {when}.',
  'hora de Canarias': 'Canary Islands time',
  '{title}, el {when}. Por su magnitud puede sentirse hasta a unos {km} km, y {province} queda dentro.':
    '{title}, on {when}. Given its magnitude it may be felt up to about {km} km away, which includes {province}.',
  'Corte de luz: {notice}.': 'Power cut: {notice}.',
  'Aviso oficial: {notice}.': 'Official notice: {notice}.',
  '…y {n} más.': '…and {n} more.',
  'Más en {web}': 'More at {web}',
  '…y {n} más que no caben aquí.': "…and {n} more that don't fit here.",
  'Esa provincia no la conozco.': "I don't know that province.",
  'Ahora no hay avisos naranja o rojo de AEMET, terremotos que puedan sentirse ni avisos oficiales en {province}.':
    'There are no orange or red AEMET weather warnings, earthquakes that may be felt or official notices in {province} right now.',
  'con retraso (no dice cuánto)': "late (it doesn't say by how much)",
  'sin dato de retraso': 'with no delay data',
  'con {n} min de retraso': '{n} min late',
  'con {n} min': '{n} min late',
  'en hora': 'on time',
  '{name}: circula {delay}': '{name}: running {delay}',
  '{title}: no se sabe si circula.': "{title}: it isn't known whether it is running.",
  '{title} (su operador ya no lo publica: puede que al final circule).': '{title} (its operator no longer publishes it: it may run after all).',
  'Ahora no se ve circulando: puede que no le toque a esta hora o que su operador no lo publique.':
    "It isn't running right now: it may not be due at this time, or its operator may not publish it.",
  'lleva 5 min o más de retraso': 'it is 5 min or more late',
  'no lleva 5 min o más de retraso': 'it is less than 5 min late',
  '{late} de los {n} que dicen su retraso llevan 5 min o más': '5 min or more late: {late} of the {n} that report their delay',
  'Ahora circula 1 {noun}': '1 {noun} running now',
  'Ahora circulan {n} {nouns}': '{n} {nouns} running now',
  'Ahora no se ve ninguno circulando.': 'None running right now.',
  'Cancelados o con paradas suprimidas hoy: {n}.': 'Cancelled or with skipped stops today: {n}.',
  '- {title} (ya no lo publica)': '- {title} (no longer published)',
  'Aviso: {title}: {notice}': 'Notice: {title}: {notice}',
  'Esa estación no la encuentro ahora en el catálogo del radar.': "I can't find that station in the radar's catalogue right now.",
  'Hoy no hay cancelaciones en vigor ni servicios sin datos que pasen por {station}.': 'Today there are no current cancellations or services with no data due to call at {station}.',
  'Pasaban hoy por {station} y su operador no publica nada de ellos (sin datos): {missing}.':
    'Due to call at {station} today, with nothing published by their operator (no data): {missing}.',
  'Pasaban hoy por {station} y están cancelados o con paradas suprimidas: {cancelled}.': 'Due to call at {station} today and cancelled or with skipped stops: {cancelled}.',
  'Pasaban hoy por {station} y están cancelados o con paradas suprimidas: {cancelled}; sin datos: {missing}.':
    'Due to call at {station} today and cancelled or with skipped stops: {cancelled}; no data: {missing}.',
  '- {title} (aquí a las {time})': '- {title} (here at {time})',
  'Además, {n} que se había cancelado y su operador ya no publica: puede que al final circule.':
    'Also, {n} that had been cancelled and that its operator no longer publishes: it may run after all.',
  'Además, {n} que se habían cancelado y su operador ya no publica: puede que al final circulen.':
    'Also, {n} that had been cancelled and that their operator no longer publishes: they may run after all.',
  'Avisos de Renfe en la estación:': 'Renfe notices at the station:',
  'Focos de calor por satélite: ahora ninguno de los que aviso (confianza alta y potencia alta).':
    'Satellite hotspots: none of the ones I alert about right now (high confidence and high power).',

  // ---------- Provincias: apagones de las islas y focos de calor (zona.js) ----------
  'También te aviso de los posibles apagones que se ven en la demanda eléctrica de cada isla (una estimación de Radar España con datos de Red Eléctrica).':
    'I also alert you about possible blackouts seen in the electricity demand of each island (a Radar España estimate with Red Eléctrica data).',
  'También te aviso de los posibles apagones que se ven en la demanda eléctrica de {province} (una estimación de Radar España con datos de Red Eléctrica).':
    'I also alert you about possible blackouts seen in the electricity demand of {province} (a Radar España estimate with Red Eléctrica data).',
  Y: 'And',
  'También te aviso': 'I also alert you',
  'de los focos de calor que detecta el satélite y pueden ser un incendio: sólo los más claros, y nunca son un incendio confirmado. Para quitarlos: /provincia {province} sin incendios':
    'about hotspots detected by satellite that may be a wildfire: only the clearest ones, and they are never a confirmed fire. To remove them: /province {province} no fires',
  'Si quieres también los focos de calor que detecta el satélite (posibles incendios, sin confirmar): /provincia {province} incendios':
    'If you also want hotspots detected by satellite (possible wildfires, unconfirmed): /province {province} fires',
  'una quema agrícola, actividad volcánica o una fuente de calor industrial': 'an agricultural burn, volcanic activity or an industrial heat source',
  'una quema agrícola o una fuente de calor industrial': 'an agricultural burn or an industrial heat source',
  'un foco de calor de {mw} MW, detectado el {when}': 'a {mw} MW hotspot, detected {when}',
  '{n} focos de calor en la zona, el más fuerte de {mw} MW; el último, detectado el {when}': '{n} hotspots in the area, the strongest {mw} MW; the latest detected {when}',
  'Posible incendio: {what}. Es una detección por satélite, no un incendio confirmado: también puede ser {also}. Dónde: {map}':
    'Possible wildfire: {what}. It is a satellite detection, not a confirmed fire: it may also be {also}. Where: {map}',

  // ---------- Carreteras (trafico.js) ----------
  'Datos de la DGT, del Servei Català de Trànsit y de Tráfico de Euskadi.': 'Data from the DGT, the Servei Català de Trànsit and Tráfico de Euskadi.',
  'También de los cortes de carretera y de los accidentes graves (no de las obras ni de las retenciones).':
    'Also about road closures and serious accidents (not roadworks or traffic queues).',
  'Dime también la carretera, por ejemplo: /carretera A-7 {province}. Para los avisos de toda la provincia: /provincia {province}.':
    'Tell me the road too, for example: /road A-7 {province}. For the alerts for the whole province: /province {province}.',
  'Dime la carretera': 'Tell me the road',
  'No entiendo qué carretera es «{road}». Escríbela como en las señales': "I don't understand which road “{road}” is. Write it as on the road signs",
  '/carretera A-7, /carretera N-340. Si sólo te interesa una provincia, añádela: /carretera AP-7 Tarragona.':
    '/road A-7, /road N-340. If you only want one province, add it: /road AP-7 Tarragona.',
  'Te aviso de sus cortes, sus accidentes y sus incidencias de gravedad alta o muy alta; de las obras, sólo si la cortan.':
    'I alert you about its closures, its accidents and its incidents of high or very high severity; about roadworks, only if they close it.',
  'Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de la {road} en {province}; de las obras, sólo si cortan la carretera.':
    "Done: I'll alert you about closures, accidents and incidents of high or very high severity on the {road} in {province}; about roadworks, only if they close the road.",
  'Hecho: te aviso de los cortes, los accidentes y las incidencias de gravedad alta o muy alta de la {road}; de las obras, sólo si cortan la carretera.':
    "Done: I'll alert you about closures, accidents and incidents of high or very high severity on the {road}; about roadworks, only if they close the road.",
  'Si sólo te interesa una provincia, escribe /carretera {road} y su nombre.': 'If you only want one province, send /road {road} and its name.',
  'Carretera cortada.': 'Road closed.',
  'Gravedad: alta.': 'Severity: high.',
  'Gravedad: muy alta.': 'Severity: very high.',
  'Desde las {time}.': 'Since {time}.',
  'Desde el {date}.': 'Since {date}.',
  'Prevista hasta las {time}.': 'Expected until {time}.',
  'Prevista hasta el {date}.': 'Expected until {date}.',
  'Esa carretera no la conozco.': "I don't know that road.",
  'Ahora no hay cortes, accidentes ni incidencias graves en la {road}.': 'There are no closures, accidents or serious incidents on the {road} right now.',
  'Ahora hay 1 corte, accidente o incidencia grave en la {road}:': 'There is 1 closure, accident or serious incident on the {road} right now:',
  'Ahora hay {n} cortes, accidentes o incidencias graves en la {road}:': 'There are {n} closures, accidents or serious incidents on the {road} right now:',
  'Además, 1 incidencia más leve (obras sin corte, retenciones…), en el mapa.': 'Also 1 minor incident (roadworks without a closure, traffic queues…), on the map.',
  'Además, {n} incidencias más leves (obras sin corte, retenciones…), en el mapa.': 'Also {n} minor incidents (roadworks without a closure, traffic queues…), on the map.',
  'Carreteras: ahora no hay cortes ni accidentes graves.': 'Roads: no closures or serious accidents right now.',
  'Carreteras: 1 corte o accidente grave.': 'Roads: 1 closure or serious accident.',
  'Carreteras: {n} cortes o accidentes graves.': 'Roads: {n} closures or serious accidents.',

  // ---------- Trayectos (trayectos.js) ----------
  '/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V': '/journey Alcalá de Henares > Atocha 7:00-9:00 Mon-Fri',
  'Dime las dos estaciones, la franja en la que sales y los días:\n{example}': 'Tell me the two stations, the time window you leave in and the days:\n{example}',
  'Te aviso de los trenes que paran en las dos y salen de la primera en esa franja: si se cancelan o no paran en alguna de las dos, si van con {delay} min de retraso o más (y otra vez si empeora) y si su operador no publica nada de ellos.':
    'I alert you about the trains that stop at both and leave the first one in that time window: if they are cancelled or skip either of them, if they are {delay} min or more late (and again if it gets worse) and if their operator publishes nothing about them.',
  'Los días: L-V, S-D, L,X,V, «laborables»… Sin días, todos. Las estaciones, como en el mapa; si hay varias con ese nombre, te pregunto cuál.':
    'Days: Mon-Fri, Sat-Sun, Mon,Wed,Fri, “weekdays”… With no days, every day. Stations as on the map; if several have that name, I will ask you which one.',
  'Separa las dos estaciones con «>»:\n{example}': 'Separate the two stations with “>”:\n{example}',
  'Dime la estación de origen y la de destino:\n{example}': 'Tell me the departure and arrival stations:\n{example}',
  'Dime también la franja en la que sales del origen, de una hora a otra:\n{example}': 'Also tell me the time window when you leave the first station, from one time to another:\n{example}',
  'La franja tiene que ir de una hora a otra más tarde del mismo día, como 7:00-9:00 (como mucho, hasta las 23:59).':
    'The time window must go from one time to a later one on the same day, such as 7:00-9:00 (until 23:59 at the latest).',
  'No entiendo los días «{days}». Escríbelos así: L-V, S-D, L,X,V, «laborables» o «todos».':
    "I don't understand the days “{days}”. Write them like this: Mon-Fri, Sat-Sun, Mon,Wed,Fri, “weekdays” or “every day”.",
  'No encuentro la estación «{name}» en el catálogo del radar. Escríbela como en el mapa («Alcalá de Henares», «Madrid-Atocha Cercanías»).':
    "I can't find the station “{name}” in the radar's catalogue. Write it as on the map (“Alcalá de Henares”, “Madrid-Atocha Cercanías”).",
  'El origen y el destino son la misma estación.': 'The departure and arrival stations are the same.',
  '{origin} y {destination} no son de la misma red: ningún tren para en las dos.': '{origin} and {destination} are not on the same network: no train stops at both.',
  'No entiendo ese trayecto. Escríbelo así:\n{example}': "I don't understand that journey. Write it like this:\n{example}",
  'Un tren': 'A train',
  'el de las {time} en {station}': 'the {time} from {station}',
  'el de las {time} en {station} (hora aproximada)': 'the {time} from {station} (approximate time)',
  'No para en {station}': 'It skips {station}',
  'No para en {origin} ni en {destination}': 'It skips {origin} and {destination}',
  'no para en {station}': 'skips {station}',
  'no para en {origin} ni en {destination}': 'skips {origin} and {destination}',
  'Pasaba por {station} a las {time}.': 'It was due to call at {station} at {time}.',
  '{train}, {which}, va con {n} min de retraso.': '{train}, {which}, is running {n} min late.',
  'Alguna de las estaciones de este trayecto ya no está en el catálogo del radar.': "One of this journey's stations is no longer in the radar's catalogue.",
  'Hoy no es uno de tus días: te aviso {days}.': "Today isn't one of your days ({days}).",
  'Ahora no se ve ningún tren de tu franja de {origin} a {destination}. Los trenes salen aquí cuando empiezan su recorrido, y las cancelaciones, cuando su operador las publica.':
    'No trains in your time window from {origin} to {destination} are visible right now. Trains appear here when they start their trip, and cancellations when their operator publishes them.',
  'Trenes de tu franja que se ven ahora (hora en {station}):': 'Trains in your time window visible now (time at {station}):',
  '{time} (aprox.)': '{time} (approx.)',
  'ya ha salido de {station}': 'has already left {station}',
  cancelado: 'cancelled',
  'sin datos, su operador no publica nada de él': 'no data, its operator publishes nothing about it',
};
