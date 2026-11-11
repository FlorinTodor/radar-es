**A la atención de:** Ayuntamiento de Madrid — Portal de datos abiertos (datos.madrid.es)

**Asunto:** Uso del RSS del conjunto «Notas de prensa» y su robots.txt

---

D./D.ª **[NOMBRE Y APELLIDOS]**, con DNI/NIE **[NÚMERO]**, domicilio a efectos de notificaciones en
**[DIRECCIÓN]** y correo electrónico **[EMAIL]**,

**EXPONE**

1. Que desarrollo **Radar España** (radarespaña.es), un proyecto **sin ánimo de lucro y sin publicidad**. Es un
   mapa público que reúne, a partir de datos oficiales, la circulación de trenes y autobuses y las emergencias
   en España, incluidos los avisos oficiales de protección civil (planes activados y cortes de luz).

2. Que el catálogo de datos abiertos del Ayuntamiento ofrece el conjunto **«Notas de prensa»**
   (`https://datos.madrid.es/dataset/200034-0-notas-prensa`) con licencia **CC BY 4.0**, cuyo recurso es el RSS
   `https://www.madrid.es/ContentPublisher/jsp/apl/obtenerRSS.jsp?tipoContenido=Noticia&idCanal=6091317d3d2a7010VgnVCM100000dc0ca8c0RCRD`.

3. Que Radar España lee ese RSS una vez cada 15 minutos y sólo muestra las notas cuyo título activa o termina un
   plan de emergencias de la ciudad (PEMAM, plan de emergencias invernales…) o habla de un corte de luz, con su
   título y su primer párrafo sin alterar, la atribución «Origen de los datos: Ayuntamiento de Madrid» y la fecha
   de la última actualización, sin fotos ni logotipos.

4. Que el robots.txt de www.madrid.es prohíbe la ruta `/ContentPublisher/`, que es justo la del RSS que publica el
   catálogo. Entiendo que esa regla está pensada para los buscadores y no para el recurso que el propio catálogo
   ofrece para reutilizar, y por eso lo uso, avisándoles con este escrito.

**SOLICITA**

1. Que se confirme que ese uso del RSS es conforme. O, si se prefiere, que se permita esa ruta en robots.txt o se
   indique otra dirección del mismo recurso.
2. Si no se acepta, que se me comunique y dejaré de leerlo.
3. Que se indique la atribución y la frecuencia de consulta que se consideren adecuadas.

Me comprometo a citar la fuente y la fecha de cada aviso, no alterar ni desnaturalizar su contenido, no usar
logotipos ni escudos y dejar de leer el canal si así se me pide.

En **[LUGAR]**, a **[FECHA]**.

Firmado: **[NOMBRE Y APELLIDOS]**

---

**Nota interna (no enviar):** se presenta por el formulario de contacto de datos.madrid.es (compruébalo antes de
enviar). Si dicen que no, se quita la fuente `emergencias-madrid-ciudad` de
`server/adapters/outbound/sources/index.js` y su fila de /legal y del README. Es el mismo caso que el del Govern
balear (solicitud 10).
