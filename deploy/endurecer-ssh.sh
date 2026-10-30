#!/usr/bin/env bash
# Endurece SSH en el VPS y activa fail2ban. Idempotente: se puede relanzar.
#   ssh root@VPS 'bash -s' < deploy/endurecer-ssh.sh
#
# - Sólo claves (sin contraseñas), root sólo con clave, sin reenvío X11 y 30 s para autenticarse.
#   MaxAuthTries se deja en su valor por defecto (6): el agente SSH ofrece varias claves antes de
#   la del VPS y con menos intentos podría dejarnos fuera.
# - fail2ban: 5 fallos en 10 min → 1 h bloqueada esa IP, más tiempo si reincide (hasta 1 semana).
# Valida la configuración con `sshd -t` antes de recargar: si algo está mal no se aplica, y la
# recarga no corta las sesiones abiertas.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Va en 00-: en sshd manda el primer valor que se lee, y así gana a 50-cloud-init.conf
# (que pone PasswordAuthentication yes) y a sshd_config (X11Forwarding yes).
cat > /etc/ssh/sshd_config.d/00-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
X11Forwarding no
LoginGraceTime 30
EOF
sshd -t
systemctl reload ssh

if ! command -v fail2ban-client >/dev/null; then
  apt-get update -qq
  apt-get install -y -qq fail2ban python3-systemd
fi
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.maxtime = 1w
ignoreip = 127.0.0.1/8 ::1
EOF
systemctl enable --quiet fail2ban
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|x11forwarding|logingracetime|maxauthtries) '
