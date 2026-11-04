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
# --tunel reinicia cloudflared: la web queda unos segundos sin servicio.
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
if $CON_TUNEL; then
  if grep -q "hostname: $HOST_MONITOR" "$TUNEL_CONFIG"; then
    echo "El túnel ya lleva $HOST_MONITOR"
  else
    cp "$TUNEL_CONFIG" "$TUNEL_CONFIG.antes-monitor"
    # Antes de la regla final (http_status:404), como las demás.
    awk -v host="$HOST_MONITOR" '
      /^[[:space:]]*- service: http_status:404/ && !hecho {
        print "  - hostname: " host "  # monitorización, detrás de Cloudflare Access"
        print "    service: http://localhost:3000"
        hecho = 1
      }
      { print }' "$TUNEL_CONFIG.antes-monitor" > "$TUNEL_CONFIG"
    if ! cloudflared tunnel ingress validate --config "$TUNEL_CONFIG" >/dev/null 2>&1; then
      cp "$TUNEL_CONFIG.antes-monitor" "$TUNEL_CONFIG"
      echo "La configuración del túnel no valida: se deja como estaba" >&2
      exit 1
    fi
    systemctl restart cloudflared
    echo "Túnel: añadido $HOST_MONITOR (copia de la configuración anterior en $TUNEL_CONFIG.antes-monitor)"
  fi
  # El DNS (con ñ: en punycode, Cloudflare no lo reconoce como parte de la zona).
  cloudflared tunnel route dns radar monitor.radarespaña.es || echo "Aviso: el DNS de monitor no se ha podido crear (¿ya existe?)"
fi
