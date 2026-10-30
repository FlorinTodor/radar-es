// Contador de visitas (GoatCounter: sin cookies y sin guardar la IP). Sólo se carga si el servidor
// tiene GOATCOUNTER_URL, así el desarrollo en local no cuenta. Se usa una versión fija del script
// con su huella (SRI): si alguien lo modificara, el navegador se negaría a ejecutarlo.
const SCRIPT = 'https://gc.zgo.at/count.v5.js';
const INTEGRITY = 'sha384-atnOLvQb9t+jTSipvd75X2yginT4PjVbqDdlJAmxMm+wYElFmeR6EmLP5bYeoRVQ';

fetch('/api/about').then((r) => r.json()).then(({ goatcounter }) => {
  if (!goatcounter || document.querySelector('script[data-goatcounter]')) return;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.integrity = INTEGRITY;
  script.dataset.goatcounter = goatcounter;
  script.src = SCRIPT;
  document.head.append(script);
}).catch(() => {});
