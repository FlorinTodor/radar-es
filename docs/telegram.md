# Bot de Telegram «Sigue tu tren»

Quien escribe al bot puede seguir cualquier vehículo que publique el radar (un tren, un autobús, un metro, un
tranvía y los tipos que se añadan), su línea, una estación o una provincia. El bot le avisa:

- si lo que sigue se cancela o se le suprimen paradas;
- si va con 15 minutos o más de retraso, y otra vez cada 15 minutos más (cuando empeora; si recupera, no);
- si su operador deja de publicar sus datos (trenes «sin datos»);
- de los avisos del operador sobre su línea;
- en una estación, de los trenes cancelados o sin datos que pasan por ella y de los avisos de Renfe de la estación
  (ascensores fuera de servicio, accesos cerrados…), los mismos que enseña su ficha en la web;
- en una provincia, de los avisos naranja y rojo de AEMET, los terremotos que pueden sentirse y los avisos
  oficiales (planes de emergencia y cortes de luz); en Canarias, Ceuta y Melilla, también de los posibles apagones
  que se ven en la demanda eléctrica de cada isla; y, si los pide (`/provincia Granada incendios`), de los focos de
  calor por satélite que pueden ser un incendio ([más abajo](#provincias-apagones-y-focos-de-calor)).

Con `/parte 07:30` manda cada día un resumen de lo que sigue. El parte y `/estado` cuentan cada cosa entera: si no
caben en un mensaje, van en varios (hasta 6) y, si ni así, dicen cuántas cosas quedan fuera. Lo que se puede seguir son las claves de
[`docs/vehiculos.md`](vehiculos.md): el bot no sabe de qué fuente ni de qué tipo es cada vehículo, así que un
tipo nuevo funciona sin tocarlo.

Desde la web, la ficha de cada vehículo, cancelación, tren sin datos o estación lleva «Avísame por Telegram»:
abre el bot con `t.me/<bot>?start=<clave>` y lo sigue con un toque.

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
     línea y de tu provincia. Datos públicos de los operadores; no es un servicio oficial.»
   - `/setabouttext`: «Avisos de trenes, autobuses, metro y tranvía de radarespana.es.»
   - `/setuserpic`: el icono de la web.
   - `/setjoingroups` → `Disable`: el bot sólo atiende chats privados.
   - `/setcommands`: no hace falta, porque el servidor pone el menú al arrancar. Si quieres ponerlo a mano:

     ```
     seguir - Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid
     estado - Cómo va ahora lo que sigues, o lo que busques
     provincia - Avisos de tu provincia: AEMET, terremotos y emergencias
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
  que no está en el catálogo no se sigue.
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
- **Topes**: 20.000 chats y 20 cosas por chat, de ellas 5 provincias como mucho. Una cola de 5.000 mensajes:
  si se llena, se tiran los más viejos y se apunta en el registro.
- **Las provincias son círculos aproximados**, uno por isla en Baleares y Canarias
  (`server/domain/provincias.js`). Cerca de un límite puede llegar algún aviso de la vecina, y así se avisa al
  seguir una. Se puede escribir la isla (`/provincia La Palma`, `/provincia Menorca`): se sigue su provincia.
- **Un aviso no se repite en la misma ronda**: si un chat sigue una estación y la línea de la que habla un aviso de
  Renfe, le llega en uno de los dos mensajes. Las cancelaciones sí van en cada cosa a la que afectan, con lo suyo
  (la hora en esa estación).

Código:

- dominio: `server/domain/seguidos/` (lo de las provincias, en `zona.js`; lo de las estaciones, en `estacion.js`),
  `server/domain/provincias.js` y `server/domain/avisos-estacion.js`;
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
