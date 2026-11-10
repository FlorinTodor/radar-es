# Bot de Telegram «Sigue tu tren»

Quien escribe al bot puede seguir cualquier vehículo que publique el radar (un tren, un autobús, un metro, un
tranvía y los tipos que se añadan), su línea, una estación o una provincia. El bot le avisa:

- si lo que sigue se cancela o se le suprimen paradas;
- si va con 15 minutos o más de retraso, y otra vez cada 15 minutos más (cuando empeora; si recupera, no);
- si su operador deja de publicar sus datos (trenes «sin datos»);
- de los avisos del operador sobre su línea;
- en una provincia, de los avisos naranja y rojo de AEMET, los terremotos que pueden sentirse y los avisos
  oficiales (planes de emergencia y cortes de luz).

Con `/parte 07:30` manda cada día un resumen de lo que sigue. El parte y `/estado` cuentan cada cosa entera: si no
caben en un mensaje, van en varios (hasta 6) y, si ni así, dicen cuántas cosas quedan fuera. Lo que se puede seguir son las claves de
[`docs/vehiculos.md`](vehiculos.md): el bot no sabe de qué fuente ni de qué tipo es cada vehículo, así que un
tipo nuevo funciona sin tocarlo.

Desde la web, la ficha de cada vehículo, cancelación, tren sin datos o estación lleva «Avísame por Telegram»:
abre el bot con `t.me/<bot>?start=<clave>` y lo sigue con un toque.

