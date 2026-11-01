#!/usr/bin/env bash
# Monta el entorno de pruebas en un VPS que ya tiene producción (deploy/preparar-vps.sh).
# Idempotente: se puede relanzar las veces que haga falta.
#   ssh root@VPS 'bash -s' < deploy/preparar-pruebas.sh
# Clona la rama dev en /opt/radar-pruebas, le da su .env (el de producción sin estadísticas de
# visitas, con otra imagen y el puerto 8081), añade pruebas.<dominio> al túnel y activa
# radar-pruebas.timer. El nombre en el DNS y la protección con Cloudflare Access se dan de alta a
# mano y en ese orden: ver docs/despliegue.md.
set -euo pipefail

REPO=FlorinTodor/radar-es
ALIAS=github-radar-es # el de preparar-vps.sh: misma deploy key, de solo lectura
PRODUCCION=/opt/radar
DIR=/opt/radar-pruebas
PUERTO=8081
NOMBRE=pruebas.xn--radarespaa-19a.es # pruebas.radarespaña.es en punycode, como llega en Host
TUNEL=/etc/cloudflared/config.yml

[[ -f $PRODUCCION/.env ]] || { echo "Falta $PRODUCCION/.env: monta antes producción" >&2; exit 1; }

[[ -d $DIR/.git ]] || git clone --quiet --branch dev "git@$ALIAS:$REPO.git" "$DIR"
# data/ la escribe el usuario node (uid 1000) del contenedor.
mkdir -p "$DIR/data"
chown 1000:1000 "$DIR/data"

# Las visitas a pruebas no cuentan en GoatCounter. Si cambia el .env de producción, se borra
# éste y se relanza el script.
if [[ ! -f $DIR/.env ]]; then
  (
    umask 077
    grep -v '^GOATCOUNTER_URL=' "$PRODUCCION/.env" > "$DIR/.env"
    printf 'RADAR_IMAGEN=radar-es-pruebas\nRADAR_PUERTO=%s\n' "$PUERTO" >> "$DIR/.env"
  )
fi

# La entrada va justo antes de la regla final (http_status:404). Se valida antes de cambiarla:
# un config.yml roto dejaría sin servicio también a producción.
if ! grep -q "hostname: $NOMBRE\$" "$TUNEL"; then
  awk -v nombre="$NOMBRE" -v puerto="$PUERTO" '
    /^[[:space:]]*- service: http_status:404/ && !hecho { print "  - hostname: " nombre; print "    service: http://localhost:" puerto; hecho = 1 }
    { print }' "$TUNEL" > "$TUNEL.nuevo"
  if ! grep -q "hostname: $NOMBRE\$" "$TUNEL.nuevo" || ! cloudflared tunnel --config "$TUNEL.nuevo" ingress validate; then
    rm -f "$TUNEL.nuevo"
    echo "No he podido añadir $NOMBRE a $TUNEL: añádelo a mano antes de la regla http_status:404" >&2
    exit 1
  fi
  cp "$TUNEL" "$TUNEL.antes-de-pruebas"
  mv "$TUNEL.nuevo" "$TUNEL"
  # Corta el túnel unos segundos: producción incluida.
  systemctl restart cloudflared
fi

install -m 644 "$DIR/deploy/radar-pruebas.service" "$DIR/deploy/radar-pruebas.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now radar-pruebas.timer
# Sin esperar: cargar todas las fuentes y comprobarlas lleva hasta media hora.
systemctl start --no-block radar-pruebas.service
echo "Entorno de pruebas en marcha. Para seguirlo: journalctl -u radar-pruebas -f"
