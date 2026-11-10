# Puntualidad histórica

El radar guarda, día a día, cómo llega cada servicio y cómo va cada línea, para **cualquier tipo de vehículo
cuyo operador publique su retraso** (trenes, autobuses, metros, tranvías y los tipos que se añadan). Sólo
usa las claves `follow` de cada vehículo y de cada cancelación (ver [vehiculos.md](vehiculos.md)): no sabe
de fuentes ni de tipos.

Donde un operador no publica el retraso (horarios sin tiempo real, posiciones estimadas sólo por horario),
no hay puntualidad, y la ficha lo dice.

## Qué se guarda

Por día de servicio en Madrid y durante **60 días**:

- **De cada servicio** (clave `s-…`, un tren o un autobús concreto que se repite cada día):
  - su **último retraso conocido**, que es el de su llegada;
  - el **máximo** del día;
  - si su operador lo **canceló** o le **suprimió paradas** (cancelaciones con la misma clave).
- **De cada línea** (clave `l-…`):
  - cuántas **lecturas** con dato de retraso hubo y cuántas con 5 minutos o más;
  - cuántos **vehículos** distintos se vieron;
  - cuántos **servicios acabaron**, y cuántos tarde;
  - el **máximo** y las **cancelaciones**.

  Así también hay puntualidad para los autobuses y metros que no tienen un servicio reconocible de un día a
  otro.

## Definiciones

- **Tarde**: 5 minutos o más de retraso, como en los indicadores del radar.
- **Llegada**: un recorrido que lleva **15 minutos sin verse** ha acabado. Puede que haya llegado o que haya
  desaparecido del tiempo real de su operador antes de llegar; para el radar es lo mismo, porque no lo puede
  distinguir. Su último retraso cuenta como el de su llegada.
- **El mismo recorrido**: si vuelve a verse antes de **2 horas**, era un hueco en los datos y sigue el mismo
  recorrido (y no se cuenta dos veces en su línea). Si vuelve después, es otro recorrido.
- **El día de un recorrido** es el de su primera lectura: un tren que sale a las 23:30 y llega pasada la
  medianoche cuenta en el día en que salió.
- **Una lectura** es la foto de cada minuto de los vehículos de las fuentes que han respondido en los últimos
  5 minutos. Los de una fuente caída no son lecturas nuevas.

## Dónde se ve

- **Ficha de un vehículo, de una cancelación o de un tren sin datos**: el resumen de su servicio («llegó con
  5 min o más de retraso 7 de los últimos 10 días en que circuló») y una tira con los últimos 14 días. Cada día
  lleva un signo, además del color: ✓ a tiempo, + tarde, × cancelado, – con paradas suprimidas, … en curso.
  Si no hay datos del servicio, sale el de su línea: qué parte de las lecturas iba tarde, hoy y los días
  anteriores, y unas barras por día.
- **API**: `/api/puntualidad/<clave>` (servicio o línea), con caché de un minuto.
- **MCP**: herramienta `puntualidad`, con la clave del campo `follow` de `buscar_trenes` o de `incidencias`.

Cada dato lleva la atribución de la fuente del retraso. Son datos modificados: el radar se queda con el último
retraso de cada recorrido y lo cuenta por día.

## Memoria y disco

Todo va en arrays tipados, con un hueco por clave y día: 4 bytes por servicio y día y 21 por línea y día. Lo
que se sabe de cada clave va en una tabla de textos compartida.

- **Topes**: 80.000 servicios y 8.000 líneas. Las claves que llevan 60 días sin verse dejan su sitio.
- **Medido con 40.000 servicios y 300 líneas** durante 60 días: unos 28 MB en memoria; la lectura de cada
  minuto tarda unos 2,5 ms; preparar la copia tarda unos 30 ms.
- **La copia** se guarda comprimida en `data/cache/puntualidad.v1.gz` cada cuarto de hora y al apagar, y se
  recupera al arrancar. Si el servidor se cae sin apagarse, se pierde como mucho ese cuarto de hora.