Habla español y, si cada chat lo elige, inglés (ver [Idioma](#idioma)): con `/idioma` (o `/language`), con el botón
que ofrece al primer `/start` a quien tiene Telegram en otro idioma, o abriéndolo desde la web en inglés.

## Crear el bot (una vez)

Tiene que ser **un bot nuevo**, distinto del que manda las alertas de la monitorización: ése sólo envía, y este
otro lee lo que le escribe la gente.

1. En Telegram, abre [@BotFather](https://t.me/BotFather) y escribe `/newbot`.
2. Nombre (lo que se ve): `Radar España`.
3. Usuario (único, acaba en `bot`): por ejemplo `RadarEspanaBot`.
4. BotFather contesta con el **token** (`123456789:AA…`). Es la contraseña del bot: no lo pegues en ningún
   chat, issue ni commit.
5. Opcional, también en BotFather:
   - `/setuserpic`: el icono de la web.
   - `/setjoingroups` → `Disable`: el bot sólo atiende chats privados.
   - `/setdescription`, `/setabouttext` y `/setcommands`: no hace falta. El servidor pone al arrancar, en español
     (para todos) y en inglés (para quien tiene Telegram en inglés, con el `language_code` de la API), el menú de
     órdenes (`setMyCommands`), la descripción que se ve antes de escribirle (`setMyDescription`) y la de su perfil
     (`setMyShortDescription`). Lo que se ponga a mano en BotFather lo cambia el siguiente arranque. Los textos están
     en `server/domain/seguidos/ordenes.js` (`botProfiles`) y su traducción, en `server/domain/seguidos/en.js`:

     | | Español | English |
     |---|---|---|
     | Descripción | Te aviso de lo que sigas en Radar España: cancelaciones, retrasos, avisos de tu línea y de tu provincia. Datos públicos de los operadores; no es un servicio oficial. | I alert you about what you follow on Radar España: cancellations, delays, notices for your line and alerts for your province. Public data from the operators; not an official service. |
     | Perfil | Avisos de trenes, autobuses, metro y tranvía de radarespana.es. | Train, bus, metro and tram alerts from radarespana.es. |

     El menú en español usa las órdenes de siempre y, en inglés, sus nombres en inglés (las dos formas valen siempre):

     ```
     seguir    · follow     Seguir un tren, autobús, metro o línea: /seguir 08058, /seguir C4 Madrid
     estado    · status     Cómo va ahora lo que sigues, o lo que busques
     provincia · province   Avisos de tu provincia: AEMET, terremotos y emergencias
     mis       · following  Lo que sigues
     dejar     · unfollow   Dejar de seguir algo
     parte     · summary    Un resumen cada día a la hora que digas: /parte 07:30
     datos     · data       Qué guardo de este chat
     baja      · stop       Borrar todo lo de este chat
     idioma    · language   Cambiar de idioma: español o inglés
     ayuda     · help       Cómo funciona
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
  - el número de cada chat, lo que sigue (con su nombre), desde cuándo, la hora de su parte y su idioma (`lang`,
    sólo si no es el español);
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
  seguir una.

## Idioma

Cada chat tiene su idioma: español por defecto e inglés si lo elige. Mismo criterio que la web en inglés
(`public/js/i18n.js`).

- **Cómo se elige**:
  - `/idioma` (o `/language`) con sus botones «Español» / «English», o con el idioma escrito (`/idioma inglés`,
    `/language english`). Al cambiarlo, el bot pone también el menú de órdenes de ese chat en su idioma;
  - al primer `/start`, si el Telegram de quien escribe está en otro idioma (su `language_code`, que Telegram manda
    con cada mensaje) que no es de España (ni `es`, ni `ca`, `eu` o `gl`), se le ofrece el inglés con un botón, una
    vez y sin imponerlo;
  - desde la web en inglés: el botón «Alert me on Telegram» abre `t.me/<bot>?start=en-<clave>` y el bot sigue lo
    elegido y contesta ya en inglés. Ninguna clave ni provincia empieza por un idioma (las claves son `s-`, `l-` o
    `p-`), así que los enlaces de siempre, sin idioma, siguen igual. Si con `en-` la clave pasara de los 64
    caracteres que admite Telegram, la web la manda sin él.
- **Dónde se guarda**: con lo demás del chat (`lang`, sólo si no es el español). De quien no sigue nada no se guarda
  nada, así que su idioma sólo queda en memoria hasta que se reinicia el servidor; al seguir algo, pasa a su chat.
  `/datos` lo enseña.
- **Cómo se traduce**: las frases en español del código son la clave y `server/domain/seguidos/en.js`, su traducción
  (inglés británico, con el glosario de la web). Todo lo que escribe el bot pasa por `t('…')` (o `frase('…')` si se
  traduce más tarde, como las descripciones de las órdenes). `test/domain/bot-idioma.test.js` recorre el código del
  bot y falla si una frase no está en el diccionario, si sobra una que ya no se dice, si no lleva las mismas
  `{variables}` o las mismas órdenes (`/seguir` → `/follow`) o si hay **una frase escrita sin pasar por `t()`**: una
  orden o un aviso nuevo no se puede subir sin traducir. Las órdenes tienen nombre en inglés (`/follow`, `/status`,
  `/unfollow`, `/summary`, `/stop`…) y las dos formas valen siempre.
- **Qué se queda tal cual**, como en la web: los nombres (estaciones, líneas, operadores, provincias, lugares), lo que
  publica cada fuente (avisos de Renfe, de AEMET, de protección civil, motivos de las cancelaciones…) y las
  atribuciones con su fórmula («Origen de los datos: Renfe Operadora», «© AEMET», «Powered by MITRAMS»): varias
  licencias piden no alterarlos.
- **Lo que escribe nuestro servidor** (títulos de cancelaciones, terremotos, avisos sin título) se traduce con las
  mismas plantillas que la web (`server/domain/en-servidor.js`, que la web carga tal cual). Los nombres de lo que se
  sigue se guardan en español («Autobús 27 · EMT Málaga») y se enseñan con nuestras palabras traducidas («Bus 27 · EMT
  Málaga»).
- **Fechas y horas**: día/mes y 24 h en hora peninsular («10/11, 15:00»); `/parte` entiende también «7pm». La web que
  citan los mensajes en inglés lleva `?lang=en`.
- **En las rondas**, los hechos se buscan una vez para todos (en español, que da sus ids) y otra sólo con lo que siguen
  los chats en inglés, si hay alguno.

## Código

- dominio: `server/domain/seguidos/` (el idioma, en `idioma.js` y `en.js`), `server/domain/en-servidor.js` y
  `server/domain/provincias.js`;
- caso de uso: `server/application/use-cases/follow-bot.js`;
- adaptadores: `server/adapters/inbound/telegram/` y `server/adapters/outbound/telegram/`, más el almacén y el
  turno en `server/adapters/outbound/persistence/`.
