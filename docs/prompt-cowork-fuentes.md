# Prompt para Cowork: catálogo de datos públicos en tiempo real de España

Copia todo lo que hay debajo de la línea en Cowork.

---

## Contexto

Estoy desarrollando **Radar ES**, un mapa en tiempo real de España que muestra trenes, metros,
tranvías y otros transportes, cruzados con incidencias y emergencias. Su objetivo es detectar
situaciones anómalas (trenes detenidos en plena vía, cortes, terremotos, temporales, apagones…)
y ayudar a evitar nuevas catástrofes. **Solo uso datos públicos.** El backend tiene arquitectura
hexagonal: cada fuente es un adaptador que devuelve uno de estos tres tipos de dato:

- **vehicles**: vehículos con posición (lat/lon), línea, retraso y estaciones.
- **events**: incidencias o sucesos georreferenciados (avisos, accidentes, terremotos, alertas).
- **metrics**: series numéricas (demanda eléctrica, caudales, calidad del aire…).

Necesito un **catálogo exhaustivo y verificado** de fuentes de datos públicas, a ser posible en
tiempo real, que pueda conectar al proyecto.

## Fuentes ya integradas y verificadas (no hace falta volver a investigarlas)

| Fuente | URL | Formato | Clave |
|---|---|---|---|
| Renfe Cercanías/Rodalies, posiciones | https://tiempo-real.renfe.com/renfe-visor/flota.json | JSON propio | no |
| Renfe AV/LD/MD, posiciones | https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json | JSON propio | no |
| Renfe GTFS-RT (JSON) | https://gtfsrt.renfe.com/{vehicle_positions,trip_updates,alerts,vehicle_positions_LD,trip_updates_LD}.json | GTFS-RT JSON | no |
| Renfe, estaciones | https://tiempo-real.renfe.com/data/estaciones.geojson y https://tiempo-real.largorecorrido.renfe.com/data/estaciones.geojson | GeoJSON | no |
| Renfe, recorridos LD | https://tiempo-real.largorecorrido.renfe.com/renfe-visor/trenesConEstacionesLD.json | JSON | no |
| Renfe GTFS estático Cercanías (con shapes) | https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip | GTFS | no |
| Renfe GTFS estático AV/LD/MD | https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip | GTFS | no |
| FGC, posiciones | https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records | JSON (Opendatasoft) | no |
| Metro Bilbao, posiciones | https://opendata.euskadi.eus/transport/moveuskadi/metro_bilbao/gtfsrt_metro_bilbao_vehicle_positions.pb | GTFS-RT pb | no |
| Tranvía de Tenerife, posiciones | https://tranviaonline.metrotenerife.com/api/infoStops/vehicleLocation | JSON (no documentado) | no |
| DGT, incidencias de tráfico | https://nap.dgt.es/datex2/v3/dgt/SituationPublication/datex2_v37.xml | DATEX II v3.7 | no |
| IGN, terremotos | https://www.ign.es/ign/RssTools/sismologia.xml | GeoRSS | no |
| AEMET, avisos (vía MeteoAlarm) | https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain | Atom + CAP | no |
| Red Eléctrica, demanda | https://apidatos.ree.es/es/datos/demanda/demanda-tiempo-real | JSON (REData) | no |
| EMSC, terremotos (respaldo) | https://www.seismicportal.eu/fdsnws/event/1/query | FDSN JSON | no |
| OpenSky, aviones | https://opensky-network.org/api/states/all | JSON | no (con límites) |

## Fuentes encontradas y probadas, pendientes de integrar

- **Open Data Euskadi (MoveUskadi)**: unos 20 operadores en GTFS-RT, índice en
  https://opendata.euskadi.eus/transport/moveuskadi/data-index-gtfs-rt.json. Incluye Bizkaibus,
  Tuvisa, dBus, Alavabus y Euskotren (este último solo con trip updates).
- **EMT Málaga (GTFS-RT)**: https://gtfs.emtmalaga.es/GTFSRTapi/api/{vehicleposition,tripupdate,alert}
- **EMT Fuenlabrada (GTFS-RT)**: https://api.control.optibus.co/opendata/v1/gtfs-rt/vehicle-positions?uid=c-5cfcd2d1
- **AMB Barcelona**, trip updates: https://www.ambmobilitat.cat/transit/trips-updates/trips.bin
- **EMT Madrid**, alertas: https://openapi.emtmadrid.es/v1/bus/servicealerts/proto
- **Rodalies de Catalunya** (retrasos y cancelaciones, sin coordenadas):
  https://serveisgrs.rodalies.gencat.cat/api/ (OpenAPI en /api/v3/api-docs)
- **Solo tiempos de llegada**:
  - Metro de Madrid (serviciosapp.metromadrid.es/servicios/rest/teleindicadores/)
  - CRTM (www.crtm.es/widgets/api/GetStopsTimes.php)
  - FGV Metrovalencia y TRAM d'Alacant (www.fgv.es/fgv/app/es/api/v1/)
  - Metro de Granada
  - Tranvía de Zaragoza (www.zaragoza.es/sede/servicio/.../parada-tranvia/)
- **Catálogo global de feeds**: MobilityDatabase, https://share.mobilitydata.org/catalogs-csv

## Bloqueadas o con clave

