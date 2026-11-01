#!/usr/bin/env bash
# Lo lanzan dos temporizadores del VPS cada 30 s, uno por entorno:
#
#   /opt/radar-pruebas/deploy/actualizar.sh --pruebas   radar-pruebas.timer, rama dev, puerto 8081
#   /opt/radar/deploy/actualizar.sh                     radar-actualizar.timer, rama produccion
#
# Pruebas: si dev ha cambiado, construye la imagen (con los tests dentro), la arranca y pasa
# deploy/comprobar.mjs: todas las fuentes cargadas, el directo, las páginas, la memoria y ningún
# reinicio. Si todo va bien, etiqueta la imagen como verificada para ese árbol de ficheros. Cuando
# producción ya funciona con esa misma imagen, para el contenedor de pruebas hasta el próximo cambio.
#
# Producción: si produccion ha cambiado, sólo la despliega si ese mismo código (el mismo árbol,
# que es lo que deja un merge de dev sin más cambios) está verificado en pruebas, y usa esa misma
# imagen sin recompilar: sale exactamente lo que se ha probado. Si no lo está, no toca nada y lo
# dice en el registro; se despliega sola en cuanto pruebas la verifique.
#
# En los dos, sin cortes: la web va en dos contenedores que se relevan (radar y radar-b) detrás de
# nginx (compose.yaml). La versión nueva arranca en el que está parado; cuando responde y ha cargado
# los datos, nginx pasa a él sin cortar ninguna conexión y se para el otro. Si no arranca, se para
# y sigue funcionando el de antes: se vuelve al código anterior y se apunta el commit en .fallido
# para no reintentarlo cada 2 minutos (se reintenta al llegar otro commit). Y si el contenedor en
# servicio está "unhealthy" (colgado: el proceso vive pero no responde), lo reinicia: Docker sólo
# reinicia solo los contenedores que terminan.
#
# `--forzar` redespliega aunque el commit ya esté desplegado o marcado como fallido. En producción,
# además, sin pasar por pruebas si hace falta (construye aquí la imagen, con los tests): sólo para
# urgencias.
#
# Cada 30 s sólo pregunta a GitHub si la rama ha cambiado, que casi no gasta CPU. Vigilar el
# contenedor, la limpieza y parar pruebas siguen haciéndose cada 2 minutos.
#
# Si hay token (.github-token, de solo «Commit statuses»), cada paso marca el commit en GitHub con
# el check «Pruebas VPS» o «Producción»: es lo que espera el pipeline de .github/workflows/pipeline.yml.
# El registro queda en: journalctl -u radar-actualizar (producción) o -u radar-pruebas
set -euo pipefail

readonly REPO=FlorinTodor/radar-es
readonly DIR_PRUEBAS=/opt/radar-pruebas
readonly IMAGEN_PRODUCCION=radar-es
readonly VERIFICADA=radar-es-verificado # radar-es-verificado:<árbol> = imagen que ha pasado pruebas
readonly ESPERA_MAX=180                 # segundos hasta dar por fallido un arranque
readonly ESPERA_DATOS=600               # segundos, como mucho, esperando a que cargue los datos
readonly MEMORIA_MAX=$((900 * 1024 * 1024)) # pico al cargar todo; el límite del contenedor es 1 GB
readonly ACTIVO=data/proxy/activo.conf # cuál de los dos atiende: lo lee nginx

# docker compose con el contenedor de relevo (radar-b, en el perfil «relevo») incluido.
dc() { docker compose --profile relevo "$@"; }

# El servicio que atiende las visitas y el otro. Sin activo.conf (la primera vez), radar.
activo() { if grep -q 'radar-b;' "$ACTIVO" 2>/dev/null; then echo radar-b; else echo radar; fi; }
otro() { if [[ $(activo) == radar ]]; then echo radar-b; else echo radar; fi; }

contenedor() { dc ps -q "${1:-$(activo)}" 2>/dev/null || true; }

