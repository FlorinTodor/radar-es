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
| `dev` | Integración. Aquí se mergean las ramas de cada mejora, y es lo que corre en pruebas. |
| `feature/…` | Una por mejora, creada desde `dev`. |

## Del commit a producción

```
push a dev ──▶ 1. tests en GitHub Actions
           └─▶ 2. pruebas en el VPS (rama dev, 127.0.0.1:8081, pruebas.radarespaña.es)
                  imagen con los tests dentro → arranque → deploy/comprobar.mjs
                  → imagen verificada para ese árbol de ficheros
               3. ⏸ revisar pruebas.radarespaña.es y, si está bien, merge de dev a produccion
               4. producción usa la imagen verificada, sin recompilar
```

Dos temporizadores lanzan `deploy/actualizar.sh` cada 2 minutos, uno por entorno. El VPS clona
el repo con una deploy key de solo lectura (`/root/.ssh/deploy_radar-es`).

**Pruebas** (`/opt/radar-pruebas`, `radar-pruebas.timer`): si `dev` ha cambiado, construye la
imagen, la arranca y pasa `deploy/comprobar.mjs`, que compara con producción en el mismo
momento:

- todas las fuentes cargadas (hasta 25 min); una que falla también en producción es un fallo de
  la fuente y no para la versión;
- `/api/live` con vehículos (al menos la mitad que en producción) y el resto del directo;
- todas las páginas del sitemap y los ficheros del mapa;
- pico de memoria por debajo de 900 MB (el límite es 1 GB) y ningún reinicio.

Si pasa, la imagen queda como `radar-es-verificado:<árbol>`. Si no, el contenedor se queda
funcionando con el fallo para poder mirarlo. El resultado está en `/opt/radar-pruebas/.estado`.
Cuando producción ya funciona con esa misma imagen, pruebas se para solo (deja de pedir los datos
dos veces) y vuelve a arrancar con el próximo cambio en `dev`.

**Producción** (`/opt/radar`, `radar-actualizar.timer`): si `produccion` ha cambiado, sólo
despliega si ese mismo árbol de ficheros está verificado en pruebas. Un merge de `dev` sin más
cambios deja exactamente el árbol de `dev`, así que lo que sale es la imagen que se ha probado.
Si no está verificado, no toca nada, lo dice una vez en el registro y se despliega solo en cuanto
pruebas lo verifique.

Un despliegue roto no tumba la web (en los dos entornos):

- **Tests**: se pasan dentro de `docker build`. Si fallan no hay imagen nueva y el contenedor
  que funciona no se toca.
- **Arranque**: tras cambiar el contenedor espera a que `/api/health` responda (hasta 3 min).
  Si se cae o no responde, vuelve a la imagen y al código anteriores (`<imagen>:anterior`).
- En los dos casos el commit queda en `.fallido` y no se reintenta cada 2 minutos; se vuelve a
  intentar cuando llega otro commit o con `--forzar`.
- **Colgado**: en cada vuelta, si el contenedor está `unhealthy` (vivo pero sin responder,
  ~2 min seguidos), lo reinicia. Docker sólo reinicia solo los que terminan.

```bash
ssh root@IP_DEL_VPS
cat /opt/radar-pruebas/.estado              # ¿está verificado lo último de dev?
journalctl -u radar-pruebas -n 50           # pruebas: construcción y comprobación
journalctl -u radar-actualizar -n 50        # producción: últimos despliegues
/opt/radar/deploy/actualizar.sh --forzar    # urgencia: desplegar ya, aunque no haya pasado pruebas
cd /opt/radar && docker compose logs -f     # logs de la aplicación
```

### Montar el entorno de pruebas

1. Con `deploy/preparar-pruebas.sh` ya en `dev`: `ssh root@IP_DEL_VPS 'bash -s' < deploy/preparar-pruebas.sh`.
   Clona `dev` en `/opt/radar-pruebas`, crea su `.env` (el de producción sin `GOATCOUNTER_URL`,
   con `RADAR_IMAGEN=radar-es-pruebas` y `RADAR_PUERTO=8081`), añade `pruebas.xn--radarespaa-19a.es`
   al `config.yml` del túnel (reinicia `cloudflared`: unos segundos sin servicio) y activa el
   temporizador.
2. **Antes de darlo de alta en el DNS**, protegerlo en Cloudflare Zero Trust → Access →
   Applications → Self-hosted: dominio `pruebas.radarespaña.es`, política *Allow* con tu correo y
   acceso con código por email (One-time PIN). Así nunca está abierto, ni a los buscadores.
3. `cloudflared tunnel route dns radar pruebas.radarespaña.es` (con ñ).

Si cambia el `.env` de producción, se borra `/opt/radar-pruebas/.env` y se relanza el paso 1.

## Datos y secretos

- `/opt/radar/.env`: `NAP_API_KEY`, titular, contacto, `GOATCOUNTER_URL`. No está en git; se copia a mano con `scp`.
- `/opt/radar-pruebas/.env`: copia del de producción para pruebas (ver arriba).
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
  - hostname: pruebas.xn--radarespaa-19a.es  # entorno de pruebas, detrás de Cloudflare Access
    service: http://localhost:8081
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
