// Contador de visitas (GoatCounter: sin cookies y sin guardar la IP). Sólo se carga si el servidor
// tiene GOATCOUNTER_URL, así el desarrollo en local no cuenta. Se usa una versión fija del script
// con su huella (SRI): si alguien lo modificara, el navegador se negaría a ejecutarlo.
const SCRIPT = 'https://gc.zgo.at/count.v5.js';
const INTEGRITY = 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ';

fetch('/api/about').then((r) => r.json()).then(({ goatcounter }) => {
  if (!goatcounter || document.querySelector('script[data-goatcounter]')) return;
  // Los enlaces compartidos cuentan como su tipo (/incidencia, /vehiculo, /estacion), no uno por uno: así el contador
  // no apunta qué incidencia ha abierto cada visita, y las páginas se pueden comparar.
  window.goatcounter = { ...(window.goatcounter ?? {}), path: (p) => p.replace(/^\/(incidencia|estacion|vehiculo)\/[^?#]*/, '/$1') };
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.integrity = INTEGRITY;
  script.dataset.goatcounter = goatcounter;
  script.src = SCRIPT;
  document.head.append(script);
}).catch(() => {});