salud() {
  local id
  id=$(contenedor "${1:-}")
  [[ -n $id ]] || { echo ausente; return; }
  # running → estado del healthcheck (starting, healthy, unhealthy); si no, restarting, exited…
  docker inspect -f '{{if ne .State.Status "running"}}{{.State.Status}}{{else if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$id" 2>/dev/null || echo ausente
}

esperar_sano() {
  local fin=$((SECONDS + ESPERA_MAX)) estado
  while ((SECONDS < fin)); do
    estado=$(salud "${1:-}")
    case $estado in
      healthy) return 0 ;;
      unhealthy | restarting | exited | dead) return 1 ;; # se ha caído al arrancar
    esac
    sleep 3
  done
  return 1
}

# Fuentes que todavía no han terminado su primera lectura en el servicio $1, o -1 si no responde.
# Se pregunta desde dentro del contenedor (node está en la imagen; en el VPS no hace falta).
fuentes_pendientes() {
  dc exec -T "$1" node -e "fetch('http://127.0.0.1:8080/api/health').then((r) => r.json())
    .then((h) => console.log((Array.isArray(h) ? h : h.sources).filter((s) => s.enabled && s.ok === null).length))
    .catch(() => console.log(-1))" 2>/dev/null || echo -1
}

# Antes de pasarle las visitas, que haya leído cada fuente al menos una vez: si no, quien entrara
# vería el mapa a medio llenar. Si alguna tarda demasiado, se sigue igualmente.
esperar_datos() {
  local fin=$((SECONDS + ESPERA_DATOS)) pendientes=-1
  while ((SECONDS < fin)); do
    pendientes=$(fuentes_pendientes "$1")
    ((pendientes == 0)) && return 0
    sleep 5
  done
  echo "Aviso: $1 tiene $pendientes fuentes sin su primera lectura tras $ESPERA_DATOS s; se cambia igualmente"
}

# nginx en marcha y con la configuración de este commit (comprobada antes de recargarla).
proxy_al_dia() {
  mkdir -p "$(dirname "$ACTIVO")"
  dc up -d --no-deps proxy
  dc exec -T proxy nginx -t -q && dc exec -T proxy nginx -s reload
}

# nginx pasa a $1: las peticiones en curso terminan con el anterior. Cada paso se comprueba (dentro
# de un `if`, bash no para en los errores) y, al final, se pregunta a nginx quién atiende: sólo si es
# $1 se puede parar el otro. La cabecera X-Radar-Activo sólo sale si se pide (X-Radar-Relevo: 1).
cambiar_a() {
  local destino=$1 atiende=
  printf 'set $radar_activo %s;\n' "$destino" > "$ACTIVO.nuevo" || return 1
  mv -f "$ACTIVO.nuevo" "$ACTIVO" || return 1
  dc exec -T proxy nginx -t -q || return 1
  dc exec -T proxy nginx -s reload || return 1
  for _ in {1..15}; do
    atiende=$(curl -fsS -o /dev/null -D - --max-time 5 -H 'X-Radar-Relevo: 1' \
      "http://$(dc port proxy 8080)/api/health" 2>/dev/null | tr -d '\r' | sed -n 's/^x-radar-activo: //Ip')
    [[ $atiende == "$destino" ]] && return 0
    sleep 1
  done
  echo "nginx no atiende con $destino (atiende: ${atiende:-nadie})"
  return 1
}

vigilar() {
  if [[ $(salud) == unhealthy ]]; then
    echo "El contenedor en servicio ($(activo)) no responde (unhealthy): reiniciándolo"
    dc restart "$(activo)"
  fi
}

# estado <probando|verificado|desplegado|fallido> <commit> <texto>
# En pruebas queda en .estado, que lee producción para explicar por qué espera.
estado() {
  local fase=$1 commit=$2 texto=$3
  if [[ $ENTORNO == pruebas ]]; then echo "$fase ${commit:0:7}: $texto" | tee .estado; fi
  avisar_github "$fase" "$commit" "$texto"
}

