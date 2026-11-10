# Vehículos: tipos y qué se puede seguir de cada uno

El radar enseña trenes, metros, tranvías y autobuses de muchas fuentes, y cada una identifica sus vehículos
a su manera. Para que **Mis trenes, la puntualidad histórica, el día en cifras y el bot de Telegram** valgan
para todos, sin saber de qué fuente ni de qué tipo es cada uno, hay dos piezas en el dominio:

- `server/domain/modos.js`: el **registro de tipos de vehículo** (modos).
- `server/domain/seguir.js`: las **claves de lo que se puede seguir** de un vehículo (un servicio, una línea o
  una parada), estables entre días y entre reinicios.

Las funciones nuevas sólo usan estas dos piezas. Así, un tipo nuevo (barcos, aviones…) o una fuente nueva
funciona en todas ellas sin tocarlas.

## Registro de tipos (`domain/modos.js`)

Cada tipo tiene `id`, `label` (nombre en capas y filtros), `noun` y `nounPlural` («autobús», «autobuses»),
`family` (`ferrocarril`, `carretera`, `agua`, `aire` u `otros`) y, si hace falta, `offByDefault` (la capa
empieza apagada, como los autobuses). El orden del registro es el orden en que se enseñan.

- El servidor lo usa directamente (`MODES`, `modeInfo`, `isMode`, `modeNoun`).
- El cliente lo recibe en **`/api/modes`**, con caché de catálogo. Las funciones nuevas toman de ahí los
  nombres y los filtros.
- Lo que el cliente ya tenía (`MODE_LABEL` en `public/js/format.js`, y `MODE_ITEMS` y `MODES_OFF_BY_DEFAULT`
  en `public/js/panels.js`) y los modos que salen del GTFS (`gtfs-modes.js`) están obligados por
  `test/domain/modos.test.js` a coincidir con el registro.

## Qué se puede seguir (`domain/seguir.js`)

Cada vehículo trae `follow`: la lista de claves de lo que se puede seguir de él, primero el servicio y luego la
línea. Las cancelaciones y los trenes sin datos las traen en `trip.follow`, las mismas que sus vehículos: quien
sigue algo se entera de que no circula.

Las pone el **adaptador de cada fuente**, que es el único que sabe qué es estable en sus datos.

### Formato

Las claves sólo llevan `[A-Za-z0-9_-]` y tienen como mucho 64 caracteres. Así una clave es tal cual el
parámetro `start` de Telegram (`t.me/<bot>?start=<clave>`), sin tablas para volver a ella.

| Tipo | Forma | Ejemplo |
|---|---|---|
| Servicio con número propio | `s-<red>-<número>` | `s-renfe-8058` (Avant 08058) |
| Servicio de un horario | `s-<red>-<línea>-<origen>-<HHMM>` | `s-amb-V15-0k3x9ab-0732` |
| Línea | `l-<red>[-<ámbito>][-<línea>]` | `l-renfe-Madrid-C5`, `l-renfe-C_C3_A1diz-C1`, `l-emtmalaga-27` |
| Toda la red de un operador | `l-<red>` | `l-metrobilbao` |
| Parada o estación | `p-[<catálogo>-]<código>` | `p-71801`, `p-tmb-123` |
| Trayecto (sólo el bot) | `t-<origen>-<destino>-<HHMMHHMM>-<días>` | `t-70103-18000-07000900-1f` |

- `<red>` es el operador tal como lo enseña el radar, en minúsculas, sin tildes ni signos: «EMT Málaga» →
  `emtmalaga`. Si pasa de 20 caracteres, se abrevia con su huella. **Cambiar el nombre de un operador cambia
  sus claves**: lo que la gente siguiera dejaría de encontrarse. Si hay que hacerlo, que su adaptador siga
  dando la clave con el nombre de antes.
- Cada parte guarda letras y cifras; lo demás va como `_` y su código en hexadecimal: «L-1» → `L_2D1`,
  «Cádiz» → `C_C3_A1diz`. Una parte de más de 24 caracteres se cambia por `__` y una huella FNV-1a de 7
  caracteres. Sirve para comparar, pero no para leerla. Si con el ámbito legible la clave pasara de 64, el
  ámbito iría como huella.
- El ámbito es lo que hace falta para distinguir dos líneas del mismo operador con el mismo nombre. En Cercanías
  es el núcleo, por su nombre: Madrid, Asturias, Sevilla, Cádiz, Málaga, Valencia, Murcia/Alicante, Cartagena,
  Ferrol, León, Catalunya, Bilbao, San Sebastián, Santander y Zaragoza. Están en `RENFE_NUCLEOS` (renfe.js),
  sacados del prefijo de sus `route_id`. Un núcleo que no esté en la tabla sigue funcionando con su código y se
  avisa una vez en el registro para añadirlo.
