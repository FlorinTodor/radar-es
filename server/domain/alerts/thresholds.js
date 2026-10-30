// Umbrales de las reglas. Se pueden sobreescribir desde la composición (main.js).
export const DEFAULT_THRESHOLDS = Object.freeze({
  stoppedMinutes: 8,        // minutos sin moverse para considerar "detenido"
  stoppedRadiusKm: 0.15,    // tolerancia al ruido del GPS
  awayFromStationKm: 1.0,   // a partir de aquí se considera "en plena vía"
  clusterKm: 10,            // trenes detenidos a menos de esta distancia => posible bloqueo
  delayMedium: 45,
  delayHigh: 90,
  delayJumpMinutes: 15,     // subida de retraso dentro de la ventana siguiente
  delayJumpWindowMin: 15,
  staleFixMinutes: 10,      // GPS del tren sin actualizar
  quakeMinMagnitude: 3.5,
  quakeWindowHours: 3,
  gridDropHigh: -0.10,      // demanda eléctrica real frente a prevista
  gridDropCritical: -0.25,
  fleetDropRatio: 0.6,      // quedan menos del 60 % de los trenes de hace ~10 min
  staleFeedMinutes: 10,
  fireNearKm: 3,            // foco de calor a menos de esto de un tren
  fireClusterKm: 2,         // detecciones a menos de esto se tratan como un mismo incendio
  fireWindowHours: 12,
  internetWindowMinutes: 60, // una caída de Internet sigue en alerta hasta 1 h después de acabar
});