# Un fallo al avisar a GitHub no para el despliegue: sólo se apunta en el registro.
avisar_github() {
  local token estado contexto
  token=$(cat .github-token 2>/dev/null) || return 0
  case $1 in
    probando) estado=pending ;;
    verificado | desplegado) estado=success ;;
    *) estado=failure ;;
  esac
  contexto=$([[ $ENTORNO == pruebas ]] && echo 'Pruebas VPS' || echo 'Producción')
  curl -fsS -o /dev/null --max-time 15 -X POST "https://api.github.com/repos/$REPO/statuses/$2" \
    -H "Authorization: Bearer $token" -H 'Accept: application/vnd.github+json' \
    -d "{\"state\": \"$estado\", \"context\": \"$contexto\", \"description\": \"${3:0:140}\"}" ||
    echo "Aviso: no se ha podido marcar ${2:0:7} en GitHub"
}

# La salida de la construcción va a un fichero: si falla, al registro van los tests que fallan
# y el final de la construcción; si va bien, no ensucia el registro.
construir() {
  local registro
  registro=$(mktemp)
  if docker compose --progress plain build >"$registro" 2>&1; then
    rm -f "$registro"
    return 0
  fi
  grep -E -A 20 ' not ok ' "$registro" | grep -vE 'duration_ms|type: .test' | head -n 80 || true
  tail -n 15 "$registro"
  rm -f "$registro"
  return 1
}

