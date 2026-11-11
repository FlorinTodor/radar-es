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

3. Que desde el **4 de noviembre de 2026** (comprobado de nuevo el 11 de noviembre) el portal responde con
   un error HTTP 404 («Página no encontrada») a todas las peticiones del programa de Radar España desde su
   servidor, también a la portada. Desde ese mismo servidor, el RSS sí responde a un programa genérico que no
   se identifica, y desde otras redes responde también a Radar España. Entiendo que es una protección del
   portal frente a programas automáticos que llegan desde centros de datos y que no conoce el nuestro. No he
   intentado esquivarla (ni ocultando quién lo pide ni desde otra red), y el servicio ha dejado de leer la
   fuente hasta que se resuelva.

**SOLICITA**

1. Que se permita al servidor de Radar España leer el RSS «Últimas noticias». Facilito por este medio su
   dirección IP, **[IP DEL SERVIDOR]**, y el agente de usuario con el que se identifica:
   `RadarES/0.2 (+https://xn--radarespaa-19a.es; Radarespana@proton.me)`.
2. O, si se prefiere, que se indique otro canal abierto con los avisos de emergencias (planes activados y
   cortes del suministro eléctrico). El portal datos.comunidad.madrid no lo tiene, y su robots.txt no admite
   ningún programa.
3. Que se indique la atribución y la frecuencia de consulta que se consideren adecuadas.

Me comprometo a citar la fuente y la fecha de cada aviso, no alterar ni desnaturalizar su contenido, no usar
logotipos ni escudos y dejar de leer el canal si así se me pide.

En **[LUGAR]**, a **[FECHA]**.

Firmado: **[NOMBRE Y APELLIDOS]**

---

**Nota interna (no enviar):** la IP del servidor no se escribe en este repositorio, que es público. Ponla
sólo en el mensaje que envíes. El 11-11-2026 se buscó otro canal de la Comunidad sin este problema y no lo
hay. Mientras tanto, de la ciudad salen los avisos del Ayuntamiento (solicitud 9). Cuando el portal
responda, se quita `paused` de la fuente `emergencias-madrid` en `server/adapters/outbound/sources/index.js`.
