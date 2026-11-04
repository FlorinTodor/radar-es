#!/usr/bin/env bash
# Instala o actualiza la monitorización (deploy/monitor/) en /opt/radar-monitor y la arranca.
# Se ejecuta en el VPS, como root, desde una copia del repositorio (la de producción):
#
#   bash /opt/radar/deploy/preparar-monitor.sh            # instala o actualiza la configuración
#   bash /opt/radar/deploy/preparar-monitor.sh --tunel    # además, añade monitor.radarespaña.es al túnel
#
# Antes, una sola vez:
# - /opt/radar-monitor/.env con TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CF_ACCESS_TEAM y CF_ACCESS_AUD
#   (ver deploy/monitor/.env.ejemplo). La contraseña de administrador de Grafana la crea este script.
# - La aplicación de Cloudflare Access para monitor.radarespaña.es, ANTES de que exista su DNS (--tunel
#   lo crea): así nunca está abierto.
#
# --tunel cambia el túnel sin cortar la web (ver el paso 5).
set -euo pipefail

ORIGEN=$(cd "$(dirname "${BASH_SOURCE[0]}")/monitor" && pwd)
DESTINO=/opt/radar-monitor
HOST_MONITOR=monitor.xn--radarespaa-19a.es   # en punycode, como llega en la cabecera Host
TUNEL_CONFIG=/etc/cloudflared/config.yml

[[ $(id -u) == 0 ]] || { echo "Hay que ejecutarlo como root" >&2; exit 1; }
CON_TUNEL=false
[[ ${1:-} == --tunel ]] && CON_TUNEL=true

# 1. El .env, sin enseñarlo nunca: sólo se comprueba que tiene lo necesario.
install -d -m 700 "$DESTINO"
ENV="$DESTINO/.env"
[[ -f $ENV ]] || { echo "Falta $ENV (ver deploy/monitor/.env.ejemplo)" >&2; exit 1; }
chmod 600 "$ENV"
for var in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID CF_ACCESS_TEAM CF_ACCESS_AUD; do
  grep -q "^$var=." "$ENV" || { echo "Falta $var en $ENV" >&2; exit 1; }
done
# Alloy lee el diario del sistema con el grupo systemd-journal del VPS (su número cambia de un sistema a otro).
if ! grep -q '^JOURNAL_GID=.' "$ENV"; then
  printf 'JOURNAL_GID=%s\n' "$(getent group systemd-journal | cut -d: -f3)" >> "$ENV"
fi
# El proxy de Docker lee su socket con el grupo docker del VPS.
if ! grep -q '^DOCKER_GID=.' "$ENV"; then
  printf 'DOCKER_GID=%s\n' "$(getent group docker | cut -d: -f3)" >> "$ENV"
fi
if ! grep -q '^GRAFANA_ADMIN_PASSWORD=.' "$ENV"; then
  # Nadie la usa (Grafana no tiene formulario de acceso), pero así no queda la de serie.
  printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)" >> "$ENV"
fi

# 2. La configuración: la del repositorio sustituye a la que hubiera (el .env y los datos se quedan).
antes=$(cd "$DESTINO" && find . -path ./.env -prune -o -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum)
rsync -a --delete --exclude .env "$ORIGEN/" "$DESTINO/"
despues=$(cd "$DESTINO" && find . -path ./.env -prune -o -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum)

# 3. Arrancar (o aplicar los cambios del compose). Los ficheros montados no recrean los contenedores:
# si la configuración ha cambiado, se reinician para que la lean.
cd "$DESTINO"
docker compose up -d --remove-orphans
if [[ $antes != "$despues" ]]; then
  echo "Configuración nueva: reiniciando los servicios"
  docker compose restart grafana prometheus loki alloy
fi