# Con el contenedor de pruebas ya sano: deploy/comprobar.mjs con el node de la misma imagen y la
# red del host (para ver también producción), y después la memoria y los reinicios.
comprobar() {
  local imagen=$1 id pico reinicios
  docker run --rm -i --network host --read-only --cap-drop ALL --security-opt no-new-privileges \
    -e PRUEBAS="http://$(dc port "$(activo)" 8080)" -e PRODUCCION=http://127.0.0.1:8080 \
    "$imagen" node --input-type=module - <deploy/comprobar.mjs || return 1
  id=$(contenedor)
  pico=$(docker exec "$id" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
  reinicios=$(docker inspect -f '{{.RestartCount}}' "$id")
  echo "memoria: pico de $((pico / 1024 / 1024)) MB; reinicios: $reinicios"
  if ((pico > MEMORIA_MAX)); then echo "  ✗ el pico de memoria pasa de $((MEMORIA_MAX / 1024 / 1024)) MB"; return 1; fi
  if ((reinicios > 0)); then echo "  ✗ el contenedor se ha reiniciado"; return 1; fi
}

# Se guardan las 5 últimas verificadas: producción puede tardar en recibir el merge.
limpiar_verificadas() {
  docker image ls "$VERIFICADA" --format '{{.Tag}}' | tail -n +6 | while read -r etiqueta; do
    docker image rm "$VERIFICADA:$etiqueta" >/dev/null || true
  done
}

desplegar() {
  local forzar=$1 imagen nuevo arbol desplegado anterior viejo relevo
  git fetch --quiet origin "$RAMA"
  nuevo=$(git rev-parse FETCH_HEAD)
  arbol=$(git rev-parse "$nuevo^{tree}")
  desplegado=$(cat .desplegado 2>/dev/null || true)
  if [[ $forzar != 1 ]]; then
    [[ $nuevo == "$desplegado" ]] && return 0
    [[ $nuevo == "$(cat .fallido 2>/dev/null || true)" ]] && return 0
  fi

  if [[ $ENTORNO == produccion && $forzar != 1 ]] && ! docker image inspect "$VERIFICADA:$arbol" >/dev/null 2>&1; then
    # Se avisa una vez por commit, no cada 2 minutos.
    if [[ $(cat .esperando 2>/dev/null || true) != "$nuevo" ]]; then
      echo "${nuevo:0:7} no está verificado en pruebas: no se despliega todavía. Pruebas: $(cat "$DIR_PRUEBAS/.estado" 2>/dev/null || echo 'sin estado')"
      avisar_github probando "$nuevo" 'esperando a que pruebas verifique este código'
      echo "$nuevo" > .esperando
    fi
    return 0
  fi
  rm -f .esperando

  estado probando "$nuevo" "$([[ $ENTORNO == pruebas ]] && echo construyendo || echo desplegando)"
  echo "Desplegando $RAMA: ${desplegado:0:7} → ${nuevo:0:7}"
  anterior=$(git rev-parse HEAD)
  imagen=$(docker compose config --images radar) # la de la web (la de nginx va fijada en compose.yaml)
  # Se guarda la imagen que está funcionando para poder volver a ella.
  if docker image inspect "$imagen" >/dev/null 2>&1; then docker image tag "$imagen" "$imagen:anterior"; fi
  git checkout --quiet --force -B "$RAMA" FETCH_HEAD

  if [[ $ENTORNO == produccion ]] && docker image inspect "$VERIFICADA:$arbol" >/dev/null 2>&1; then
    echo "Con la imagen verificada en pruebas, sin recompilar"
    docker image tag "$VERIFICADA:$arbol" "$imagen"
  elif ! construir; then
    estado fallido "$nuevo" 'no se puede construir o no pasa los tests'
    echo "ERROR: ${nuevo:0:7} no se puede construir o no pasa los tests. Sigue funcionando ${desplegado:0:7}."
    git checkout --quiet --force -B "$RAMA" "$anterior"
    echo "$nuevo" > .fallido
    return 1
  fi

  # Relevo: la versión nueva arranca en el contenedor parado mientras el otro sigue atendiendo.
  viejo=$(activo)
  relevo=$(otro)
  if [[ -z $(contenedor "$viejo") || $(salud "$viejo") == exited ]]; then relevo=$viejo; fi # no hay nada en marcha
  if proxy_al_dia && dc up -d --no-deps --force-recreate "$relevo" && esperar_sano "$relevo"; then
    esperar_datos "$relevo"
  else
    estado fallido "$nuevo" "no arranca: sigue ${desplegado:0:7}"
    echo "ERROR: ${nuevo:0:7} no arranca bien ($(salud "$relevo")). Últimas líneas:"
    dc logs --no-color --tail 30 "$relevo" || true
    [[ $relevo != "$viejo" ]] && dc stop "$relevo"
    echo "Sigue funcionando ${desplegado:0:7}"
    git checkout --quiet --force -B "$RAMA" "$anterior"
    if docker image inspect "$imagen:anterior" >/dev/null 2>&1; then docker image tag "$imagen:anterior" "$imagen"; fi
    echo "$nuevo" > .fallido
    return 1
  fi
  if ! cambiar_a "$relevo"; then
    estado fallido "$nuevo" "nginx no pasa al nuevo: sigue ${desplegado:0:7}"
    echo "ERROR: nginx no responde con $relevo; se queda $viejo"
    cambiar_a "$viejo" || true
    [[ $relevo != "$viejo" ]] && dc stop "$relevo"
    git checkout --quiet --force -B "$RAMA" "$anterior"
    if docker image inspect "$imagen:anterior" >/dev/null 2>&1; then docker image tag "$imagen:anterior" "$imagen"; fi
    echo "$nuevo" > .fallido
    return 1
  fi
  # Se para el que sobra (normalmente el de antes; también si quedaba otro en marcha de antes).
  dc stop "$([[ $relevo == radar ]] && echo radar-b || echo radar)"
  echo "$nuevo" > .desplegado
  rm -f .fallido
  echo "Desplegado ${nuevo:0:7} en $relevo, sin corte: responde y ha cargado los datos"


  if [[ $ENTORNO == pruebas ]]; then
    # El contenedor se queda funcionando aunque falle, para poder mirar qué le pasa.
    estado probando "$nuevo" 'cargando las fuentes y comprobando'
    if ! comprobar "$imagen"; then
      estado fallido "$nuevo" 'no pasa la comprobación (journalctl -u radar-pruebas)'
      echo "$nuevo" > .fallido
      return 1
    fi
    docker image tag "$imagen" "$VERIFICADA:$arbol"
    limpiar_verificadas
    estado verificado "$nuevo" 'listo para subir a producción'
  else
    estado desplegado "$nuevo" 'funcionando en producción'
  fi
  docker image prune -f >/dev/null
}

# Una vez a la semana, desde producción (Docker y apt son del VPS, no de cada entorno): la caché
# de compilación de Docker de más de 7 días y los paquetes que apt guarda tras instalarlos. Las
# imágenes que funcionan, la de vuelta atrás y data/ no se tocan. Si falla, no para el despliegue.
limpiar_semanal() {
  [[ -n $(find .limpieza -mtime -7 2>/dev/null) ]] && return 0
  touch .limpieza
  if docker builder prune -f --filter until=168h >/dev/null && apt-get clean; then
    echo "Limpieza semanal hecha: quedan $(df -h --output=avail / | tail -n1 | tr -d ' ') libres"
  else
    echo "Aviso: la limpieza semanal ha fallado; se reintenta dentro de una semana"
  fi
}

# Producción ya funciona con la imagen verificada de lo que hay en pruebas: no hay nada que ver
# y se deja de pedir los datos dos veces. Arranca otra vez con el próximo cambio en dev.
parar_pruebas_si_sobra() {
  local desplegado probada
  desplegado=$(cat .desplegado 2>/dev/null) || return 0
  [[ $(salud) == healthy ]] || return 0
  probada=$(docker image inspect -f '{{.Id}}' "$VERIFICADA:$(git rev-parse "$desplegado^{tree}")" 2>/dev/null) || return 0
  [[ $probada == "$(docker image inspect -f '{{.Id}}' "$IMAGEN_PRODUCCION" 2>/dev/null)" ]] || return 0
  echo "Producción ya funciona con ${desplegado:0:7}: se para pruebas hasta el próximo cambio en dev"
  dc stop radar radar-b
}

# Sin nada nuevo en GitHub y con la última vuelta completa hace menos de 2 minutos, no hay que hacer
# nada. Cada vuelta completa gasta 2-3 s de CPU (docker compose, git fetch); esto, casi nada.
sin_novedades() {
  local remoto
  [[ -n $(find .vuelta -mmin -2 2>/dev/null) ]] || return 1
  remoto=$(git ls-remote --heads origin "$RAMA" 2>/dev/null | cut -f1) || true
  [[ -z $remoto ]] && return 0 # GitHub no responde: se mira en la próxima vuelta completa
  [[ $remoto == "$(cat .desplegado 2>/dev/null)" || $remoto == "$(cat .fallido 2>/dev/null)" ||
    $remoto == "$(cat .esperando 2>/dev/null)" ]]
}

main() {
  local forzar=0 arg
  ENTORNO=produccion
  for arg in "$@"; do
    case $arg in
      --pruebas) ENTORNO=pruebas ;;
      --forzar) forzar=1 ;;
      *) echo "Uso: $0 [--pruebas] [--forzar]" >&2; return 2 ;;
    esac
  done
  RAMA=$([[ $ENTORNO == pruebas ]] && echo dev || echo produccion)
  cd "$(dirname "$0")/.."
  if [[ $forzar != 1 ]] && sin_novedades; then return 0; fi
  touch .vuelta
  vigilar
  if [[ $ENTORNO == produccion ]]; then limpiar_semanal; fi
  desplegar "$forzar"
  if [[ $ENTORNO == pruebas ]]; then parar_pruebas_si_sobra; fi
}

# En la misma línea que la llamada: el checkout puede reescribir este fichero mientras bash lo
# lee, y así bash ya no lee nada más de él después de main.
main "$@"; exit $?
