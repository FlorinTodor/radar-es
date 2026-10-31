# Despliegue

Radar ES corre en un VPS de Contabo (Ubuntu 26.04, `IP_DEL_VPS`) dentro de un contenedor
Docker, detrás de un túnel de Cloudflare. El VPS no tiene puertos web abiertos: el cortafuegos
solo deja pasar SSH (con clave), y el tráfico web entra por el túnel, que conecta desde dentro.

```
navegador ──HTTPS──▶ Cloudflare ──túnel──▶ cloudflared (VPS) ──▶ 127.0.0.1:8080 ──▶ contenedor radar
```

## Ramas

| Rama | Para qué |
|---|---|
| `produccion` | Lo que ejecuta el VPS. **Nunca se trabaja directamente en ella.** |
| `dev` | Integración. Aquí se mergean las ramas de cada mejora. |
| `feature/…` | Una por mejora, creada desde `dev`. |

Flujo: `feature/x` → merge a `dev` → probar → merge de `dev` a `produccion` → `git push`.
En menos de 2 minutos el VPS lo detecta y se actualiza solo.

## Cómo se actualiza

`radar-actualizar.timer` lanza `deploy/actualizar.sh` cada 2 minutos. Si `origin/produccion`
ha cambiado, hace checkout, reconstruye la imagen y reinicia el contenedor. El VPS clona el
repo con una deploy key de solo lectura (`/root/.ssh/deploy_radar-es`).

Un despliegue roto no tumba la web:

- **Tests**: se pasan dentro de `docker build`. Si fallan no hay imagen nueva y el contenedor
  que funciona no se toca.
- **Arranque**: tras cambiar el contenedor espera a que `/api/health` responda (hasta 3 min).
  Si se cae o no responde, vuelve a la imagen y al código anteriores (`radar-es:anterior`).
- En los dos casos el commit queda en `.fallido` y no se reintenta cada 2 minutos; se vuelve a
  intentar cuando llega otro commit o con `--forzar`.
- **Colgado**: en cada vuelta, si el contenedor está `unhealthy` (vivo pero sin responder,
  ~2 min seguidos), lo reinicia. Docker sólo reinicia solo los que terminan.

```bash
ssh root@IP_DEL_VPS
journalctl -u radar-actualizar -n 50        # últimos despliegues
/opt/radar/deploy/actualizar.sh --forzar    # redesplegar ya
cd /opt/radar && docker compose logs -f     # logs de la aplicación
```

## Datos y secretos

- `/opt/radar/.env`: `NAP_API_KEY`, titular, contacto, `GOATCOUNTER_URL`. No está en git; se copia a mano con `scp`.
- `/opt/radar/data/`: cachés de GTFS e histórico JSONL. Sobrevive a los redespliegues y, si se
  pierde, se regenera solo.
- `/etc/cloudflared/config.yml` y `<id>.json`: credenciales del túnel.

El `.env` y las credenciales del túnel deben estar copiados en un gestor de contraseñas: es lo
único que no está en GitHub. Las comprobaciones y tareas de seguridad pendientes están en
`docs/privado/seguridad.md`, fuera de git (el repositorio es público).

## Túnel de Cloudflare

El túnel `radar` es del servidor, no de este proyecto: cuando haya más proyectos en el VPS,
cada uno tendrá su puerto en `127.0.0.1` y su entrada en `/etc/cloudflared/config.yml`:

```yaml
tunnel: <id>
credentials-file: /etc/cloudflared/<id>.json
ingress:
  - hostname: xn--radarespaa-19a.es       # radarespaña.es en punycode
    service: http://localhost:8080
  - hostname: www.xn--radarespaa-19a.es
    service: http://localhost:8080
  - service: http_status:404
```

Para añadir un nombre: `cloudflared tunnel route dns radar <nombre>`, añadir la entrada
al `config.yml` y `systemctl restart cloudflared`.

Ojo con la ñ: en `route dns` hay que escribir el nombre **con ñ** (`www.radarespaña.es`). En
punycode, Cloudflare no lo reconoce como parte de la zona y crea `www.xn--radarespaa-19a.es.radarespaña.es`.
En el `config.yml`, en cambio, va en punycode, que es lo que llega en la cabecera `Host`.

Las actualizaciones de `cloudflared` las instala `unattended-upgrades`
(`/etc/apt/apt.conf.d/53-cloudflared`).

## Montar un VPS desde cero

1. Copiar la clave SSH (`ssh-copy-id`), lanzar `ssh root@VPS 'bash -s' < deploy/endurecer-ssh.sh`
   y activar `ufw` dejando sólo el 22 (`ufw limit 22/tcp && ufw enable`).
2. `ssh root@VPS 'bash -s' < deploy/preparar-vps.sh`. La primera vez se para y pide añadir la
   deploy key en GitHub; se añade y se relanza.
3. `scp .env root@VPS:/opt/radar/.env`
4. Dar de alta el dominio en Cloudflare y cambiar los DNS en DonDominio.
5. En el VPS: `cloudflared tunnel login` (abre una URL para autorizar), `cloudflared tunnel create radar`,
   `cloudflared tunnel route dns radar radarespaña.es` (y `www.radarespaña.es`), copiar
   `~/.cloudflared/<id>.json` a `/etc/cloudflared/`, escribir `/etc/cloudflared/config.yml` y
   `cloudflared service install`.

### Si se pierde el VPS y hay copia de los secretos

Más rápido que lo anterior: se reutiliza el mismo túnel, así que no hay que tocar Cloudflare ni el DNS.

1. VPS nuevo con Ubuntu: pasos 1 a 3 de arriba (SSH, `preparar-vps.sh`, `.env`).
2. Instalar `cloudflared` (lo hace `preparar-vps.sh`), copiar `config.yml` y `<id>.json` a
   `/etc/cloudflared/` y `cloudflared service install`.
3. En cuanto el túnel conecta, Cloudflare manda el tráfico al VPS nuevo. Los datos (`data/`) se
   regeneran solos en unos minutos.
