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

```bash
ssh root@IP_DEL_VPS
journalctl -u radar-actualizar -n 50        # últimos despliegues
/opt/radar/deploy/actualizar.sh --forzar    # redesplegar ya
cd /opt/radar && docker compose logs -f     # logs de la aplicación
```

## Datos y secretos

- `/opt/radar/.env`: `NAP_API_KEY`. No está en git; se copia a mano con `scp`.
- `/opt/radar/data/`: cachés de GTFS e histórico JSONL. Sobrevive a los redespliegues.

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

## Montar un VPS desde cero

1. Asegurar SSH (solo clave) y `ufw` (solo el 22).
2. `ssh root@VPS 'bash -s' < deploy/preparar-vps.sh`. La primera vez se para y pide añadir la
   deploy key en GitHub; se añade y se relanza.
3. `scp .env root@VPS:/opt/radar/.env`
4. Dar de alta el dominio en Cloudflare y cambiar los DNS en DonDominio.
5. En el VPS: `cloudflared tunnel login` (abre una URL para autorizar), `cloudflared tunnel create radar`,
   `cloudflared tunnel route dns radar <dominio>`, escribir `/etc/cloudflared/config.yml` y
   `cloudflared service install`.
