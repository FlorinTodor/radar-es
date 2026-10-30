#!/usr/bin/env bash
# Lo lanza radar-actualizar.timer en el VPS cada 2 minutos. Hace dos cosas:
#
# 1. Vigilar: si el contenedor está "unhealthy" (colgado: el proceso vive pero no responde), lo
#    reinicia. Docker sólo reinicia solo los contenedores que terminan, no los colgados.
# 2. Desplegar: si la rama produccion ha cambiado en GitHub, construye la imagen nueva (con los
#    tests dentro: si fallan no hay imagen y no se toca nada), cambia el contenedor y espera a que
#    responda. Si no llega a estar sano, vuelve a la imagen y al código anteriores y apunta el
#    commit en .fallido para no reintentarlo cada 2 minutos (se reintenta al llegar otro commit).
#
# `--forzar` redespliega aunque el commit ya esté desplegado o marcado como fallido.
# El registro queda en: journalctl -u radar-actualizar
set -euo pipefail

readonly RAMA=produccion
readonly ESPERA_MAX=180 # segundos hasta dar por fallido un arranque

contenedor() { docker compose ps -q radar 2>/dev/null || true; }

salud() {
  local id
  id=$(contenedor)
  [[ -n $id ]] || { echo ausente; return; }
  # running → estado del healthcheck (starting, healthy, unhealthy); si no, restarting, exited…
  docker inspect -f '{{if ne .State.Status "running"}}{{.State.Status}}{{else if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$id" 2>/dev/null || echo ausente
}

esperar_sano() {
  local fin=$((SECONDS + ESPERA_MAX)) estado
  while ((SECONDS < fin)); do
    estado=$(salud)
    case $estado in
      healthy) return 0 ;;
      unhealthy | restarting | exited | dead) return 1 ;; # se ha caído al arrancar
    esac
    sleep 3
  done
  return 1
}

vigilar() {
  if [[ $(salud) == unhealthy ]]; then
    echo "El contenedor no responde (unhealthy): reiniciándolo"
    docker compose restart radar
  fi
}

desplegar() {
  local forzar=$1 imagen nuevo desplegado anterior
  git fetch --quiet origin "$RAMA"
  nuevo=$(git rev-parse FETCH_HEAD)
  desplegado=$(cat .desplegado 2>/dev/null || true)
  if [[ $forzar != 1 ]]; then
    [[ $nuevo == "$desplegado" ]] && return 0
    [[ $nuevo == "$(cat .fallido 2>/dev/null || true)" ]] && return 0
  fi

  echo "Desplegando $RAMA: ${desplegado:0:7} → ${nuevo:0:7}"
  anterior=$(git rev-parse HEAD)
  imagen=$(docker compose config --images | head -n1)
  # Se guarda la imagen que está funcionando para poder volver a ella.
  if docker image inspect "$imagen" >/dev/null 2>&1; then docker image tag "$imagen" "$imagen:anterior"; fi
  git checkout --quiet --force -B "$RAMA" FETCH_HEAD

  if ! docker compose build --quiet; then
    echo "ERROR: ${nuevo:0:7} no se puede construir o no pasa los tests. Sigue funcionando ${desplegado:0:7}."
    git checkout --quiet --force -B "$RAMA" "$anterior"
    echo "$nuevo" > .fallido
    return 1
  fi

  if docker compose up -d --remove-orphans && esperar_sano; then
    echo "$nuevo" > .desplegado
    rm -f .fallido
    docker image prune -f >/dev/null
    echo "Desplegado ${nuevo:0:7}: el contenedor responde"
    return 0
  fi

  echo "ERROR: ${nuevo:0:7} no arranca bien ($(salud)). Últimas líneas:"
  docker compose logs --no-color --tail 30 radar || true
  echo "Volviendo a ${desplegado:0:7}"
  git checkout --quiet --force -B "$RAMA" "$anterior"
  if docker image inspect "$imagen:anterior" >/dev/null 2>&1; then docker image tag "$imagen:anterior" "$imagen"; fi
  docker compose up -d --remove-orphans
  echo "$nuevo" > .fallido
  if esperar_sano; then echo "Vuelta atrás hecha: funciona ${desplegado:0:7}"; else echo "ERROR: la versión anterior tampoco arranca"; fi
  return 1
}

main() {
  cd "$(dirname "$0")/.."
  vigilar
  desplegar "$([[ ${1:-} == --forzar ]] && echo 1 || echo 0)"
}

# En la misma línea que la llamada: el checkout puede reescribir este fichero mientras bash lo
# lee, y así bash ya no lee nada más de él después de main.
main "$@"; exit $?