- **Adif, estado de la red** (https://www.adif.es/viajeros/estado-de-la-red): su CDN responde 403
  a cualquier cliente automatizado.
- **NAP del Ministerio de Transportes** (https://nap.transportes.gob.es/api/index.html): requiere
  una ApiKey gratuita.
- **TMB Barcelona** (developer.tmb.cat) y **EMT Madrid MobilityLabs**: requieren registro gratuito.
- **Metro de Sevilla**: su API responde con token inválido.
- **Metro de Málaga, Tranvía de Murcia y TRAM Barcelona**: no se encontró tiempo real.

## Lo que necesito que investigues

### Prioridad 1: que estén *todos* los trenes
1. **Iryo, Ouigo y los trenes de mercancías** (Medway, Captrain, Renfe Mercancías…) **no aparecen en
   los feeds de Renfe.** Busca si existe alguna fuente pública con las circulaciones de todos los
   operadores. Pistas:
   - Datos de Adif: paneles de estaciones, la app de Adif, datos abiertos de Adif.
   - Feeds propios de Iryo y Ouigo.
   - Datos que exija la normativa europea: TAF/TAP TSI y el Reglamento Delegado (UE) 2017/1926
     sobre puntos de acceso nacionales.
2. **Adif**: canales oficiales para incidencias, estado de la red, obras, cortes y limitaciones
   temporales de velocidad. Busca un portal de datos abiertos, una API, RSS, convenios de
   reutilización o cuentas oficiales con datos estructurados. Indica también cómo solicitar
   acceso formalmente si no lo hay.
3. Ferrocarriles autonómicos y de vía estrecha que falten:
   - Euskotren con posiciones
   - Antiguo FEVE (Cercanías AM)
   - SFM Mallorca
   - FGV
   - Ferrocarril de Sóller

### Prioridad 2: metros, tranvías y buses de todas las ciudades
Para cada metro, tranvía y metro ligero de España, y para los autobuses de las 20 ciudades más
grandes, indica:
- si hay posiciones en tiempo real o solo llegadas;
- la URL, el formato y si requiere autenticación;
- si figura en el NAP (nap.transportes.gob.es) y en qué formato.

### Prioridad 3: otras situaciones de emergencia o riesgo
- **Incendios**:
  - NASA FIRMS, EFFIS / Copernicus
  - servicios autonómicos (INFOCA, Bombers de la Generalitat, etc.)
  - perímetros de incendios activos
- **Inundaciones y DANAs**:
  - SAIH de cada confederación hidrográfica (niveles y caudales en tiempo real)
  - embalses (Boletín Hidrológico del MITECO)
  - Copernicus EMS y GloFAS
  - radar de precipitación de AEMET
- **Meteorología**:
  - AEMET OpenData (avisos con polígonos CAP, observación en tiempo real, rayos, radar)
  - servicios autonómicos (Meteocat, Euskalmet, MeteoGalicia)
- **Sismos y volcanes**:
  - servicio FDSN del IGN
  - vigilancia volcánica de Canarias (IGN, INVOLCAN)
  - alertas de tsunami
- **Energía**:
  - REE: frecuencia, generación e intercambios; algo que ayude a detectar un apagón como el del
    28 de abril de 2025
  - mapas de averías de las distribuidoras (i-DE, e-distribución, UFD…)
- **Carreteras autonómicas**:
  - Servei Català de Trànsit, Tráfico Euskadi
  - cámaras de la DGT y de las comunidades autónomas
- **Mar y aire**:
  - AIS (AISStream, Puertos del Estado)
  - Salvamento Marítimo
  - ENAIRE (NOTAM, espacio aéreo)
  - aeropuertos de Aena
- **Protección Civil y 112**: avisos públicos, ES-Alert y datos abiertos autonómicos de emergencias.
- **Salud ambiental**: calidad del aire (MITECO y comunidades autónomas) y polen.
- **Telecomunicaciones**: caídas de red móvil o fija, si existe algún dato público.
- Cualquier otra fuente pública que sirva para anticipar o detectar una catástrofe y que no esté
  en esta lista.

## Reglas
- **Solo fuentes públicas y legítimas.** Revisa las condiciones de uso, la licencia, la atribución
  obligatoria y los límites de peticiones de cada una.
- **No propongas esquivar bloqueos** (403, captchas, protección anti-bot) ni suplantar navegadores.
  Si algo está bloqueado, indica la vía oficial para solicitar acceso.
- **Verifica cada URL** abriéndola y anota la fecha, el resultado y una muestra de los campos.
  Distingue claramente entre lo que has comprobado y lo que solo has leído en documentación de
  terceros.
- Marca como «no documentado» lo que sea el backend de una web o app y no un dato abierto oficial.

## Formato de entrega
1. **Hoja de cálculo** (XLSX o CSV) con una fila por fuente y estas columnas:
   - categoría (ferroviario / metro / tranvía / bus / carretera / meteo / sismo / incendio /
     inundación / energía / mar / aire / emergencias / otro)
   - organismo u operador
   - nombre del dataset
   - URL del endpoint y URL de la documentación
   - formato (GTFS-RT, GTFS, DATEX II, CAP, JSON, XML, WMS…)
   - tipo para Radar ES (vehicles / events / metrics / estático)
   - cobertura geográfica
   - frecuencia de actualización
   - autenticación (ninguna / clave gratuita / registro / de pago)
   - licencia y atribución
   - límites de uso
   - estado de la verificación (fecha y código HTTP)
   - muestra de campos
   - prioridad (alta / media / baja) y notas
2. **Resumen** de una página:
   - las 15 fuentes con más impacto para el objetivo de seguridad;
   - las lagunas que no se pueden cubrir con datos públicos;
   - a qué organismos conviene pedir acceso formal y cómo.
