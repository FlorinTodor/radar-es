# Accesibilidad de las estaciones: fuentes revisadas

La ficha de cada estación dice si es accesible en silla de ruedas **según Renfe**. Es el campo
`wheelchair_boarding` de sus GTFS, que tienen licencia CC BY 4.0. Los GTFS de Cercanías y de
AV/LD/MD coinciden en todas las estaciones que comparten.

A 2026-11-01, de las 1.525 estaciones del mapa:
- 637 son accesibles;
- 868 no lo son;
- 20 no tienen dato. Son estaciones del listado oficial que no salen en ningún GTFS de Renfe, como
  las de la línea Lleida–La Pobla, que opera FGC.

Por tipo de estación:
- en Cercanías son accesibles 581 de 933 (62 %);
- fuera de Cercanías, 56 de 597 (9 %).

## Otras fuentes revisadas (2026-11-01)

| Fuente | Qué tiene | ¿Se puede usar? |
|---|---|---|
| Renfe, GTFS | Accesible sí/no por estación | **Sí** (CC BY 4.0). Es la única que cubre toda España. |
| Renfe, «Estaciones con servicio Atendo» | Estaciones con asistencia | No: sigue en el catálogo de datos.gob.es, pero el fichero ya no existe en data.renfe.com. Desde diciembre de 2020 la asistencia la presta Adif con el nombre «Acerca». |
| Adif Acerca | Unas 146 estaciones con asistencia | No: no se publica como datos abiertos ni con licencia de reutilización. |
| Adif, «Dependencias Adif público» (ArcGIS) | Inventario de 3.087 dependencias (estaciones, apeaderos, bifurcaciones, puntos kilométricos…): nombre, código (el mismo que Renfe), tramo, tipo, estado, municipio, código postal y titular | Licencia: cualquier uso citando «© Administrador de infraestructuras ferroviarias». **No trae accesibilidad, servicios ni asistencia.** |
| Adif, «Tramos en servicio Adif público» (ArcGIS) | Red ferroviaria en vectorial: 1.174 tramos con estación de origen y destino, tipo de red, ancho, electrificación, túneles y puentes | Misma licencia abierta. **No trae accesibilidad**, pero sirve para pegar a la vía el recorrido de AVE, Larga y Media Distancia. |
| Adif, «Terminales de viajeros» (ArcGIS) | Pasajeros y clasificación, pero sólo de 72 estaciones del Corredor Mediterráneo | No: sólo cubre ese corredor y no indica licencia. |
| Web de Adif (`adif.es/viajeros/estaciones`) | Ficha de cada estación con servicios y accesibilidad | No: responde 403 a cualquier programa (no se salta) y no tiene licencia de reutilización. Como mucho, enlazarla. |
| FGC, GTFS y «Accessibilitat» | Accesibilidad de sus estaciones y de sus itinerarios | Licencia CC BY 4.0, pero en la línea Lleida–La Pobla el GTFS pone «sin datos». No aporta nada para las estaciones de Renfe. |
| Euskadi, «Estaciones de transporte» | 24 estaciones turísticas | No: el campo de accesibilidad está vacío. |
| Consorcio Regional de Transportes de Madrid | Accesibilidad de accesos, vestíbulos y andenes | Su licencia permite reutilizar citando la fuente («Powered by CRTM», que ya se muestra). Sólo cubre Madrid y, según un análisis publicado, los datos de las estaciones están incompletos. Hay que revisarlo antes de usarlo. |
| OpenStreetMap | Etiqueta `wheelchair` en 337 de 1.122 estaciones de tren (288 sí, 25 limitada, 24 no) | No como fuente principal: cubre el 30 %, casi todo estaciones grandes. Además, la ODbL obliga a publicar con esa licencia los datos que se mezclen. |

En 2022 Adif contestó al Gobierno que 863 de 1.495 estaciones tenían itinerario accesible, más que
las que marca hoy el GTFS de Renfe. Esa cifra no se publica estación por estación, así que no se
puede usar en el mapa. Por eso la ficha dice «según Renfe».

## Fuentes

- [GTFS y estaciones de Renfe (data.renfe.com, CC BY 4.0)](https://data.renfe.com/dataset/estaciones-listado-completo)
- [Catálogo de datos.gob.es (Renfe)](https://datos.gob.es/en/catalogo?q=renfe)
- [Informe de la ERA: Atendo pasa a Adif («Acerca») en diciembre de 2020](https://era.europa.eu/sites/default/files/reports/2021_ERA_SQP_sp.pdf)
- [Accesibilidad en trenes, unas 146 estaciones con asistencia (Spain.info)](https://www.spain.info/es/descubrir-espana/accesibilidad-trenes/)
- [Asistencia a personas con movilidad reducida (administracion.gob.es)](https://administracion.gob.es/pag_Home/Tu-espacio-europeo/derechos-obligaciones/ciudadanos/viajes/movilidad-reducida)
- [FGC: accesibilidad (fgc.opendatasoft.com, CC BY 4.0)](https://fgc.opendatasoft.com/explore/dataset/accesibilidad-itinerarios/table/)
- [FGC: paradas GTFS (fgc.opendatasoft.com, CC BY 4.0)](https://fgc.opendatasoft.com/explore/dataset/gtfs_stops/table/)
- [Estaciones de transporte de Euskadi (opendata.euskadi.eus)](https://opendata.euskadi.eus/contenidos/ds_recursos_turisticos/estaciones_transporte_euskadi/opendata/transporte.json)
- [Adif: «Dependencias Adif público»](https://www.arcgis.com/home/item.html?id=b181bd5b69bb40aca11892a6361c39f5)
- [Adif: «Tramos en servicio Adif público»](https://www.arcgis.com/home/item.html?id=4ec7c0fb3cab42b0b488d65e65eeb7aa)
- [Datos abiertos de Adif en ArcGIS (servicios de `ideadif_adif`)](https://services7.arcgis.com/XTupIrLX53AjaJqO/arcgis/rest/services)
- [Licencia de uso del CRTM](https://www.crtm.es/licencia-de-uso/)
- [Análisis de las paradas accesibles de Metro de Madrid (Universitat de València)](https://www.uv.es/dataenhance/datasets/2526020013.html)
- [ES:Importación CRTM (wiki de OpenStreetMap)](https://wiki.openstreetmap.org/wiki/ES:Import_CRTM)
- [Estaciones de Adif con itinerario accesible (The Objective, 2022)](https://theobjective.com/espana/2022-08-10/compromis-estaciones-tren-accesibles/)
