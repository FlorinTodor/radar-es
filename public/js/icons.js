// Iconos de vehículo: una placa redondeada del color del retraso con el pictograma del tipo de
// vehículo dentro (como en los mapas de transporte). Las posiciones estimadas por horario usan
// la placa hueca: fondo oscuro, borde y pictograma del color. Se dibujan en canvas para usarlos
// igual en el mapa (MapLibre addImage) y en la leyenda (data URL).

const UNIT = 32;              // coordenadas lógicas del dibujo
const DARK = '#0d0d0d';
const HOLLOW_BG = '#1a1a19';

/** Pictograma según el modo del vehículo. */
export function pictoFor(mode) {
  return { av: 'av', metro: 'metro', tranvia: 'tranvia', bus: 'bus' }[mode] ?? 'tren';
}

export const PICTOS = ['av', 'tren', 'metro', 'tranvia', 'bus'];

const roundRect = (g, x, y, w, h, r) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};

// Cada pictograma se dibuja en `ink` sobre la placa; los huecos (ventanas, faros) en `bg`.
const DRAW = {
  // Alta velocidad: frente de morro redondeado y parabrisas inclinado.
  av(g, ink, bg) {
    g.fillStyle = ink;
    g.beginPath();
    g.moveTo(9.5, 22.5); g.lineTo(9.5, 14); g.quadraticCurveTo(10, 6.5, 16, 6.5); g.quadraticCurveTo(22, 6.5, 22.5, 14); g.lineTo(22.5, 22.5);
    g.closePath(); g.fill();
    g.fillStyle = bg;
    g.beginPath(); g.moveTo(12, 14.5); g.quadraticCurveTo(12.5, 10, 16, 10); g.quadraticCurveTo(19.5, 10, 20, 14.5); g.closePath(); g.fill();
    g.beginPath(); g.arc(12.6, 19, 1.3, 0, Math.PI * 2); g.arc(19.4, 19, 1.3, 0, Math.PI * 2); g.fill();
    legs(g, ink);
  },
  // Tren convencional: frente cuadrado con parabrisas y dos faros.
  tren(g, ink, bg) {
    g.fillStyle = ink;
    roundRect(g, 9.5, 7, 13, 15.5, 3); g.fill();
    g.fillStyle = bg;
    roundRect(g, 11.5, 9, 9, 5.5, 1); g.fill();
    g.beginPath(); g.arc(12.8, 18.8, 1.3, 0, Math.PI * 2); g.arc(19.2, 18.8, 1.3, 0, Math.PI * 2); g.fill();
    legs(g, ink);
  },
  // Metro: frente de tren con una "M" en el parabrisas.
  metro(g, ink, bg) {
    g.fillStyle = ink;
    roundRect(g, 9.5, 7, 13, 15.5, 3); g.fill();
    g.fillStyle = bg;
    g.font = '700 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('M', 16, 13.2);
    g.beginPath(); g.arc(12.8, 19.3, 1.2, 0, Math.PI * 2); g.arc(19.2, 19.3, 1.2, 0, Math.PI * 2); g.fill();
    legs(g, ink);
  },
  // Tranvía: frente redondeado con pantógrafo.
  tranvia(g, ink, bg) {
    g.strokeStyle = ink;
    g.lineWidth = 1.6;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(16, 10); g.lineTo(13.5, 6.5); g.lineTo(16, 4.8); g.lineTo(18.5, 6.5); g.closePath(); g.stroke();
    g.beginPath(); g.moveTo(11.5, 4.2); g.lineTo(20.5, 4.2); g.stroke();
    g.fillStyle = ink;
    roundRect(g, 9.5, 10, 13, 12.5, 4); g.fill();
    g.fillStyle = bg;
    roundRect(g, 11.5, 12, 9, 4.5, 1.2); g.fill();
    g.beginPath(); g.arc(12.8, 19.6, 1.1, 0, Math.PI * 2); g.arc(19.2, 19.6, 1.1, 0, Math.PI * 2); g.fill();
    legs(g, ink);
  },
  // Autobús: frente con parabrisas grande, retrovisores y ruedas.
  bus(g, ink, bg) {
    g.fillStyle = ink;
    roundRect(g, 9, 7, 14, 15, 2.5); g.fill();
    g.fillRect(10.5, 22, 2.6, 3); g.fillRect(18.9, 22, 2.6, 3);
    g.strokeStyle = ink;
    g.lineWidth = 1.4;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(7.2, 9.5); g.lineTo(7.2, 13); g.moveTo(24.8, 9.5); g.lineTo(24.8, 13); g.stroke();
    g.fillStyle = bg;
    roundRect(g, 10.8, 9, 10.4, 6.5, 1); g.fill();
    g.beginPath(); g.arc(12.4, 19, 1.2, 0, Math.PI * 2); g.arc(19.6, 19, 1.2, 0, Math.PI * 2); g.fill();
  },
};

function legs(g, ink) {
  g.strokeStyle = ink;
  g.lineWidth = 1.6;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(12, 23); g.lineTo(10, 26); g.moveTo(20, 23); g.lineTo(22, 26); g.stroke();
}

/** Dibuja la placa completa en un canvas de `UNIT * scale` píxeles. */
function render(picto, color, estimated, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = UNIT * scale;
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  // Placa: rellena del color del retraso, o hueca (fondo oscuro y borde de color) si es estimada.
  roundRect(g, 2, 2, 28, 28, 8);
  g.fillStyle = estimated ? HOLLOW_BG : color;
  g.fill();
  g.lineWidth = estimated ? 2.6 : 1.6;
  g.strokeStyle = estimated ? color : DARK;
  g.stroke();
  const ink = estimated ? color : DARK;
  const bg = estimated ? HOLLOW_BG : color;
  DRAW[picto](g, ink, bg);
  return canvas;
}

/** Imagen para MapLibre (`map.addImage(nombre, imagen, { pixelRatio: 2 })`). */
export function vehicleImage(picto, color, estimated = false) {
  const canvas = render(picto, color, estimated, 2);
  return { width: canvas.width, height: canvas.height, data: canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data };
}

const urls = new Map();

/** Data URL para la leyenda y las listas (cacheada: sólo hay unas pocas combinaciones). */
export function vehicleIconUrl(picto, color, estimated = false) {
  const key = `${picto}|${color}|${estimated}`;
  if (!urls.has(key)) urls.set(key, render(picto, color, estimated, 2).toDataURL());
  return urls.get(key);
}