- El número de un servicio va sin ceros a la izquierda: `08058` y `8058` son el mismo tren.
- El servicio de un horario lleva la **huella del `stop_id`** de su parada de origen y su hora de salida (pasada la
  medianoche del horario, `2510`). Si otro día sale a otra hora, es otro servicio, porque así lo dice el horario.
- La clave de una parada se puede deshacer: `stopCode(clave)` devuelve su código de catálogo.
- Un **trayecto** no lo da ningún vehículo: lo escribe quien lo sigue en el bot («Mi trayecto», ver
  [telegram.md](telegram.md)). Lleva el código de catálogo entero de sus dos estaciones (con `:` como `_3A`, para
  poder volver a encontrarlas), la franja en la que sale del origen (`07000900`: de 07:00 a 09:00, siempre de una
  hora a otra más tarde del mismo día) y los días, una máscara de 7 bits en hexadecimal (bit 0 el lunes… bit 6 el
  domingo: `1f` es de lunes a viernes, `60` sábados y domingos, `7f` todos). Con los códigos más largos del
  catálogo (`metrosevilla:L1-E10`) cabe en 64. `parseFollowKey` devuelve sus dos códigos (`origin`,
  `destination`), la franja (`from`, `to`, «HH:MM») y los días (`days`). Ninguna lista `follow` lleva trayectos.

Funciones: `numberedServiceKey`, `scheduledServiceKey`, `lineKey`, `stopKey`, `stopCode` y `trayectoKey` para construirlas;
`isFollowKey`, `followKind` y `parseFollowKey` para validarlas y leerlas; `describeFollow` para nombrarlas con
lo que se sepa del vehículo; y `answersTo`,
`mergeFollow` y `followOf` para trabajar con listas. Quien guarde una clave para más adelante (el bot, Mis
trenes) debe guardar también su nombre, porque las partes con huella no se pueden leer.

### Cómo se llaman

`describeFollow(clave, lo que se sepa)`:

- Un servicio con número: «<servicio> <número>», por ejemplo «Avant 08058», «Cercanías 23065» o «AVE 05912».
- Un servicio de un horario: «<tipo> <línea> · <operador>, el de las HH:MM, desde <origen>».
- Una línea: «<servicio o tipo> <línea> · <operador>» y, si la clave trae ámbito, « (<ámbito>)».
  - «Cercanías C5 · Renfe (Madrid)», «Rodalies R16 · Renfe (Catalunya)», «Autobús 71 · EMT Málaga»,
    «Tren E4 · Euskotren».
  - Si la línea es el propio producto, no se repite: «AVE · Renfe».
  - Nunca lleva dónde está ahora el vehículo (`area`): eso no es de la línea.
- Toda la red: «<operador>: toda la red».
- Un trayecto: «<origen> → <destino> (HH:MM-HH:MM, <días>)», con el nombre de sus estaciones: «Alcalá de Henares →
  Madrid-Atocha Cercanías (07:00-09:00, de lunes a viernes)» (`daysText` escribe los días).

### Qué da cada fuente hoy

- **Renfe** (Cercanías, Rodalies, AV/LD/MD, sus cancelaciones y los trenes sin datos):
  - el servicio es el número de tren, el mismo cada día y en los dos feeds;
  - la línea de Cercanías lleva el nombre de su núcleo (`l-renfe-Valencia-C2`, porque C2 hay en varios), y sus
    vehículos de las líneas R se llaman Rodalies, como sus cancelaciones;
  - en AV/LD/MD, la línea es el producto (`l-renfe-Avant`), que es lo que el radar enseña como su línea.
  
  Al juntar el mismo tren de los feeds de Rodalies y de AV/LD/MD, la incidencia lleva las claves de los dos: el
  número y las dos líneas.
- **Horarios GTFS con tiempo real** (AMB, Euskotren): el servicio es la línea, el origen y la hora; además, la
  línea. Sus cancelaciones llevan las mismas claves.
- **Horarios GTFS con número propio** (Ouigo): el número de tren.
- **Horarios GTFS sin tiempo real** (metros, tranvías, autobuses del NAP, ALSA): sólo la línea. De un servicio
  así no habría nada que contar, ni retraso ni cancelaciones. Además, sus claves hacían crecer `/api/live/buses`
  un 13 % con gzip, frente a un 5 % sólo con la línea. Cuando un operador publique su tiempo real
  (`tripUpdatesUrl`), sus viajes tendrán servicio sin tocar nada más.
- **Sólo GPS** (Metro Bilbao, autobuses de Euskadi, AUVASA, EMT Málaga, EMT Fuenlabrada, La Unión) y **FGC**:
  sólo la línea, porque su número es el del coche o la unidad, que cambia de un día a otro. Si la fuente no dice
  la línea, toda la red (`l-metrobilbao`). Los avisos de AUVASA y EMT Málaga que suprimen paradas llevan la
  línea.
