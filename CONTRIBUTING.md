# Cómo contribuir a Radar España

*Read this in English: [CONTRIBUTING.en.md](CONTRIBUTING.en.md).*

Gracias por querer mejorar [radarespaña.es](https://radarespaña.es). Se agradecen sobre todo:

- **avisos de fallos**: un tren en un sitio imposible, una fuente que no carga, un aviso que no
  debería salir o que falta;
- **fuentes de datos públicas** que aún no están, con licencia de reutilización;
- **mejoras del código, de los textos y de la accesibilidad** de la web.

Antes de nada, lee el apartado de la licencia: el código no es libre.

## La licencia y tus contribuciones

El código es de su autor, con **todos los derechos reservados** (ver [LICENSE](LICENSE)). Se publica
para que se pueda consultar, no para reutilizarlo en otros proyectos.

- **Lo que te permite esta guía:** bifurcar (fork) el repositorio y modificar el código **sólo para
  proponer cambios a este proyecto** mediante un pull request. No te autoriza a usarlo, publicarlo
  ni distribuirlo para nada más.
- **Lo que aceptas al enviar un pull request:** que tu contribución es obra tuya (o que tienes derecho
  a aportarla) y que concedes al titular del proyecto, Florin Emanuel Todor Gliga, una licencia
  gratuita, perpetua, mundial e irrevocable para usarla, modificarla, publicarla y sublicenciarla
  como parte de Radar España, en las mismas condiciones que el resto del código. Si no estás de
  acuerdo, abre una issue con la idea en vez de enviar código.
- **No aportes código copiado** de otros proyectos ni generado a partir de código con una licencia
  que no lo permita.

## Avisar de un fallo

Abre una [issue](https://github.com/FlorinTodor/radar-es/issues) con:

- **qué has visto y qué esperabas**;
- **dónde**: el tren (número, línea u operador), la estación o el aviso, y si puedes, una captura;
- **cuándo**: la fecha y la hora, porque muchos datos cambian cada pocos segundos;
- **el navegador y el dispositivo**, si es un fallo de la web.

**Fallos de seguridad:** no abras una issue pública. Escribe a
[radarespana@proton.me](mailto:radarespana@proton.me) y espera la respuesta antes de contarlo.

## Proponer una fuente de datos

Radar España sólo usa datos que se pueden reutilizar legalmente. Una fuente nueva tiene que cumplir
todo esto:

- **licencia de reutilización comprobada** en su texto original: CC BY, la del Punto de Acceso
  Nacional, la de un portal de datos abiertos…;
- **un canal público pensado para reutilizarse**: un GTFS, un GTFS-RT, una API abierta o un RSS.
  No valen los endpoints internos de una app o de un visor web, aunque se vean desde el navegador;
- **respeto a sus condiciones y a su `robots.txt`**: si la fuente bloquea o responde 403, no se
  esquiva; se le pide acceso;
- **la atribución que pida**, en el mapa, en la ficha de lo que muestra y en `/legal`.

Si no estás seguro de la licencia, abre una issue con el enlace al conjunto de datos y sus
condiciones antes de programar nada. Cómo se añade una fuente al código está en el README
([Añadir una fuente](README.md#añadir-una-fuente)).

## Enviar cambios

1. **Bifurca el repositorio** y crea tu rama desde `dev`: `feature/<nombre>` para algo nuevo y
   `fix/<nombre>` para un arreglo.
2. **Haz el cambio** respetando la arquitectura (ver más abajo) y con sus tests.
3. **Comprueba que todo pasa:** `npm test` tiene que acabar sin fallos.
4. **Abre el pull request contra `dev`**, nunca contra `produccion`.

Sólo el autor fusiona en `dev` y sube `dev` a producción, después de pasar por el entorno de
pruebas (ver [Ramas](README.md#ramas)).

### Arquitectura

El servidor sigue una **arquitectura hexagonal** (ver
[Arquitectura hexagonal](README.md#arquitectura-hexagonal)):

- **El dominio** (`server/domain/`) es puro: nada de red, disco ni dependencias externas.
- **Los casos de uso** (`server/application/`) sólo hablan con el exterior a través de los puertos
  de `ports.js`.
- **Lo que lee o escribe fuera** es un adaptador (`server/adapters/`), y `server/main.js` es el único
  sitio que los conecta.
- **Dependencias:** no añadas una nueva sin hablarlo antes en una issue: el proyecto tiene muy pocas a
  propósito.

### Tests

- **Cada cambio, con sus tests**, en `test/`, con la misma estructura que `server/`.
- **Sin red:** las respuestas de las fuentes se simulan.
- **Sin depender del tiempo real ni de la velocidad de la máquina:** nada de «espera 50 ms y mira».
  Usa relojes simulados (`now: () => t`, `t.mock.timers`) o espera a una señal explícita. Los tests
  se pasan también en el servidor, que es mucho más lento que un ordenador normal.
- **Si tu cambio carga más datos o hace más cálculos**, cuéntalo en el pull request: el servidor tiene
  la memoria justa.

### Commits

- **En español**, con un cambio lógico por commit.
- **El mensaje dice qué cambia y por qué**, pensando en quien usa el mapa. Delante va la parte a la que
  afecta, si ayuda: «Avisos oficiales: uno nuevo de toda la comunidad sustituye a los anteriores de
  cada provincia».
- **Nada de mensajes genéricos** como «fix», «cambios» o «arreglos varios».

### El pull request

- **Qué hace y por qué**, y la issue que resuelve si la hay.
- **Cómo lo has probado**: `npm test` y, si cambia la web, una captura.
- **Si añade una fuente**: su licencia, su atribución y el enlace a sus condiciones.
- **Pequeño y centrado en una cosa:** varios cambios sin relación, mejor en varios pull requests.

El autor revisa cada pull request. Puede tardar unos días y, si algo no encaja con el proyecto, te lo
explicará.

## Textos de la web

- **En español**, claros y sin tecnicismos para quien no es del mundo ferroviario.
- **Lo estimado se dice:** una posición calculada a partir del horario se marca como estimada, y nunca
  se presenta como un GPS.
- **Los datos de cada fuente se citan con su atribución**, y si se modifican, se dice qué se ha hecho
  con ellos.

## Qué falta por hacer

Las ideas pendientes están en el README:
- [Posibles mejoras](README.md#posibles-mejoras);
- [Pendiente y conocido](README.md#pendiente-y-conocido), con los datos que todavía no publica nadie.

Si quieres ponerte con una, abre antes una issue para hablarlo y no repetir trabajo.
