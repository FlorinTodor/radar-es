#!/usr/bin/env bash
# Lo lanza radar-actualizar.timer en el VPS cada 2 minutos: si la rama de producción ha
# cambiado en GitHub, trae el código y reconstruye el contenedor. `--forzar` redespliega igualmente.
set -euo pipefail

main() {
  local rama=produccion
  cd "$(dirname "$0")/.."

  git fetch --quiet origin "$rama"
  local nuevo desplegado
  nuevo=$(git rev-parse FETCH_HEAD)
  desplegado=$(cat .desplegado 2>/dev/null || true)
  if [[ "$nuevo" == "$desplegado" && "${1:-}" != "--forzar" ]]; then
    return 0
  fi

  echo "Desplegando $rama: ${desplegado:0:7} → ${nuevo:0:7}"
  git checkout --quiet --force -B "$rama" FETCH_HEAD
  docker compose up -d --build --remove-orphans
  docker image prune -f >/dev/null
  # Solo se apunta si ha ido bien: si falla la construcción, se reintenta en la siguiente vuelta.
  echo "$nuevo" > .desplegado
}

# Todo dentro de main: el checkout puede reescribir este mismo fichero mientras bash lo lee.
main "$@"
exit