- **Avisos de los operadores** (incidencias con `type: 'aviso'`): llevan en `follow` las claves de las líneas que
  nombran, para que le lleguen a quien sigue una de ellas. Las de Renfe y Rodalies salen de `renfeFollow`, como las
  de sus trenes: los de Renfe, por las rutas que citan (con el nombre de su núcleo, `l-renfe-Madrid-C5`); los de
  Rodalies (RSS de la Generalitat), con el núcleo de Catalunya (`l-renfe-Catalunya-R14`); los de AUVASA y EMT
  Málaga, por la línea que dicen («Línea 16»). Para AUVASA, ver la nota de abajo: aún no casan con sus vehículos.
- **Estaciones** (de Renfe y de las redes de metro y tranvía): su clave va en su ficha
  (`/api/stations/<código>`, campo `follow`). La lista `/api/stations` no la lleva, porque sale del código y la
  engordaría un 13 %. Los autobuses aún no tienen catálogo de paradas.

## Cómo está lo que se sigue (`domain/siguiendo.js`)

- **`/api/live/siguiendo?clave=<clave>`** da cómo está ahora lo de una clave, de cualquier tipo de vehículo:
  - un servicio: `circula`, `cancelado`, `parcial`, `sin-datos`, `cancelado-retirado` o `no-se-ve`;
  - una línea: `circulan` o `ninguno`, con cuántos vehículos hay, cuántos dan su retraso y cuántos van con 5 min o
    más;
  - siempre, sus incidencias (las que llevan la clave en `follow` o en `trip.follow`).
  
  Sale de un índice por clave que se rehace como mucho cada 5 s. Tiene memo y presupuesto propios y la caché del
  directo (Cloudflare la guarda unos segundos para todos). También da el estado de los autobuses aunque su capa esté
  apagada, sin descargarlos todos. Una clave que no es válida da 400.
- **El navegador usa los mismos módulos del dominio**: `seguir.js`, `modos.js` y `siguiendo.js` se sirven tal cual
  en `/server/domain/<fichero>` (`SHARED_DOMAIN_MODULES` en el adaptador HTTP), la misma ruta relativa que tienen
  desde `public/js` en el repositorio. Por eso el cliente los importa igual en el navegador y en los tests de Node.
  Sólo pueden importarse entre ellos (lo comprueba `test/adapters/http-siguiendo.test.js`). Así las claves,
  sus nombres y los tipos no están escritos dos veces.
- «Siguiendo» (`public/js/siguiendo.js`) guarda en el navegador la clave y el nombre de lo que se marca con la
  estrella, y pide su estado a esa ruta.

## Añadir un tipo de vehículo nuevo (barco, avión…)

1. Darlo de alta en `server/domain/modos.js`, con su nombre y su familia (`agua`, `aire`…), y en el tipo
   `Mode` de `server/domain/model.js`.
2. En el cliente, añadirlo a `MODE_LABEL` (`public/js/format.js`) y a `MODE_ITEMS` (`public/js/panels.js`).
   `test/domain/modos.test.js` falla hasta que coincidan. Si su capa debe empezar apagada, `offByDefault` en el
   registro y `MODES_OFF_BY_DEFAULT` en el cliente.
3. Su icono: un pictograma en `public/js/icons.js` (`DRAW`, `PICTOS` y `pictoFor`).
4. Escribir el adaptador de su fuente (ver `server/adapters/outbound/sources/index.js`). Los vehículos llevan
   ese `mode` y su `follow`: la línea siempre (o toda la red del operador), y el servicio si sus datos lo hacen
   estable entre días y hay algo que contar de él, como retrasos o cancelaciones.
5. Añadir la fuente a `COVERED` en `test/adapters/seguir-fuentes.test.js` y probar sus claves. Ese test falla con
   cualquier fuente de vehículos nueva que no esté.

Con eso, Mis trenes, la puntualidad, el día en cifras y el bot funcionan con el tipo nuevo sin cambios.

## Pendiente

- Algunas reglas aún miran `mode === 'bus'` en vez de la familia del registro. Hoy da igual, porque el único
  tipo que no va por vía es el autobús. Antes de dar de alta un barco o un avión, revisar:
  - en el dominio, `estimated-position.js` (posición entre paradas sin trazado) y `cancelaciones.js` (gravedad y
    palabras);
  - en los adaptadores y los casos de uso, `gtfs-horario.js` (vías del IGN), `gtfs-schedule.js`,
    `query-situation.js` y `keep-tracks.js`;
  - en el cliente, `map.js` y `app.js`, donde los autobuses van en `/api/live/buses`, aparte.

  En el servidor conviene que miren `modeInfo(mode).family`. Que los barcos o aviones vayan en su propia ruta,
  como los autobuses, depende de cuántos haya.
- El cliente sigue teniendo su copia de los nombres y del orden. Un test la mantiene alineada, pero lo ideal es
  que la saque del registro: ahora puede importar `/server/domain/modos.js` directamente, como ya hace «Siguiendo».
- AUVASA: la línea de sus vehículos sale de su viaje (`L16A1`) y la de sus avisos, del texto («Línea 16»). No
  casan hasta normalizarlas.
