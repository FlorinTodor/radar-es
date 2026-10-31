# Radar ES · Catálogo de fuentes públicas — Resumen

> **Aviso (2026-11-01): algunas fuentes de este documento ya NO se usan.** Por licencia se retiraron el visor de Renfe
> (`flota.json`, `flotaLD.json`, `estaciones.geojson`, `trenesConEstacionesLD.json`), la API del
> tranvía de Tenerife (`tranviaonline`), la API de la app de Rodalies (`serveisgrs`), adsb.lol e IODA.
> Este documento recoge la exploración inicial; las fuentes vigentes y sus licencias están en
> [radarespaña.es/legal](https://radarespaña.es/legal).

Oct 30, 2026 · @Backend-GestionaSistemas

## Alcance y método

El catálogo reúne 107 fuentes en 14 categorías, en la hoja `radar_es_catalogo_fuentes.xlsx`. De ellas, 32 se abrieron con éxito el 30/10/2026, 24 son las que ya tenías y 51 siguen pendientes de prueba desde tu backend.

- **Cómo se verificó:** la red del entorno de trabajo no permitía llamadas HTTP directas, así que cada URL se abrió con un lector web. Por eso no siempre se dispone del código HTTP exacto: se anota «contenido recibido» o el tipo de error, junto con los campos de muestra.
- **Las 51 pendientes:** 13 tienen un robots.txt que impide abrirlas con el lector web, lo que no significa que fallen. En 9 hubo error o la página vino vacía. Las 29 restantes proceden solo de documentación o de conocimiento previo.
- **Lo «no documentado»** (backends de webs o apps) está marcado así y nunca se propone esquivar bloqueos.
- **Hallazgos de frescura:** el GeoJSON de autobuses de Málaga lleva congelado desde el 1-10-2026 y `pm.xml` de Madrid devolvió datos del 19-10-2026. Hay que vigilar la antigüedad de cada feed.

## Las 15 fuentes con más impacto

Las fuentes de mayor impacto son las que detectan antes una anomalía grave: un tren detenido, un corte de vía, un apagón, un incendio, una crecida o un sismo. Las tres primeras completan la visión ferroviaria y dependen de pedir acceso.

| # | Fuente | Qué detecta | Estado |
| --- | --- | --- | --- |
| 1 | [Adif – Estado de la red](https://www.adif.es/viajeros/estado-de-la-red) + acceso formal a Info Adif | Cortes e incidencias de todos los operadores, incluidos Iryo y Ouigo | Leída el 30/10; sin datos estructurados |
| 2 | NAP del Ministerio (API con clave gratuita) | Retrasos, cancelaciones e incidencias ferroviarias en formato SIRI, obligatorios desde el 1-12-2025 | Swagger verificado; datos por probar |
| 3 | Renfe GTFS-RT y visores de flota | Trenes de Renfe detenidos o con retraso anómalo | Integrada |
| 4 | DGT DATEX II (incidencias y V-16) | Accidentes, cortes y vehículos detenidos en carretera | Integrada; V-16 por confirmar |
| 5 | AEMET: RSS de avisos CAP y OpenData | Avisos con polígonos, rayos y radar | RSS verificado |
| 6 | REE: REData y e·sios | Caída brusca de la demanda (apagón) y generación por tecnología | Demanda integrada; e·sios con clave |
| 7 | IGN GeoRSS + EMSC (FDSN y WebSocket) | Terremotos en minutos | Integradas |
| 8 | NASA FIRMS (VIIRS) | Focos de incendio en unas 3 h | CSV verificado; API con clave |
| 9 | Copernicus EFFIS (WMS) | Perímetros de incendios recientes | Verificado |
| 10 | SAIH de las confederaciones + API SDIM de la ACA | Niveles y caudales cada 5–15 min | Sin API común; ACA por probar |
| 11 | GDACS | Alertas globales con nivel de severidad | Verificado |
| 12 | Servei Català de Trànsit + Tráfico Euskadi | Incidencias de carretera que no cubre la DGT | Ambas verificadas |
| 13 | IODA (Georgia Tech) | Caídas de Internet por país y región | Por probar (robots) |
| 14 | FGC, Metro Bilbao y MoveUskadi | Posiciones de trenes, metro y bus | Integradas o probadas |
| 15 | ADS-B (adsb.lol / OpenSky) | Squawk 7700, desvíos y cierres de espacio aéreo | adsb.lol verificado |

## Prioridad 1: todos los trenes

No existe hoy ninguna fuente abierta con posiciones de Iryo, Ouigo ni de los trenes de mercancías. La vía más sólida es legal: el [Reglamento Delegado (UE) 2024/490](https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX:32024R0490) obliga a publicar en el NAP las horas estimadas de salida y llegada, los retrasos, las cancelaciones y las perturbaciones. La obligación rige para la red TEN-T global desde el 1-12-2025 y para el resto de la red desde el 1-12-2028 (art. 5.3 y anexo 2.1).

- **Iryo y Ouigo:** sus datos llegarán por el NAP en formato SIRI o NeTEx, no como posiciones GPS. Con la ApiKey, lista los operadores ferroviarios (`/api/Operador`) para ver qué publican ya. Si aún no publican, la reclamación se dirige al Ministerio como órgano gestor del NAP.
- **Adif:** su página de estado de la red es la única vista pública que incluye a todos los operadores, pero no tiene RSS ni API. Hoy informa de un alcance entre un tren de Renfe y otro de Iryo en la LAV Madrid-Andalucía, a la altura del PK 118. Info Adif y la app de Adif son backends no documentados con peticiones firmadas, así que no deben reutilizarse sin autorización.
- **Mercancías:** las TAF/TAP TSI ([Reglamento (UE) 2023/1693](https://eur-lex.europa.eu/eli/reg/2023/1693/oj)) regulan el intercambio de datos entre el administrador de infraestructuras y las empresas, no su publicación abierta. El TIS de RailNetEurope solo está disponible para miembros. Es una laguna.
- **Vía estrecha:** Euskotren solo publica trip updates. FEVE (Cercanías AM) solo tiene listado de estaciones en [data.renfe.com](https://data.renfe.com/dataset/listado-estaciones-feve). En FGV solo hay tiempos de llegada no documentados y su infraestructura en WMS/WFS de la GVA. No se encontraron datos de SFM Mallorca (el catálogo de la CAIB redirige a una intranet) ni del Ferrocarril de Sóller.

## Lagunas sin datos públicos

Nueve huecos no se pueden cubrir hoy con datos abiertos. Las tres primeras son las más críticas para el objetivo de seguridad.

- **Posiciones de Iryo, Ouigo y los trenes de mercancías**, y el estado de la vía: cortes, obras y limitaciones temporales de velocidad de Adif.
- **SAIH unificado:** cada confederación tiene su propio visor y no hay una API común de niveles y caudales.
- **Averías de las distribuidoras eléctricas** (i-DE, e-distribución, UFD, Viesgo) y **frecuencia de red en tiempo real**.
- **ES-Alert y los 112 autonómicos:** no hay feed ni archivo de las alertas enviadas; solo se publican en redes sociales.
- **Incendios activos autonómicos:** solo Castilla y León los publica en abierto; INFOCA, Bombers y la Xunta los comunican en X.
- **Caídas de red móvil o fija:** no hay datos oficiales; solo señales indirectas como IODA o Cloudflare Radar (esta última con licencia no comercial).
- **Tiempo real de Metro de Málaga, Tranvía de Murcia, TRAM Barcelona, SFM, Metro de Sevilla y Aena.**
- **Salvamento Marítimo y alertas de tsunami del IGN:** sin feed estructurado.
- **Semáforo volcánico de Canarias (PEVOLCA):** sin feed.

## A quién pedir acceso formal y cómo

La vía general es una solicitud de reutilización al amparo de la Ley 37/2007, presentada en la sede electrónica de cada organismo, o una petición de datos en datos.gob.es. Si la información no está publicada, se puede presentar además una solicitud de acceso por el Portal de Transparencia (Ley 19/2013). Conviene explicar el fin público del proyecto y el formato que se pide (GTFS-RT, SIRI, DATEX II o CAP).

| Organismo | Qué pedir | Base o vía |
| --- | --- | --- |
| Ministerio de Transportes (NAP) | ApiKey, y que Iryo, Ouigo y Adif publiquen SIRI-ET/SX | Registro en el NAP; Reglamento 2024/490 |
| Adif | Feed del estado de la red, LTV y circulaciones de todos los operadores | Sede de Adif (Ley 37/2007) o convenio |
| Iryo y Ouigo | GTFS-RT o SIRI en tiempo real | Contacto corporativo; obligación en el NAP |
| DGT | Confirmar si las V-16 están en DATEX II o pedir el feed de DGT 3.0 | NAP de la DGT; convenio DGT 3.0 |
| MITECO – DG del Agua | Servicio SAIH unificado de niveles y caudales | Sede del MITECO |
| DGPCE (Protección Civil) | Archivo CAP público de las alertas ES-Alert enviadas | Sede del Ministerio del Interior |
| CNMC y distribuidoras | Datos de interrupciones del suministro | Sede de la CNMC |
| Euskotren, FGV, SFM y Metro de Sevilla | GTFS-RT con posiciones | Sede de cada operador o consorcio |
| Red Eléctrica | Token de e·sios | Formulario en esios.ree.es/es/token |

**Fuentes consultadas el 30/10/2026:** [EUR-Lex 2024/490](https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX:32024R0490) · [NAP swagger](https://nap.transportes.gob.es/api/swagger/v1/swagger.json) · [Adif – Estado de la red](https://www.adif.es/viajeros/estado-de-la-red) · [Renfe Data](https://data.renfe.com/dataset) · [NAP DGT](https://nap.dgt.es/) · [AEMET RSS CAP](https://www.aemet.es/documentos_d/eltiempo/prediccion/avisos/rss/CAP_AFAE_wah_RSS.xml) · [EFFIS WMS](https://maps.effis.emergency.copernicus.eu/effis?service=WMS&request=GetCapabilities) · [GDACS](https://www.gdacs.org/xml/rss.xml) · [MITECO Boletín Hidrológico](https://www.miteco.gob.es/es/agua/temas/evaluacion-de-los-recursos-hidricos/boletin-hidrologico.html)
