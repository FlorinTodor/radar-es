<p align="center"><img src="docs/img/logo-radar-espana.png" alt="Radar España" width="560"></p>

# Radar España

**[radarespaña.es](https://radarespaña.es)** · Mapa en tiempo real de trenes, metros y tranvías de
España, cruzado con incidencias de tráfico, terremotos, avisos meteorológicos y el estado de la red
eléctrica. Todo a partir de **datos públicos**, sin claves de API.

Un motor de reglas vigila situaciones que merecen atención humana: trenes detenidos en
plena vía, varios trenes parados en la misma zona, saltos bruscos de retraso, terremotos
cerca de trenes en circulación, avisos naranja o rojo, caídas de la demanda eléctrica y
fuentes de datos caídas.

> **Límites.** Los datos públicos llegan con decenas de segundos o minutos de retraso y no
> incluyen señalización, estado de la vía ni comunicaciones con el maquinista. Esta
> herramienta sirve para vigilar y dar contexto; **no** para tomar decisiones de seguridad
> operativa, que corresponden a Adif y a los operadores.

## Arranque

```bash
npm install
cp .env.example .env   # opcional
npm start              # http://127.0.0.1:8080
npm run dev            # se reinicia al cambiar el código
npm test               # tests del dominio (sin red)
```

Requiere Node.js 22.9 o superior. Para los trazados de líneas y las posiciones estimadas por
horario hace falta `NAP_API_KEY` en `.env` (clave gratuita del Punto de Acceso Nacional).
Para contar visitas en producción se pone `GOATCOUNTER_URL` (GoatCounter, sin cookies); sin ella
no se carga ningún contador y la página de privacidad lo indica.

## Ramas

| Rama | Para qué |
|---|---|
| `produccion` | Lo que ejecuta el VPS. Solo recibe fusiones desde `dev`. |
| `dev` | Integración: aquí se fusionan las mejoras, y el VPS las prueba juntas en un entorno de pruebas. |
| `feature/<nombre>` | Una rama por mejora, creada desde `dev`. |

```bash
git switch dev && git pull
git switch -c feature/mi-mejora     # trabajar y hacer commits
git switch dev && git merge --no-ff feature/mi-mejora && git push
```

Cada push a `dev` arranca el pipeline de GitHub Actions: tests, pruebas en el VPS y, cuando están
en verde, una aprobación manual que hace el merge de `dev` en `produccion`.

En producción corre con Docker en un VPS detrás de un túnel de Cloudflare. Cada cambio en `dev`
pasa antes por un entorno de pruebas en el mismo VPS, y producción sólo despliega lo que ya ha
superado allí la comprobación, con la misma imagen: ver [`docs/despliegue.md`](docs/despliegue.md).

## Arquitectura hexagonal

```
                   ┌───────────────────── adapters/inbound ─────────────────────┐
  navegador ──────▶│ http/http-server.js  (REST + SSE + teselas + estáticos)    │
  reloj ──────────▶│ scheduler/polling-scheduler.js (sondeo, alertas, catálogos)│
                   └──────────────┬─────────────────────────────────────────────┘
                                  ▼ sólo casos de uso
                   ┌──────────── application ─────────────┐
                   │ use-cases/ingest-source.js           │
                   │ use-cases/detect-alerts.js           │
                   │ use-cases/query-situation.js         │──▶ ports.js (contratos)
                   │ use-cases/watch-situation.js  (SSE)  │
                   │ use-cases/serve-tiles.js             │
                   │ use-cases/refresh-catalogs.js        │
                   └──────────────┬───────────────────────┘
                                  ▼
                   ┌──────────────── domain ──────────────┐
                   │ model.js · geo.js · tracking.js      │  puro: sin red, sin disco,
                   │ kpis.js · tiles.js                   │  sin dependencias externas
                   │ alerts/{rules,lifecycle}             │
                   └──────────────────────────────────────┘
                                  ▲ implementan los puertos
                   ┌──────────── adapters/outbound ─────────────────────────────┐
                   │ sources/*        Renfe, FGC, Ouigo, DGT, SCT, AEMET, FIRMS…│
                   │ stations/        catálogo de estaciones de Renfe           │
                   │ network/, gtfs/, nap/   trazados de líneas desde el NAP    │
                   │ persistence/     estado en memoria + histórico JSONL       │
                   │ events/          bus de eventos en proceso                 │
                   │ tiles/           teselas de IGN y EFFIS con copia en disco │
                   │ workers/         hilos para leer GTFS y XML (CPU)          │
                   │ http/, logging/                                            │
                   └────────────────────────────────────────────────────────────┘
```

- **`server/domain/`**: modelo y reglas puras. Se prueba sin red (`test/domain`).
- **`server/application/`**: casos de uso y **puertos**, los contratos que necesitan del exterior.
- **`server/adapters/outbound/`**: implementaciones de esos puertos. Para cambiar la memoria
  por Redis o Postgres, o el JSONL por una base de datos, basta con escribir otro adaptador.
- **`server/adapters/outbound/workers/`**: hilos (`worker_threads`) para el trabajo de CPU de los
  adaptadores: leer los horarios GTFS, construir los trazados y analizar el XML de la DGT. Sólo
  calculan; las descargas y el estado siguen en el hilo principal. **Desactivados por defecto**:
  se activan con `WORKER_THREADS=2` en `.env` (arranque ~20 % más rápido, pero el pico de memoria
  sube de ~350 a ~530 MB). Si un hilo falla, el trabajo se repite en el principal.
- **`server/adapters/inbound/`**: quien dispara los casos de uso (la API HTTP y el planificador).
  Sólo hablan con casos de uso, nunca con los puertos de salida.
- **`server/main.js`**: raíz de composición; el único sitio donde se eligen las implementaciones.

### Añadir una fuente

1. Crea `server/adapters/outbound/sources/mi-fuente.js` que devuelva un objeto con el puerto
   `DataSource`: `{ id, name, kind: 'vehicles'|'events'|'metrics', interval, fetch() }`.
   Si publica **GTFS-Realtime**, no hace falta código: reutiliza `createGtfsRtVehicleSource`.
2. Regístrala en `server/adapters/outbound/sources/index.js`.
3. Si necesita clave, declara `requires: ['MI_CLAVE']`. Se activará sola cuando la variable
   exista en `.env`.
4. Si la URL del dato no es una página para personas (un JSON, un .pb), añade `page` con la ficha
   pública del conjunto de datos: es lo que enlaza el panel de Fuentes.
5. Añade su fila de licencia y atribución en `public/legal.html`.

### Añadir una regla de alerta

Escribe una función pura `(ctx) => Alert[]` en `server/domain/alerts/rules.js`, añádela a
`RULES` y pruébala en `test/domain/rules.test.js`. Los umbrales están en `thresholds.js`.

## Fuentes integradas (todas verificadas)

Solo se usan fuentes con licencia de reutilización. Los endpoints internos de visores o apps
(el visor web de Renfe, la API del tranvía de Tenerife, la API de la app de Rodalies…) se descartaron
tras revisar sus avisos legales. Del tranvía de Tenerife solo se dibuja el trazado, que Metrotenerife
publica con licencia CC BY en el portal del Cabildo. La licencia y la atribución de cada fuente están
en `/legal`.

Todas son públicas. Solo las marcadas con 🔑 necesitan `NAP_API_KEY`, una clave gratuita del NAP.

| Fuente | Qué aporta | Refresco |
|---|---|---|
| Renfe Cercanías/Rodalies (GTFS-RT `gtfsrt.renfe.com/vehicle_positions.json` + `trip_updates.json`) | posición, línea, retraso y estación; origen, destino, próxima parada y recorrido desde las paradas de cada viaje de su GTFS | 20 s |
| Renfe AV/LD/MD (GTFS-RT `vehicle_positions_LD.json` + `trip_updates_LD.json`) | posición y retraso; producto (AVE, Alvia…), origen y destino desde su GTFS | 20 s |
| Renfe GTFS-RT alerts + trip updates (`alerts.json`, `trip_updates.json`) | avisos de servicio y trenes de Cercanías/Rodalies cancelados | 2 min |
| Estaciones Renfe (lista oficial `estaciones.csv` + paradas de sus GTFS) | nombres y coordenadas de ~1.530 estaciones | 24 h |
| FGC (`dadesobertes.fgc.cat`, `posicionament-dels-trens`) | posición y si va en hora | 30 s |
| Rodalies de Catalunya (RSS «Estat del servei» de la Generalitat) | avisos por línea (p. ej. transporte por carretera) | 3 min |
| Metro Bilbao (GTFS-RT y GTFS, Open Data Euskadi) | posición; nombres de estación, origen, destino y recorrido desde su GTFS | 30 s |
| 🔑 Euskotren (GTFS del NAP + trip updates de Open Data Euskadi) | **posición estimada** con su **retraso real** | 30 s |
| 🔑 Ouigo (GTFS del NAP) | **posición estimada** por horario, marcada como tal | 30 s |
| 🔑 Metros y tranvías sin GPS (GTFS del NAP) | **posición estimada** por horario en Barcelona (Metro, TRAM), Madrid (Metro Ligero), Valencia, Alicante, Sevilla, Málaga, Granada, Zaragoza y Murcia | 30 s |
| Autobuses de Euskadi (~25 operadores), EMT Málaga, EMT Fuenlabrada (GTFS-RT) | posición; capa oculta por defecto y fuera de las alertas | 60 s |
| 🔑 ALSA (GTFS del NAP) | **posición estimada** por horario de sus autobuses (nadie publica su tiempo real); capa de autobuses | 60 s |
| 🔑 AMB (GTFS del NAP + trip updates de `ambmobilitat.cat`) | autobús metropolitano de Barcelona: **posición estimada** con su **retraso real** | 60 s |
| Autobuses La Unión (GTFS-RT, NAP) y AUVASA Valladolid (GTFS-RT, CC BY 3.0 ES) | posición | 60 s |
| 🔑 ~70 horarios de autobús del NAP (`autobuses-nap.js`) | **posición estimada** de Avanza, Sagalés, Moventis, Grupo Ruiz, AISA, Vectalia, urbanos de ciudades, interurbanos autonómicos e insulares y otras empresas | 60 s |
| EMT Madrid (GTFS-RT del NAP) | avisos de servicio | 5 min |
| 🔑 GTFS de 16 redes en el NAP + líneas del tranvía de Tenerife (Cabildo de Tenerife) | trazados de Cercanías, metros, tranvías, FGC y Euskotren | 24 h |
| DGT DATEX II v3.7 (`nap.dgt.es`) | ~1.000 incidencias de tráfico | 5 min |
| Servei Català de Trànsit (GML) | incidencias de carreteras catalanas | 5 min |
| Tráfico Euskadi (API Trafikoa) | incidencias de carreteras vascas | 5 min |
| AEMET avisos (RSS + CAP) | avisos amarillo, naranja y rojo **con polígono** | 10 min |
| NASA FIRMS (VIIRS NOAA-20, CSV público) | focos de calor por satélite (España, Portugal, Canarias) | 30 min |
| IGN sismología (GeoRSS) | terremotos de los últimos 10 días | 3 min |
| GDACS (ONU / Comisión Europea) | alertas de catástrofes en la zona (verde, naranja, roja) | 15 min |
| Copernicus EFFIS (WMS, en el navegador) | capa de áreas quemadas en los últimos 30 días | — |
| Red Eléctrica REData | demanda real frente a prevista | 5 min |

El mapa base es de OpenFreeMap (datos de OpenStreetMap), sin clave.

Las posiciones estimadas (`estimated: true`) se dibujan como un anillo hueco y **no cuentan para
las alertas ni para los KPIs**.

## API

| Ruta | Devuelve |
|---|---|
| `GET /api/stream` | SSE: `snapshot` al conectar, y luego `source`, `alerts` y `health` |
| `GET /api/snapshot` | todo el estado actual |
| `GET /api/vehicles?mode=av&source=renfe-ld&minDelay=15` | vehículos filtrados |
| `GET /api/events?category=carretera` | incidencias (`ferroviario`, `carretera`, `meteo`, `incendio`, `sismo`) |
| `GET /api/alerts` | alertas activas y resueltas |
| `GET /api/tracks/:id` | recorrido de un vehículo en los últimos 45 min |
| `GET /api/ahead/:id` | lo que le queda a un vehículo con posición estimada hasta su destino |
| `GET /api/stations/:código` | ficha de una estación (trenes, avisos, líneas, conexiones, datos y foto) |
| `GET /api/lines` | trazados de las líneas (GeoJSON) |
| `GET /api/trails?min=15` | estela de cada tren en los últimos minutos (GeoJSON, máx. 45) |
| `GET /api/health`, `/api/kpis`, `/api/metrics`, `/api/stations` | salud de fuentes, KPIs, métricas y estaciones |

Las alertas y los KPIs por minuto se guardan en `data/history/*.jsonl` para analizarlos
después (con jq, DuckDB o pandas).

## Pendiente y conocido

- **Adif (estado de la red, incidencias, circulaciones)**: su web responde 403 a cualquier
  cliente automatizado y no publica nada en el NAP. No se esquiva el bloqueo; se pide acceso
  formalmente.
- **Iryo**: no publica ningún dato en el NAP. **Ouigo**: solo publica el horario.
  - Los borradores de las solicitudes formales están en [`docs/solicitudes/`](docs/solicitudes/).
  - La web muestra al entrar un aviso sobre estos huecos (`#notice` en `public/index.html`). Si
    cambias el texto, sube `NOTICE_VERSION` en `public/js/app.js` para que vuelva a salir a todos.
- **Con clave gratuita, sin integrar aún**: TMB (Metro de Barcelona) y EMT Madrid.
- **Solo tiempos de llegada, sin posiciones**: Metro de Madrid, Metro Ligero, Metrovalencia,
  Granada y Zaragoza. Se pueden estimar posiciones a partir de su GTFS, igual que con Ouigo.
- El catálogo de fuentes de Cowork está en `Radar ES · Catálogo de fuentes públicas — Resumen.md`.
- SEO (páginas, sitemap, datos estructurados y lo que hay que hacer en Search Console): [`docs/seo.md`](docs/seo.md).

## Mejoras realizadas

Lo que ya está en marcha en [radarespaña.es](https://radarespaña.es), por temas.

**Datos en el mapa**
- Trenes en tiempo real: Cercanías y Rodalies, Alta Velocidad, Larga y Media Distancia, FGC,
  Euskotren y Metro Bilbao, con su retraso.
- Posiciones estimadas a partir del horario donde no hay GPS (Ouigo, ALSA y una docena de redes de
  metro y tranvía), con el retraso real cuando el operador lo publica. Se dibujan con la placa hueca.
- Autobuses de varias ciudades y operadores.
- Rodalies: trenes cancelados y avisos de servicio.
- Contexto y emergencias: incidencias de tráfico y obras en carretera (capas separadas), avisos
  meteorológicos, focos de calor por satélite, áreas quemadas con su ficha, terremotos, alertas
  de catástrofes y demanda eléctrica.
- Red ferroviaria, líneas de metro, tranvía y Cercanías, y estaciones.
- Nombres del mapa base en español.
- Se descartan los retrasos imposibles que a veces llegan en los datos.
- En los trenes de Renfe se descartan también las posiciones que su fuente repite o que saltan de
  forma imposible: ya no van y vienen en el mapa. Las fuentes cuya licencia pide no alterar los
  datos se muestran tal cual.
- Los autobuses que Renfe pone en algunas líneas de Cercanías se muestran como autobuses y no
  cuentan en los retrasos ni en las alertas de los trenes.
- Colores de línea legibles sobre el mapa oscuro, aunque el operador publique uno muy oscuro.

**Trenes**
- Pictograma por tipo de vehículo y color según el retraso.
- Ficha de cada tren, con la vía de la estación en la que para o a la que llega.
- Recorrido de los últimos 45 minutos del tren seleccionado y, como capa opcional, la estela de
  todos los trenes.
- En Cercanías, metro y tranvía, el recorrido va pegado a la vía de su línea, con sus curvas.
- Lo que le queda a cada tren hasta su destino, dibujado por su vía: en Cercanías y Metro Bilbao
  con el trazado de su viaje, y en metros y tranvías estimados con su horario.
- Flecha de hacia dónde va cada vehículo al acercar el mapa, por su vía cuando se conoce su
  recorrido.
- En Cercanías, el origen, el destino y la próxima parada salen de las paradas de cada viaje: ni el
  nombre de la línea ni el trazado que publica Renfe dicen siempre en qué sentido va.
- Metro Bilbao con nombres de estación, origen y destino.
- Los trenes de Alta Velocidad y Larga Distancia mantienen su origen y destino aunque Renfe
  renueve su horario ese día.
- Cuando el operador pasa el número de un tren a otro convoy, lo anterior cuenta como otro viaje:
  ni se une con una recta en el mapa ni da alertas de retraso falsas. Los túneles no cuentan como
  salto.
- Lista y buscador con todos los trenes.

**Estaciones**
- Pestaña «Estaciones» con buscador y una ficha para cada estación: los trenes parados en ella y los
  que van hacia ella (con vía, hora y retraso), los avisos de Renfe de la estación, sus líneas y las
  conexiones a pie con metro y tranvía.
- Además de las de Renfe, unas 870 estaciones de metro, tranvía, FGC, Euskotren y Metro Bilbao (15
  redes), sacadas del horario de cada operador en el Punto de Acceso Nacional: sus líneas con sus
  colores, accesibilidad, los trenes que llegan (en directo o estimados por horario), las conexiones
  con Cercanías y la atribución y fecha de los datos de su operador. La pestaña filtra por red y en
  el mapa salen al acercar a la ciudad, para no tapar las de Renfe.
- Datos de cada estación: dirección, accesibilidad en silla de ruedas (según Renfe y, si Renfe no
  dice nada, según Wikidata), año de apertura, número de vías y ancho de vía.
- Enlaces a Wikipedia, a la ficha técnica en PDF de Renfe (en las estaciones que la tienen), a
  OpenStreetMap y «Cómo llegar» con Google Maps.
- Foto de unas 1.200 estaciones de Renfe y unas 670 de las otras redes, de Wikimedia Commons, con
  su autor y su licencia. Se buscan en Wikidata, en la categoría de la estación, en su artículo de
  Wikipedia y entre las fotos hechas a su lado, y se revisan todas: sólo licencias que se pueden
  cumplir, sin personas reconocibles en primer plano, sin repetir una foto en dos estaciones y con
  retirada a petición del autor o de quien sale en ellas.
- Sin estaciones repetidas en el mapa: la misma estación con otro código o la parada de los trenes
  turísticos pegada a la normal ya no salen dos veces.
- Las estaciones se pueden pulsar desde más lejos y su nombre aparece antes al acercar el mapa.

**Alertas**
- Motor de reglas que avisa de:
  - trenes detenidos en plena vía y varios trenes parados en la misma zona;
  - saltos bruscos de retraso y retrasos muy grandes (ir adelantado cuenta como ir en hora: un tren
    que espera en su origen antes de su hora no da un aviso falso al salir);
  - terremotos y posibles incendios cerca de trenes;
  - avisos meteorológicos naranja o rojo;
  - caídas de la demanda eléctrica y fuentes de datos caídas.
- Al pulsar una alerta, el mapa muestra sólo lo suyo; se pueden combinar varias.
- Las capas que enciende una alerta se marcan como temporales y se pueden apagar sin perder la
  selección.

**Interfaz**
- Vista para el móvil, con el mapa a pantalla completa y un panel que sube desde abajo.
- Panel de capas pensado para el móvil: pastillas fáciles de pulsar, agrupadas por temas, con
  «Todas · Ninguna», la leyenda plegada y las preferencias guardadas en el navegador.
- Aviso al entrar sobre los datos públicos que todavía faltan.
- Páginas que explican cada parte del mapa y versión en inglés.
- Se puede instalar en el móvil como una app, desde Chrome o Safari («Añadir a pantalla de inicio»).
- Preparada para los buscadores: título y descripción a medida en cada página (sin que Google las
  corte), sitemap con la fecha de cada cambio y datos estructurados del sitio y de su autor.

**Rendimiento y fiabilidad**
- Directo servido desde caché, preparado para picos de muchas visitas a la vez.
- Respuestas de la API calculadas una sola vez y compartidas entre todas las visitas.
- Arranque sin bloquear el servidor mientras carga los horarios de más de cien redes, y menos
  memoria al leerlos. Los horarios más grandes se leen por partes, sin cargarlos enteros.
- Al arrancar, el mapa no se queda sin líneas aunque las pida antes de que estén listas.
- Tras una actualización, los Cercanías aparecen en segundos: lo que se calcula de su horario se
  guarda en disco, y la renovación diaria de los horarios de Renfe ya no detiene los trenes.
- Los horarios de metros, tranvías y autobuses también se guardan ya leídos: tras una
  actualización o un reinicio el mapa vuelve completo en segundos, no en minutos.
- Cálculos pesados en hilos aparte y reintentos rápidos de las fuentes que fallan.
- Protección frente a sobrecarga: peticiones costosas acotadas, colas con tope y fallos aislados,
  para que ni un pico de tráfico ni una fuente que responda mal tumben el servidor.
- El servidor arranca en segundos aunque haya que rehacer el catálogo de estaciones (fotos,
  fichas): arranca con la copia guardada y lo rehace después.
- Un reinicio a mitad de una descarga nunca deja un fichero cortado que se siga usando: todo se
  guarda de golpe.
- Si una parte de los datos falla al cargar (el horario de un operador, una red de líneas, las fotos
  de las estaciones), se reintenta en minutos y sólo esa parte, en vez de esperar al día siguiente.
- Una fuente nunca deja de leerse por un fallo inesperado.

**Despliegue y seguridad**
- La aplicación funciona aislada, en un contenedor con recursos limitados y cabeceras de
  seguridad.
- Cada cambio pasa los tests antes de publicarse y, si no arranca bien, la web vuelve sola a la
  versión anterior.
- Entorno de pruebas privado: cada cambio se prueba con datos reales antes de llegar a producción.
- Pipeline en GitHub Actions (tests → pruebas → aprobación manual → producción), y producción sólo
  publica la misma versión que se ha probado.
- Despliegues sin cortes: la versión nueva arranca al lado de la que funciona y sólo recibe visitas
  cuando ya ha cargado los datos. Si algún día el servidor no respondiera, se ve un aviso de que se
  está actualizando en vez de un error.
- Las subidas se detectan en unos segundos y el pipeline avanza en cuanto cada paso termina.
- Pruebas automáticas que no dependen de la velocidad de la máquina: dan lo mismo en el servidor,
  más lento y ocupado, que en un ordenador rápido.
- Limpieza automática del servidor, también de las teselas del mapa que ya nadie mira.
- Estadísticas de visitas sin cookies.

**Licencias**
- Sólo datos públicos cuya licencia permite reutilizarlos, con las atribuciones que exige cada
  fuente, aviso legal y página de privacidad.
- Revisión de todas las fuentes, horarios, fotos y librerías: licencia vigente de cada conjunto,
  fecha de actualización de cada horario, enlace a la licencia de cada librería y, en privacidad,
  qué webs externas contacta el navegador y cuándo.

### Preparadas, pendientes de subir

Ninguna por ahora.

## Posibles mejoras

- Recorrido pegado a la vía también en AVE, Larga y Media Distancia, con los
  [tramos en servicio de Adif](https://www.arcgis.com/home/item.html?id=4ec7c0fb3cab42b0b488d65e65eeb7aa)
  (red vectorial con licencia abierta, que cita a Adif). Cada tramo une dos estaciones con los
  mismos códigos que usa Renfe.
- Botón en el mapa para cambiar entre español e inglés.
- Más fuentes: TMB y EMT Madrid (con clave gratuita) y posiciones estimadas para las redes que
  sólo publican tiempos de llegada (ver *Pendiente y conocido*).
- Estadísticas de puntualidad por línea y franja horaria.
- Pasos a nivel en el mapa.
- Estado oficial de la red de Adif, si llega a publicarse con licencia de reutilización.
- Accesibilidad de las estaciones con más detalle:
  - en Madrid, qué accesos y andenes son accesibles, con los datos abiertos del
    [Consorcio de Transportes](https://www.crtm.es/licencia-de-uso/), cuando se revise su calidad;
  - en toda España, pedir a Adif que publique como datos abiertos las estaciones accesibles y las
    que tienen asistencia [Adif Acerca](https://www.spain.info/es/descubrir-espana/accesibilidad-trenes/).
  - Fuentes revisadas: [`docs/accesibilidad-estaciones.md`](docs/accesibilidad-estaciones.md).
- Estaciones de Metro de Madrid y del tranvía de Tenerife cuando vuelva a haber un horario vigente
  en el Punto de Acceso Nacional (el de Metro de Madrid caducó en mayo de 2026).
- Fotos de [Flickr](https://www.flickr.com/creativecommons/) con licencia Creative Commons (con autor y
  enlace) para las estaciones que siguen sin foto en Wikimedia Commons; hace falta una clave gratuita.
- Servir las fotos de las estaciones desde nuestro servidor, con caché, en lugar de enlazarlas en
  Wikimedia Commons: Commons lo permite pero no lo recomienda, y así Wikimedia no recibiría la IP de
  quien abre la ficha.
- Guía para quien quiera proponer cambios.

## Licencia

Todos los derechos reservados (ver [LICENSE](LICENSE)). El código se publica sólo para que se pueda
consultar: no se puede copiar, modificar, redistribuir, usar en otros proyectos ni explotar
comercialmente sin permiso por escrito del autor.

Los datos que muestra no son de este proyecto: cada fuente tiene su propia licencia y su
atribución obligatoria (ver `/legal`).
