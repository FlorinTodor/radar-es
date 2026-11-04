**A la atención de:** Comunidad de Madrid — responsables del portal comunidad.madrid / Datos abiertos

**Asunto:** Acceso al RSS «Últimas noticias» de comunidad.madrid desde el servidor de Radar España

---

D./D.ª **[NOMBRE Y APELLIDOS]**, con DNI/NIE **[NÚMERO]**, domicilio a efectos de notificaciones en
**[DIRECCIÓN]** y correo electrónico **[EMAIL]**,

**EXPONE**

1. Que desarrollo **Radar España** (radarespaña.es), un proyecto **sin ánimo de lucro y sin publicidad**. Es un
   mapa público que reúne, a partir de datos oficiales, la circulación de trenes y autobuses y las emergencias
   en España, incluidos los avisos oficiales de protección civil (planes activados y cortes de luz).

2. Que, para la Comunidad de Madrid, Radar España usa el canal público **RSS «Últimas noticias»**
   (`https://www.comunidad.madrid/rss/latest-news.xml`), conforme al aviso legal del portal. Sólo toma las
   notas de prensa sobre planes de emergencia con nombre (PLATERCAM…) y cortes de luz, cita la fuente y la
   fecha de extracción y no altera su contenido. Lo consulta como mucho cada 15 minutos.

3. Que desde el **4 de noviembre de 2026** el portal responde con un error (HTTP 404, con una página de
   comprobación «antibot») a todas las peticiones del servidor de Radar España, también a la portada y al
   archivo robots.txt, mientras que el mismo canal responde con normalidad desde otras redes. Entiendo que
   se trata de una protección del portal frente a tráfico automatizado. No he intentado esquivarla, y el
   servicio ha dejado de leer la fuente hasta que se resuelva.

**SOLICITA**

1. Que se permita al servidor de Radar España leer el RSS «Últimas noticias». Facilito por este medio su
   dirección IP, **[IP DEL SERVIDOR]**, y el agente de usuario con el que se identifica:
   `RadarES/0.1 (visor de datos abiertos de movilidad y emergencias; +https://xn--radarespaa-19a.es; radarespana@proton.me)`.
2. O, si se prefiere, que se indique otro canal abierto con los avisos de emergencias (planes activados y
   cortes del suministro eléctrico), por ejemplo un conjunto de datos del portal datos.comunidad.madrid.
3. Que se indique la atribución y la frecuencia de consulta que se consideren adecuadas.

Me comprometo a citar la fuente y la fecha de cada aviso, no alterar ni desnaturalizar su contenido, no usar
logotipos ni escudos y dejar de leer el canal si así se me pide.

En **[LUGAR]**, a **[FECHA]**.

Firmado: **[NOMBRE Y APELLIDOS]**

---

**Nota interna (no enviar):** la IP del servidor no se escribe en este repositorio, que es público. Ponla
sólo en el mensaje que envíes. Cuando el portal responda, se quita `paused` de la fuente
`emergencias-madrid` en `server/adapters/outbound/sources/index.js`.
