**A la atención de:** Govern de les Illes Balears — Dades obertes (dadesobertes@caib.es)

**Assumpte / Asunto:** Uso del RSS de la sala de prensa (conjunto «Actualidad Informativa - Comunicaciones») y su
robots.txt

---

D./D.ª **[NOMBRE Y APELLIDOS]**, con DNI/NIE **[NÚMERO]**, domicilio a efectos de notificaciones en
**[DIRECCIÓN]** y correo electrónico **[EMAIL]**,

**EXPONE**

1. Que desarrollo **Radar España** (radarespaña.es), un proyecto **sin ánimo de lucro y sin publicidad**. Es un
   mapa público que reúne, a partir de datos oficiales, la circulación de trenes y autobuses y las emergencias
   en España, incluidos los avisos oficiales de protección civil (planes activados y cortes de luz).

2. Que el catálogo de datos abiertos del Govern ofrece, con licencia **CC BY**, el conjunto «Actualidad
   Informativa - Comunicaciones» (`https://datos.gob.es/catalogo/a04003003-actualidad-informativa-comunicaciones-del-gobierno-de-las-islas-baleares1`),
   cuyo recurso es el RSS de la sala de prensa en catalán:
   `https://www.caib.es/pidip2front/pidipRSS?opcio=getRSS&grup=salaDePremsa&lang=ca`.

3. Que Radar España lee ese RSS una vez cada 15 minutos y sólo muestra las declaraciones de alerta o emergencia de
   protección civil, su fin y los cortes de luz, con el título y la fecha sin alterar y la atribución «Font de les
   dades: Govern de les Illes Balears».

4. Que el robots.txt de www.caib.es prohíbe la ruta `/pidip2front`, que es justo la del recurso que publica el
   catálogo. Entiendo que esa regla está pensada para los buscadores y no para el recurso que el propio catálogo
   ofrece para reutilizar, y por eso lo uso desde el 2-11-2026, avisándoles con este escrito.

**SOLICITA**

1. Que se confirme que ese uso del RSS es conforme. O, si se prefiere, que se permita esa ruta en robots.txt o se
   indique otra dirección del mismo recurso.
2. Si no se acepta, que se me comunique y dejaré de leerlo.

Me comprometo a citar la fuente y la fecha de cada aviso, no alterar ni desnaturalizar su contenido, no usar
logotipos ni escudos y dejar de leer el canal si así se me pide.

En **[LUGAR]**, a **[FECHA]**.

Firmado: **[NOMBRE Y APELLIDOS]**

---

**Nota interna (no enviar):** está pendiente desde el 2-11-2026 (el borrador de entonces citaba `lang=es`; la
URL que se usa es la de `lang=ca`). Puede enviarse en castellano o en catalán. Si dicen que no, se quita la fuente
`emergencias-illes-balears` de `server/adapters/outbound/sources/index.js` y su fila de /legal y del README.
