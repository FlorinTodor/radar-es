# Bot de Telegram «Sigue tu tren»

Quien escribe al bot puede seguir cualquier vehículo que publique el radar (un tren, un autobús, un metro, un
tranvía y los tipos que se añadan), su línea, una estación, una provincia o una carretera. El bot le avisa:

- si lo que sigue se cancela o se le suprimen paradas;
- si va con 15 minutos o más de retraso, y otra vez cada 15 minutos más (cuando empeora; si recupera, no);
- si su operador deja de publicar sus datos (trenes «sin datos»);
- de los avisos del operador sobre su línea;
- en una estación, de los trenes cancelados o sin datos que pasan por ella y de los avisos de Renfe de la estación
  (ascensores fuera de servicio, accesos cerrados…), los mismos que enseña su ficha en la web;
- en una provincia, de los avisos naranja y rojo de AEMET, los terremotos que pueden sentirse, los avisos
  oficiales (planes de emergencia y cortes de luz) y los cortes de carretera y accidentes graves; en Canarias, Ceuta
  y Melilla, también de los posibles apagones que se ven en la demanda eléctrica de cada isla; y, si los pide
  (`/provincia Granada incendios`), de los focos de calor por satélite que pueden ser un incendio
  ([más abajo](#provincias-apagones-y-focos-de-calor));
- en una carretera (`/carretera A-7`, o `/carretera A-7 Málaga` para un tramo), de sus cortes, sus accidentes y
  sus incidencias de gravedad alta o muy alta. Ver [Tráfico](#tráfico).

Con `/parte 07:30` manda cada día un resumen de lo que sigue. El parte y `/estado` cuentan cada cosa entera: si no
caben en un mensaje, van en varios (hasta 6) y, si ni así, dicen cuántas cosas quedan fuera. Lo que se puede seguir son las claves de
[`docs/vehiculos.md`](vehiculos.md): el bot no sabe de qué fuente ni de qué tipo es cada vehículo, así que un
tipo nuevo funciona sin tocarlo.

Desde la web, la ficha de cada vehículo, cancelación, tren sin datos o estación lleva «Avísame por Telegram»:
abre el bot con `t.me/<bot>?start=<clave>` y lo sigue con un toque. La de una incidencia de tráfico, igual con
su carretera entera (`start=c-A7`).

## Crear el bot (una vez)

Tiene que ser **un bot nuevo**, distinto del que manda las alertas de la monitorización: ése sólo envía, y este
otro lee lo que le escribe la gente.

1. En Telegram, abre [@BotFather](https://t.me/BotFather) y escribe `/newbot`.
2. Nombre (lo que se ve): `Radar España`.
3. Usuario (único, acaba en `bot`): por ejemplo `RadarEspanaBot`.
4. BotFather contesta con el **token** (`123456789:AA…`). Es la contraseña del bot: no lo pegues en ningún
   chat, issue ni commit.
5. Opcional, también en BotFather:
   - `/setdescription`: «Te aviso de lo que sigas en Radar España: cancelaciones, retrasos, avisos de tu
     línea y de tu provincia, y cortes y accidentes de tu carretera. Datos públicos de los operadores y de
     tráfico; no es un servicio oficial.»
   - `/setabouttext`: «Avisos de trenes, autobuses, metro y tranvía de radarespana.es.»
   - `/setuserpic`: el icono de la web.
   - `/setjoingroups` → `Disable`: el bot sólo atiende chats privados.
   - `/setcommands`: no hace falta, porque el servidor pone el menú al arrancar. Si quieres ponerlo a mano:

     ```
     seguir - Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid
     trayecto - Tus trenes de una estación a otra: /trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V
     estado - Cómo va ahora lo que sigues, o lo que busques
     provincia - Avisos de tu provincia: AEMET, terremotos y emergencias
     carretera - Cortes y accidentes de una carretera: /carretera A-7, /carretera AP-7 Tarragona
     mis - Lo que sigues
     dejar - Dejar de seguir algo
     parte - Un resumen cada día a la hora que digas: /parte 07:30
     datos - Qué guardo de este chat
     baja - Borrar todo lo de este chat
     ayuda - Cómo funciona
     ```

## Ponerlo en marcha

El token va en el `.env` del servidor, que no está en git:

```
TELEGRAM_BOT_TOKEN=123456789:AA…
TELEGRAM_BOT_USERNAME=RadarEspanaBot
```

- **Producción**: `/opt/radar/.env`. Edítalo tú, conectado al VPS (`nano /opt/radar/.env`), o con `!` desde
  Claude Code. En ese caso el token queda en la conversación.
- **Pruebas** (`/opt/radar-pruebas/.env`): **otro bot** (por ejemplo `RadarEspanaPruebasBot`) o ninguno. Con
  el mismo token, los dos servidores leerían el mismo bot: Telegram corta a uno (error 409) y los dos
  mandarían los mismos avisos. Por eso `deploy/preparar-pruebas.sh`, que copia el `.env` de producción, deja
  fuera `TELEGRAM_BOT_TOKEN` y `TELEGRAM_BOT_USERNAME`.
- `TELEGRAM_BOT_USERNAME` sólo hace falta para el botón de la web. Sin él, el bot funciona igual.
- `TELEGRAM_WEB_URL` (opcional) es la web que citan los mensajes: por defecto, `https://radarespana.es`.

El `.env` se lee al crear el contenedor. Se aplica en el siguiente despliegue: el relevo crea el contenedor
nuevo con el `.env` nuevo, sin corte. Sin token, el registro dice `[telegram] bot desactivado: falta
TELEGRAM_BOT_TOKEN` y la web no enseña el botón.

## Mi trayecto

Además de un tren, una línea o una estación, el bot sigue el trayecto de cada día:
`/trayecto Alcalá de Henares > Atocha 7:00-9:00 L-V` sigue los trenes que **paran en el origen y luego en el
destino** y **salen del origen en esa franja**, uno de esos días. No hace falta saber su número.

- **Cómo se escribe**: las dos estaciones separadas por `>` (o `→`), la franja (`7:00-9:00`, `7-9`, `de 7 a
  9:30`) y los días (`L-V`, `S-D`, `L,X,V`, `LXV`, `V-L`, `laborables`, `fin de semana`; sin días, todos). Los
  días pueden ir antes o después de la franja. La franja va de una hora a otra más tarde del mismo día. Escrito
  sin orden («Alcalá > Atocha 7-9»), también vale.
- **Las estaciones** salen del catálogo del radar (las de Renfe y las de las redes de metro y tranvía), como en el
  mapa. Si el nombre es el de una estación tal cual, ésa; si no, todas las que tienen esas palabras en su nombre,
  su ciudad o su red. Si con esos nombres hay más de un trayecto posible (hay dos «Atocha»), el bot pregunta con
  una lista de combinaciones, sólo de estaciones distintas y de la misma red.
- **Qué avisa**, de los trenes del trayecto:
  - si se cancelan, o si se les suprime la parada del origen o la del destino (las demás paradas suprimidas, no);
  - si van con 15 minutos de retraso o más, y otra vez cada 15 más (como un tren seguido: si mejora, no);
  - si su operador no publica nada de ellos («sin datos»), mientras según su horario no hayan llegado al destino.

  Los avisos salen en la misma ronda que los demás, uno por trayecto con lo nuevo; lo que ya había al seguirlo se
  cuenta en la respuesta y no se avisa. De una cancelación de un tren que según su horario ya habría llegado al
  destino no se avisa: a esas horas ya no sirve.
- **`/estado` y el parte** dicen los trenes de la franja que se ven ahora, por su hora en el origen: los que
  circulan, con su retraso y su próxima parada, y los cancelados, sin parar en el origen o el destino o sin datos
  (los que salían hace más de un cuarto de hora ya no salen). Un tren cancelado que se ve circulando sale una vez,
  como cancelado. Fuera de sus días lo dice; de noche, en general, no hay nada que contar: un tren se ve cuando
  empieza su recorrido, y una cancelación, cuando su operador la publica.
- **La hora en el origen**:
  - de las cancelaciones y los trenes sin datos, la de su horario;
  - de los trenes que circulan, la de su horario si la fuente la da (Alta Velocidad, Larga y Media Distancia,
    horarios GTFS). Si no, la que prevé su operador menos su retraso.
  - En Cercanías y Rodalies no hay ninguna de las dos (Renfe no publica la hora de cada parada en su tiempo real y
    el radar no guarda ese horario: son 140.000 viajes), así que se calcula por dónde va. Es lo que le falta hasta
    el origen por sus paradas, en línea recta, a 45 km/h, menos su retraso. Es aproximada y se dice así («hora
    aproximada», «aprox.»). Un tren justo en el borde de la franja puede entrar o no.
- **Qué fuentes valen**: cualquiera que diga las paradas de sus viajes con su nombre. Las estaciones se comparan
  como en su ficha de la web: mismo nombre y a menos de 3 km. Con lo que publica hoy cada una:
  - **Renfe** (Cercanías, Rodalies, AV, LD y MD): todo. Tiene cancelaciones con su horario, paradas suprimidas,
    retraso y trenes sin datos.
  - **Metros, tranvías y FGC**: sus trenes salen en `/estado`, pero de ellos no hay cancelaciones ni retraso que
    avisar. FGC sólo dice las paradas que le quedan.
  - Una fuente cuyas paradas se llaman de otra forma que en el catálogo (Ouigo: «Madrid-Puerta De Atocha») no
    encaja con esa estación.

  Los autobuses no entran: aún no hay catálogo de sus paradas.
- **Como lo demás que se sigue**: cuenta en el tope de cosas por chat, sale en `/mis`, `/dejar` y `/datos`, y en
  el panel del bot es un tipo más («Trayectos», y `/trayecto` entre las órdenes).
- **Lo que guarda** de un trayecto es lo mismo que de lo demás: su clave (el código de sus dos estaciones, la franja
  y los días; ver [vehiculos.md](vehiculos.md)) y su nombre, que los dice («Alcalá de Henares → Madrid-Atocha
  Cercanías (07:00-09:00, de lunes a viernes)»). La política de privacidad de `/legal` lo dice.
- **Cuánto cuesta**: en cada ronda sólo se miran las paradas de los trenes que van con retraso, y las
  cancelaciones salen del mismo índice de paradas que las estaciones seguidas. Para `/estado` y el parte se miran
  las de todos los que no van por carretera: como mucho una vez por minuto (y una sola vez para los partes de
  todos los chats de esa ronda).
- **Código**: `server/domain/seguidos/trayectos.js` (qué se escribe, qué trenes son, qué se avisa y cómo van) y
  `server/domain/seguidos/estaciones.js` (buscar una estación del catálogo por su nombre); en el caso de uso, la
  orden `/trayecto` y lo que pide a `query-situation` (las paradas de cada viaje y el catálogo de estaciones).

## Cómo funciona por dentro

- **Recibe por long polling** (`getUpdates`), no por webhook: no hay que abrir nada en Cloudflare ni en el
  túnel.
- **Envía por una cola** con los límites de Telegram: un mensaje por segundo a cada chat y unos 25 por segundo en
  total. Si Telegram pide esperar (`retry_after`), espera.
- **Avisa en rondas de un minuto**: un mensaje por cosa seguida con lo nuevo, nunca lo que ya había al empezar a
  seguirla. Lo que pasa por cada estación seguida sale de un índice de la ronda (nombre de parada → viajes
  cancelados o sin datos): seguir cientos de estaciones no alarga la ronda. En una estación, las cancelaciones que
  su operador ya no publica van aparte, como en su ficha de la web.
- **Los botones de cada lista llevan su id** (`a:<id>:<n>`): un botón de un mensaje anterior no escoge nada de la
  lista nueva, sólo contesta que esa lista ya no vale.
- **Un enlace se puede inventar** (`t.me/<bot>?start=<clave>`): de lo que no se ve ni está en el directorio no se
  repite el texto de su clave. Se nombra con lo que se puede comprobar (el operador si se conoce su red, el número,
  la hora, un código de línea corto) o con un nombre genérico, y se renueva en cuanto se vuelve a ver. Una estación
  que no está en el catálogo no se sigue. Una carretera sólo vale si su código lo parece (letras, una cifra y lo
  que siga) y su provincia existe; se nombra como la escribe su fuente si se ve, o por su código.
- **Charla**: «hola», «gracias», «vale»… escritos sin orden no se buscan (por el principio de una palabra, «hola»
  encontraba «Naciones-Holanda»). Una búsqueda con más resultados de los que caben en la lista dice cuántos hay
  y pide la ciudad o el operador; a igual encaje, primero trenes, metros y tranvías (orden del registro de tipos).
- **Atiende un solo servidor a la vez.** Durante un relevo hay dos contenedores, y un turno en
  `data/bot/turno.json` decide cuál atiende el bot. El que se apaga lo suelta y el nuevo lo coge.
- **Lo que guarda**, en `data/bot/seguidos.v1.json`:
  - el número de cada chat, lo que sigue (con su nombre y, en una provincia, si ha pedido los focos de calor), desde
    cuándo y la hora de su parte;
  - para no repetir avisos tras un reinicio, qué se ha avisado ya;
  - y los totales de uso (`totals`), sin ningún número de chat: altas, bajas por motivo, avisos y partes, y
    mensajes por orden, desde que se cuentan.

  Nada de nombres, usuarios ni teléfonos. Un chat que deja de seguirlo todo, escribe `/baja` o bloquea el bot
  se borra. La política de privacidad de `/legal` lo explica.
- **Cuánto se usa**, en el panel «Radar · Bot de Telegram» de la monitorización
  ([despliegue.md](despliegue.md#monitorización)):
  - las personas (cada chat privado que sigue algo), lo que siguen por tipo, quién pide el parte y lo más
    seguido, con cuántas personas lo siguen;
  - altas y bajas, avisos y mensajes por orden, de 24 horas, de cada día y desde el principio.

  Todo va en conjunto, sin el número de ningún chat (`server/domain/seguidos/uso.js`), y sólo lo da el
  servidor que atiende el bot. Los totales se guardan con lo demás: un reinicio o un relevo no los pone a 0,
  así que en Prometheus son la misma cifra antes y después de un despliegue, y lo de cada día es la resta
  exacta entre el total de ahora y el de hace 24 horas. El primer arranque con esta versión cuenta como altas a
  quienes ya seguían algo, desde la primera de ellas; las bajas de antes no constan. Lo único que se pierde
  es lo de un apagón brusco del contenedor (sin cerrarse bien), como mucho el último minuto, igual que lo
  que sigue cada chat. Las gráficas abarcan lo que guarda Prometheus: 30 días.
- **Topes**: 20.000 chats y 20 cosas por chat (las carreteras cuentan como una más), de ellas 5 provincias como
  mucho. Una cola de 5.000 mensajes: si se llena, se tiran los más viejos y se apunta en el registro.
- **Las provincias son círculos aproximados**, uno por isla en Baleares y Canarias
  (`server/domain/provincias.js`). Cerca de un límite puede llegar algún aviso de la vecina, y así se avisa al
  seguir una. Se puede escribir la isla (`/provincia La Palma`, `/provincia Menorca`): se sigue su provincia. El
  tráfico de la DGT usa la provincia que da ella (con los círculos, una de cada once caía en la vecina); el de
  Cataluña y Euskadi, que no la dan, el círculo.
- **Un aviso no se repite en la misma ronda**: si un chat sigue una estación y la línea de la que habla un aviso de
  Renfe, le llega en uno de los dos mensajes. Las cancelaciones sí van en cada cosa a la que afectan, con lo suyo
  (la hora en esa estación).

Código:

- dominio: `server/domain/seguidos/` (lo de las provincias, en `zona.js`; lo de las estaciones, en `estacion.js`;
  el tráfico, en `trafico.js`), `server/domain/provincias.js` y `server/domain/avisos-estacion.js`;
- caso de uso: `server/application/use-cases/follow-bot.js`;
- adaptadores: `server/adapters/inbound/telegram/` y `server/adapters/outbound/telegram/`, más el almacén y el
  turno en `server/adapters/outbound/persistence/`.

## Estaciones: avisos de Renfe

Qué aviso es de qué estación lo decide `server/domain/avisos-estacion.js`, el mismo módulo que usa la ficha de la
estación en la web (el servidor lo sirve tal cual al navegador): los avisos ferroviarios que llegan con las
coordenadas de la estación, a menos de 300 m, y una vez cada texto. Las estaciones de metro, tranvía y demás redes
no tienen avisos de Renfe. El texto va **sin alterar**, como pide la licencia de Renfe, con su atribución («Origen
de los datos: Renfe Operadora…»); los de Rodalies, con la suya.

## Provincias: apagones y focos de calor

**Apagones de las islas, Ceuta y Melilla.** Son las alertas «Posible apagón total en …» y «Demanda eléctrica de …
por debajo de lo esperado» del motor de alertas (`isolatedGridBlackouts` en `server/domain/alerts/rules.js`), que
el bot lee de las alertas abiertas y lleva a la provincia de cada isla (`server/domain/seguidos/zona.js`). Llegan a
quien sigue la provincia sin pedirlo, como los cortes de luz de los avisos oficiales. El texto dice la demanda, la
hora del dato y que es una estimación de Radar España, y cita «Fuente: Red Eléctrica», como la web. Si un corte
parcial pasa a total se vuelve a avisar; si un apagón total se queda en parcial al volver la luz, no. De Baleares no
hay: Red Eléctrica no publica su demanda real en tiempo real.

**Focos de calor (NASA FIRMS), sólo si se piden.** `/provincia Granada incendios` los añade (también a una provincia
que ya se sigue) y `/provincia Granada sin incendios` los quita. Son opcionales porque un foco no es un incendio
confirmado: quien sigue su provincia por los avisos oficiales no recibe, sin pedirlo, detecciones que pueden ser
una quema o una fábrica. Para que un aviso sea casi siempre un fuego de verdad:

- sólo focos de **confianza alta** (VIIRS: píxel saturado, la anomalía de calor más fuerte) y de **10 MW o más**
  de potencia radiativa: las quemas agrícolas suelen quedarse por debajo;
- fuera de las fuentes de calor fijas que el satélite ve a diario (refinerías, siderurgias y los volcanes de
  Canarias; lista `STATIC_HEAT` en `zona.js`, con círculos aproximados);
- encadenados a menos de 2 km, un grupo es un solo aviso, y sólo si su foco más fuerte llega a **30 MW** o junta
  **3 focos**: lo que el motor de alertas llama gravedad «alta» en un posible incendio cerca de trenes;
- sólo los de hoy (hora peninsular), no los de las últimas 12 horas como el motor de alertas: así nunca hay dos
  avisos de la misma zona el mismo día. El satélite pasa de madrugada y a primera hora de la tarde;
- **como mucho un aviso por zona** (casillas de unos 25 km) **y día**: aunque el fuego crezca o haya otro grupo en
  la misma zona, y aunque deje de verse un rato. Al día siguiente, si sigue, otro aviso.

Cada aviso dice siempre que es una detección por satélite y no un incendio confirmado, qué más puede ser (en
Canarias, también actividad volcánica), la potencia, la hora del último paso del satélite y un enlace al punto en
OpenStreetMap. Cita la fuente como la web: «NASA FIRMS (LANCE, ESDIS) · Datos de NASA sin restricciones de uso · No
apto para decisiones tácticas».

`/estado` y el parte cuentan los apagones y, a quien los ha pedido, los focos (`/estado Granada incendios` los
enseña a cualquiera).

## Tráfico

Las incidencias de carretera que ya enseña el mapa: la DGT, el Servei Català de Trànsit y Tráfico de Euskadi
(category `carretera`, sin los avisos de los autobuses). Hay más de mil a la vez, casi todas obras, así que el bot
avisa de pocas:

- **En una carretera seguida**: sus cortes, sus accidentes (todos) y lo que su fuente pone de gravedad alta o muy
  alta (retenciones graves, desprendimientos, viento…). Las obras, sólo si cortan la carretera.
- **En una provincia seguida**: sólo los cortes de carretera y los accidentes graves (de gravedad alta o muy alta,
  o que cortan). Los cortes por obras no: están previstos, y algunos vuelven cada noche con otro número; quien los
  quiera sigue esa carretera. Con los datos del 10-nov a las 22:00, eran 22 en toda España, y casi todos de hace
  días (los que ya hay al seguir una provincia no se avisan).
- **Sin repetir**: cada aviso se reconoce por lo que cuenta (su fuente, su título y su descripción), no por el
  número de su fuente. La DGT publica a veces la misma incidencia dos veces (una por sentido) o la vuelve a
  publicar con otro número: se avisa una. Si pasa a cortar la carretera, se avisa otra vez; si deja de cortarla,
  no.
- **Lo viejo no es nuevo**: una incidencia sin noticias (ni empieza ni su fuente la revisa) desde hace más de 6
  horas no se avisa aunque se vea por primera vez. Así, si una fuente cae más de tres horas (lo que se recuerda
  lo ya avisado) y vuelve, no llegan de golpe todos los cortes de la provincia, algunos de hace meses. En
  `/estado` y el parte sí sale todo lo que hay ahora.
- **Textos tal cual**: el título y la descripción de cada incidencia van como los da su fuente, juntados con
  « · » (las licencias de las tres piden no alterar el contenido; la de Open Data Euskadi, expresamente). Detrás,
  lo que añade el radar: «Carretera cortada.» si la fuente no lo dice en castellano, la gravedad si es alta o muy
  alta, desde cuándo y hasta cuándo está prevista. Cada mensaje lleva la atribución de su fuente, la misma que
  la ficha de la web (`license` de cada adaptador).
- **La clave** de una carretera es `c-<código>[-<provincia>]` (`c-A7`, `c-A7-malaga`), aparte de las de los
  vehículos: ver [vehiculos.md](vehiculos.md#carreteras-el-bot-de-telegram).
