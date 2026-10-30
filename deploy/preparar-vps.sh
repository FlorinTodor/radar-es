#!/usr/bin/env bash
# Prepara un VPS Ubuntu para Radar ES. Idempotente: se puede relanzar las veces que haga falta.
#   ssh root@VPS 'bash -s' < deploy/preparar-vps.sh
# No toca SSH ni el cortafuegos (ya asegurados a mano) ni da de alta el túnel de Cloudflare,
# que necesita autorizarse desde el navegador. Ver docs/despliegue.md.
set -euo pipefail

REPO=FlorinTodor/radar-es
DIR=/opt/radar
CLAVE=/root/.ssh/deploy_radar-es
# Alias propio en ~/.ssh/config: GitHub no deja reutilizar una deploy key en varios repos,
# así que cada proyecto del VPS tendrá su clave y su alias.
ALIAS=github-radar-es
# Huella publicada en https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
HUELLA_GITHUB=SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU

export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null || ! command -v cloudflared >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq docker.io docker-compose-v2 docker-buildx curl
  echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }' > /etc/docker/daemon.json
  systemctl enable docker
  systemctl restart docker
  curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg -o /usr/share/keyrings/cloudflare-public-v2.gpg
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
fi

# Clave de solo lectura para clonar el repo privado.
[[ -f $CLAVE ]] || ssh-keygen -q -t ed25519 -N '' -C "deploy radar-es@$(hostname)" -f "$CLAVE"
if ! grep -q "^Host $ALIAS\$" /root/.ssh/config 2>/dev/null; then
  printf 'Host %s\n  HostName github.com\n  User git\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$ALIAS" "$CLAVE" >> /root/.ssh/config
  chmod 600 /root/.ssh/config
fi
if ! ssh-keygen -F github.com >/dev/null; then
  linea=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)
  [[ $(ssh-keygen -lf - <<<"$linea" | awk '{print $2}') == "$HUELLA_GITHUB" ]] || { echo 'La huella de github.com no coincide' >&2; exit 1; }
  echo "$linea" >> /root/.ssh/known_hosts
fi

if [[ ! -d $DIR/.git ]]; then
  if ! git clone --quiet --branch produccion "git@$ALIAS:$REPO.git" "$DIR"; then
    echo "No se pudo clonar. Añade esta clave como deploy key (solo lectura) en GitHub y relanza:" >&2
    echo "  gh repo deploy-key add - --repo $REPO --title vps-contabo <<< '$(cat "$CLAVE.pub")'" >&2
    exit 1
  fi
fi

# data/ la escribe el usuario node (uid 1000) del contenedor.
mkdir -p "$DIR/data"
chown 1000:1000 "$DIR/data"
[[ -f $DIR/.env ]] || echo "Aviso: falta $DIR/.env (NAP_API_KEY); cópialo con scp" >&2

install -m 644 "$DIR/deploy/radar-actualizar.service" "$DIR/deploy/radar-actualizar.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now radar-actualizar.timer
systemctl start radar-actualizar.service
docker compose -f "$DIR/compose.yaml" ps