# 4. Esperar a que respondan (como mucho 2 min).
listo() { curl -sf -o /dev/null --max-time 5 "$1"; }
for i in $(seq 1 24); do
  if listo http://127.0.0.1:3000/api/health && listo http://127.0.0.1:9090/-/ready \
     && listo http://127.0.0.1:3100/ready && listo http://127.0.0.1:12345/-/ready; then
    echo "Monitorización en marcha: Grafana, Prometheus, Loki y Alloy responden"
    break
  fi
  [[ $i == 24 ]] && { echo "No responden todos tras 2 min: docker compose -f $DESTINO/compose.yaml logs" >&2; exit 1; }
  sleep 5
done

# 5. El túnel: monitor.radarespaña.es → Grafana. Sólo con --tunel y si aún no está.
# Sin corte: cloudflared no relee su configuración en marcha, así que primero se arranca una réplica
# temporal del mismo túnel, ya con la configuración nueva; cuando tiene sus conexiones, se reinicia el
# de siempre (que acaba lo que estaba atendiendo antes de cerrarse) y, cuando ha vuelto, se para la
# réplica. Cloudflare reparte las visitas entre las dos mientras tanto.
listas() { curl -sf --max-time 3 "http://127.0.0.1:$1/ready" | grep -o '"readyConnections":[0-9]*' | cut -d: -f2; }
esperar_conexiones() {
  local puerto=$1 n
  for _ in $(seq 1 60); do
    n=$(listas "$puerto" || true)
    [[ ${n:-0} -ge 2 ]] && return 0
    sleep 1
  done
  return 1
}
if $CON_TUNEL; then
  if grep -q "hostname: $HOST_MONITOR" "$TUNEL_CONFIG"; then
    echo "El túnel ya lleva $HOST_MONITOR"
  else
    NUEVA="$TUNEL_CONFIG.nueva"
    # Antes de la regla final (http_status:404), como las demás.
    awk -v host="$HOST_MONITOR" '
      /^[[:space:]]*- service: http_status:404/ && !hecho {
        print "  - hostname: " host "  # monitorización, detrás de Cloudflare Access"
        print "    service: http://localhost:3000"
        hecho = 1
      }
      { print }' "$TUNEL_CONFIG" > "$NUEVA"
    if ! cloudflared tunnel --config "$NUEVA" ingress validate >/dev/null 2>&1; then
      rm -f "$NUEVA"
      echo "La configuración nueva del túnel no valida: no se toca nada" >&2
      exit 1
    fi
    systemd-run --unit=cloudflared-relevo --collect --quiet \
      /usr/bin/cloudflared --no-autoupdate --config "$NUEVA" --metrics 127.0.0.1:20242 tunnel run
    if ! esperar_conexiones 20242; then
      systemctl stop cloudflared-relevo || true
      rm -f "$NUEVA"
      echo "La réplica temporal no ha conectado en 60 s: no se toca el túnel" >&2
      exit 1
    fi
    echo "Réplica temporal conectada ($(listas 20242) conexiones): se reinicia cloudflared"
    cp "$TUNEL_CONFIG" "$TUNEL_CONFIG.antes-monitor"
    mv "$NUEVA" "$TUNEL_CONFIG"
    systemctl restart cloudflared
    if ! esperar_conexiones 20241; then
      # La réplica sigue atendiendo (con todo lo de antes y monitor): la web no se corta.
      echo "cloudflared no ha vuelto a conectar en 60 s. La réplica temporal (cloudflared-relevo) sigue" >&2
      echo "atendiendo; mira journalctl -u cloudflared y, cuando vuelva, systemctl stop cloudflared-relevo" >&2
      exit 1
    fi
    systemctl stop cloudflared-relevo
    echo "Túnel: añadido $HOST_MONITOR sin corte ($(listas 20241) conexiones; la configuración anterior, en $TUNEL_CONFIG.antes-monitor)"
  fi
  # El DNS (con ñ: en punycode, Cloudflare no lo reconoce como parte de la zona y lo crea mal).
  cloudflared tunnel route dns radar monitor.radarespaña.es || echo "Aviso: el DNS de monitor no se ha podido crear (¿ya existe?)"
fi
