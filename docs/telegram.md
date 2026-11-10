# Bot de Telegram «Sigue tu tren»

Quien escribe al bot puede seguir cualquier vehículo que publique el radar (un tren, un autobús, un metro, un
tranvía y los tipos que se añadan), su línea, una estación o una provincia. El bot le avisa:

- si lo que sigue se cancela o se le suprimen paradas;
- si va con 15 minutos o más de retraso, y otra vez cada 15 minutos más;
- si su operador deja de publicar sus datos (trenes «sin datos»);
- de los avisos del operador sobre su línea;
- en una provincia, de los avisos naranja y rojo de AEMET, los terremotos que pueden sentirse y los avisos
  oficiales (planes de emergencia y cortes de luz).

Con `/parte 07:30` manda cada día un resumen de lo que sigue. Lo que se puede seguir son las claves de
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
  seguirla.
- **Atiende un solo servidor a la vez.** Durante un relevo hay dos contenedores, y un turno en
  `data/bot/turno.json` decide cuál atiende el bot. El que se apaga lo suelta y el nuevo lo coge.
- **Lo que guarda**, en `data/bot/seguidos.v1.json`:
  - el número de cada chat, lo que sigue (con su nombre), desde cuándo y la hora de su parte;
  - y, para no repetir avisos tras un reinicio, qué se ha avisado ya.

  Nada de nombres, usuarios ni teléfonos. Un chat que deja de seguirlo todo, escribe `/baja` o bloquea el bot
  se borra. La política de privacidad de `/legal` lo explica.
- **Topes**: 20.000 chats y 20 cosas por chat, de ellas 5 provincias como mucho. Una cola de 5.000 mensajes:
  si se llena, se tiran los más viejos y se apunta en el registro.
- **Las provincias son círculos aproximados**, uno por isla en Baleares y Canarias
  (`server/domain/provincias.js`). Cerca de un límite puede llegar algún aviso de la vecina, y así se avisa al
  seguir una.

Código:

- dominio: `server/domain/seguidos/` y `server/domain/provincias.js`;
- caso de uso: `server/application/use-cases/follow-bot.js`;
- adaptadores: `server/adapters/inbound/telegram/` y `server/adapters/outbound/telegram/`, más el almacén y el
  turno en `server/adapters/outbound/persistence/`.
