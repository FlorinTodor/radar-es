# Radar ES

Mapa en tiempo real de trenes, metros y tranvías de España, cruzado con incidencias de
tráfico, terremotos, avisos meteorológicos y el estado de la red eléctrica. Todo a partir
de **datos públicos**, sin claves de API.

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

Requiere Node.js 22.9 o superior.

## Arquitectura hexagonal

```
                   ┌───────────────────── adapters/inbound ─────────────────────┐
  navegador ──────▶│ http/http-server.js  (REST + SSE + estáticos)              │
  reloj ──────────▶│ scheduler/polling-scheduler.js  (sondeo de fuentes)        │
                   └──────────────┬─────────────────────────────────────────────┘
                                  ▼
                   ┌──────────── application ─────────────┐
                   │ use-cases/ingest-source.js           │
                   │ use-cases/detect-alerts.js           │──▶ ports.js (contratos)
                   │ use-cases/query-situation.js         │
                   └──────────────┬───────────────────────┘
                                  ▼
                   ┌──────────────── domain ──────────────┐
                   │ model.js · geo.js · tracking.js      │  puro: sin red, sin disco,
                   │ kpis.js · alerts/{rules,lifecycle}   │  sin dependencias externas
                   └──────────────────────────────────────┘
                                  ▲ implementan los puertos
                   ┌──────────── adapters/outbound ─────────────────────────────┐
                   │ sources/*        Renfe, FGC, Ouigo, DGT, SCT, AEMET, FIRMS…│
                   │ stations/        catálogo de estaciones de Renfe           │
                   │ network/, gtfs/, nap/   trazados de líneas desde el NAP    │
                   │ persistence/     estado en memoria + histórico JSONL       │
                   │ events/          bus de eventos en proceso                 │
                   │ http/, logging/                                            │
                   └────────────────────────────────────────────────────────────┘
```

- **`server/domain/`**: modelo y reglas puras. Se prueba sin red (`test/domain`).
- **`server/application/`**: casos de uso y **puertos**, los contratos que necesitan del exterior.
- **`server/adapters/outbound/`**: implementaciones de esos puertos. Para cambiar la memoria
  por Redis o Postgres, o el JSONL por una base de datos, basta con escribir otro adaptador.
- **`server/adapters/inbound/`**: quien dispara los casos de uso (la API HTTP y el planificador).
- **`server/main.js`**: raíz de composición; el único sitio donde se eligen las implementaciones.

### Añadir una fuente

1. Crea `server/adapters/outbound/sources/mi-fuente.js` que devuelva un objeto con el puerto
   `DataSource`: `{ id, name, kind: 'vehicles'|'events'|'metrics', interval, fetch() }`.
   Si publica **GTFS-Realtime**, no hace falta código: reutiliza `createGtfsRtVehicleSource`.
2. Regístrala en `server/adapters/outbound/sources/index.js`.
3. Si necesita clave, declara `requires: ['MI_CLAVE']`. Se activará sola cuando la variable
   exista en `.env`.

### Añadir una regla de alerta

Escribe una función pura `(ctx) => Alert[]` en `server/domain/alerts/rules.js`, añádela a
`RULES` y pruébala en `test/domain/rules.test.js`. Los umbrales están en `thresholds.js`.

## Fuentes integradas (todas verificadas)

Todas son públicas. Solo las marcadas con 🔑 necesitan `NAP_API_KEY`, una clave gratuita del NAP.

| Fuente | Qué aporta | Refresco |
|---|---|---|
| Renfe Cercanías/Rodalies (`tiempo-real.renfe.com/renfe-visor/flota.json`) | posición, línea, retraso y estaciones | 20 s |
| Renfe AV/LD/MD (`tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`) | posición, producto, retraso y hora del GPS | 20 s |
| Renfe GTFS-RT alerts (`gtfsrt.renfe.com/alerts.json`) | avisos de servicio | 2 min |
| Estaciones Renfe (GeoJSON de ambos visores) | nombres y coordenadas de 1.512 estaciones | 24 h |
| FGC (`dadesobertes.fgc.cat`, `posicionament-dels-trens`) | posición y si va en hora | 30 s |
| Metro Bilbao (GTFS-RT, Open Data Euskadi) | posición | 30 s |
| Tranvía de Tenerife (endpoint no documentado de su web) | posición y próxima parada | 30 s |
| Renfe GTFS-RT (`gtfsrt.renfe.com`) | ~90 trenes de Cercanías más que el visor no muestra (muchos en andén) | 20 s |
| 🔑 Euskotren (GTFS del NAP + trip updates de Open Data Euskadi) | **posición estimada** con su **retraso real** | 30 s |
| 🔑 Ouigo (GTFS del NAP) | **posición estimada** por horario, marcada como tal | 30 s |
| 🔑 Metros y tranvías sin GPS (GTFS del NAP) | **posición estimada** por horario en Barcelona (Metro, TRAM), Madrid (Metro Ligero), Valencia, Alicante, Sevilla, Málaga, Granada, Zaragoza y Murcia | 30 s |
| Autobuses de Euskadi (~25 operadores), EMT Málaga, EMT Fuenlabrada (GTFS-RT) | posición; capa oculta por defecto y fuera de las alertas | 60 s |
| 🔑 GTFS de 18 redes en el NAP | trazados de Cercanías, metros, tranvías, FGC y Euskotren | 7 días |
| DGT DATEX II v3.7 (`nap.dgt.es`) | ~1.000 incidencias de tráfico | 5 min |
| Servei Català de Trànsit (GML) | incidencias de carreteras catalanas | 5 min |
| Tráfico Euskadi (API Trafikoa) | incidencias de carreteras vascas | 5 min |
| AEMET avisos (RSS + CAP) | avisos amarillo, naranja y rojo **con polígono** | 10 min |
| NASA FIRMS (VIIRS NOAA-20, CSV público) | focos de calor por satélite (España, Portugal, Canarias) | 30 min |
| IGN sismología (GeoRSS) | terremotos de los últimos 10 días | 3 min |
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
| `GET /api/lines` | trazados de las líneas (GeoJSON) |
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
