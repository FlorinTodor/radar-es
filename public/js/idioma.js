// Se carga en el <head>, antes de pintar nada: si la web va en inglés (?lang=en o elegido con el
// interruptor), marca <html lang="en"> y la oculta hasta que i18n.js la traduce, para que no se vea
// primero en español. Si i18n.js no llegara a cargar, el CSS la enseña igualmente al poco (style.css).
(function () {
  var lang = null;
  try {
    lang = new URLSearchParams(location.search).get('lang');
  } catch (e) { /* sin URLSearchParams: lo guardado */ }
  if (lang !== 'en' && lang !== 'es') {
    try {
      lang = localStorage.getItem('radar-es:idioma');
    } catch (e) { /* almacenamiento bloqueado: español */ }
  }
  if (lang === 'en') {
    document.documentElement.lang = 'en';
    document.documentElement.classList.add('i18n-wait');
  }
})();
