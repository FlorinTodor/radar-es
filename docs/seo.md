# SEO de radarespaña.es

Objetivo: que quien busque **radarespaña**, **radar españa**, **radarespaña.es** o **Radar ES** llegue a la web,
y atraer búsquedas de lo que muestra («trenes en tiempo real», «incidencias de tráfico», «incendios hoy»…).

## Qué hay en el código

| Pieza | Dónde | Para qué |
|---|---|---|
| Nombre «Radar España» | `<title>`, `h1`, `og:site_name`, datos estructurados | Que el nombre coincida con el dominio en todos los sitios donde Google lo busca |
| Datos estructurados `WebSite` | `public/index.html` | Google saca de aquí el **nombre del sitio** de los resultados; `alternateName` recoge radarespaña.es, radarespaña, Radar ES y radarespana |
| `BreadcrumbList` | páginas de contenido | Ruta «Radar España › …» en los resultados |
| Canonical y `og:url` | todas las páginas | Una sola URL por página, siempre con el dominio en punycode (`xn--radarespaa-19a.es`) |
| Redirección 301 de `www` | `http-server.js` (usa `PUBLIC_URL`) | `www.radarespaña.es` → `radarespaña.es`, para no tener dos webs iguales |
| URL limpias | `http-server.js` | `/legal` en vez de `/legal.html`; `.html`, barra final e `/index.html` redirigen con 301 |
| Páginas de contenido | `public/*.html` | Texto que Google puede leer (la portada es un mapa): qué es, trenes, metro/tranvía/autobús, incidencias |
| `robots.txt` y `sitemap.xml` | `public/` | Qué rastrear y lista de páginas |
| `X-Robots-Tag: noindex` | `/api/*` y `/tiles/*` | Los JSON y las teselas no salen en los resultados |
| Página 404 en HTML | `public/404.html` | Un 404 de verdad (no un 200) con enlaces al resto de la web |
| Favicon, iconos y manifest | `public/favicon.*`, `icon-*.png`, `site.webmanifest` | Google exige un favicon rastreable (antes era un `data:`) para mostrarlo junto al resultado |
| Imagen para redes | `public/og.png` (1200×630) | Vista previa al compartir en WhatsApp, X, Telegram… |

`test/public/seo.test.js` comprueba que cada página tiene título, descripción, canonical, un solo `h1`, Open
Graph y entrada en el sitemap. **Al añadir una página nueva hay que añadirla al sitemap**, o el test falla.

La imagen `og.png` es una captura real del mapa con solo los trenes y la red ferroviaria, para que la
atribución de las licencias quepa en una línea (Renfe, FGC, Open Data Euskadi, MITRAMS, IGR-RT y OpenStreetMap).
Si se rehace con otras capas, hay que añadir su atribución.

## Lo que hay que hacer en los paneles (una vez)

1. **Google Search Console** (<https://search.google.com/search-console>): añadir una propiedad de tipo
   **Dominio** con `radarespaña.es`. Google da un registro TXT: añadirlo en Cloudflare → DNS (tipo TXT, nombre
   `@`). Después:
   - Sitemaps → enviar `https://radarespaña.es/sitemap.xml`.
   - Inspección de URL → pegar la portada y cada página de contenido → «Solicitar indexación».
2. **Bing Webmaster Tools** (<https://www.bing.com/webmasters>): «Importar desde Google Search Console». Bing
   alimenta también a DuckDuckGo, Ecosia y Yahoo.
3. **Cloudflare**:
   - Caching → Configuration → **Crawler Hints**: activado. Avisa a Bing y Yandex (IndexNow) cuando cambia algo.
   - Si está activado el «robots.txt gestionado» o el bloqueo de bots de IA, comprobar en
     `https://radarespaña.es/robots.txt` que sigue nuestro contenido y que no bloquea a Googlebot ni a Bingbot.
   - Bot Fight Mode no bloquea a los buscadores verificados; no hace falta tocarlo.
4. **GitHub**: poner la web en el repositorio (About → Website), que da un enlace desde un sitio con mucha autoridad:
   `gh repo edit FlorinTodor/radar-es --homepage "https://radarespaña.es"`.

## Lo que más ayuda a partir de aquí

- **Enlaces desde otras webs**: es lo que más pesa para que una marca nueva salga la primera. Publicar la web
  en Reddit (r/spain, r/askspain), Menéame, foros de ferrocarril y de transporte, y un perfil en redes sociales
  con el enlace en la biografía.
- **Que la gente busque el nombre**: cada vez que alguien busca «radarespaña» y entra, Google refuerza la marca.
- **Paciencia**: una web nueva tarda de días a semanas en indexarse y en asentarse en los resultados. Search
  Console enseña las búsquedas por las que ya aparece.

## Sobre «radares españa»

En España «radares» se busca casi siempre como **radares de tráfico** (de velocidad). Por esa búsqueda compiten
la DGT y aplicaciones de navegación, y quien la hace busca otra cosa. La página «Qué es» lo aclara en sus
preguntas frecuentes, pero no conviene orientar la web a esa búsqueda sin tener una capa de radares de tráfico
con datos abiertos y licencia clara.
