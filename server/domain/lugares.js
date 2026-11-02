// Centros aproximados (a unos kilómetros) de islas, provincias y comunidades autónomas, para situar
// en el mapa los avisos oficiales que sólo dicen el territorio afectado. Puro: datos fijos.
// Los avisos de un municipio se sitúan con el geocodificador (puerto Geocoder), no con esta tabla.

/** @typedef {{ name: string, lat: number, lon: number }} Place */

/** Islas de Canarias, con los nombres con los que las citan los avisos del Gobierno de Canarias. */
export const ISLAS_CANARIAS = [
  { name: 'El Hierro', lat: 27.74, lon: -18.02 },
  { name: 'La Palma', lat: 28.68, lon: -17.86 },
  { name: 'La Gomera', lat: 28.11, lon: -17.23 },
  { name: 'Tenerife', lat: 28.29, lon: -16.62 },
  { name: 'Gran Canaria', lat: 27.96, lon: -15.6 },
  { name: 'Fuerteventura', lat: 28.36, lon: -14.05 },
  { name: 'Lanzarote', lat: 29.04, lon: -13.63 },
  { name: 'La Graciosa', lat: 29.25, lon: -13.5 },
];

// Grupos de islas que usan los avisos («islas occidentales», «islas orientales»).
export const GRUPOS_ISLAS = {
  occidentales: ['El Hierro', 'La Palma', 'La Gomera', 'Tenerife'],
  orientales: ['Gran Canaria', 'Fuerteventura', 'Lanzarote', 'La Graciosa'],
};

/** Provincias de las comunidades con avisos integrados. */
export const PROVINCIAS = [
  // Andalucía
  { name: 'Almería', lat: 37.19, lon: -2.34 },
  { name: 'Cádiz', lat: 36.55, lon: -5.76 },
  { name: 'Córdoba', lat: 37.99, lon: -4.78 },
  { name: 'Granada', lat: 37.31, lon: -3.27 },
  { name: 'Huelva', lat: 37.57, lon: -6.83 },
  { name: 'Jaén', lat: 37.99, lon: -3.46 },
  { name: 'Málaga', lat: 36.81, lon: -4.59 },
  { name: 'Sevilla', lat: 37.43, lon: -5.68 },
  // Castilla-La Mancha
  { name: 'Albacete', lat: 38.82, lon: -1.98 },
  { name: 'Ciudad Real', lat: 38.92, lon: -3.84 },
  { name: 'Cuenca', lat: 39.9, lon: -2.19 },
  { name: 'Guadalajara', lat: 40.81, lon: -2.62 },
  { name: 'Toledo', lat: 39.79, lon: -4.15 },
  // Castilla y León
  { name: 'Ávila', lat: 40.57, lon: -4.98 },
  { name: 'Burgos', lat: 42.35, lon: -3.58 },
  { name: 'León', lat: 42.62, lon: -5.84 },
  { name: 'Palencia', lat: 42.37, lon: -4.54 },
  { name: 'Salamanca', lat: 40.8, lon: -6.06 },
  { name: 'Segovia', lat: 41.17, lon: -4.05 },
  { name: 'Soria', lat: 41.62, lon: -2.59 },
  { name: 'Valladolid', lat: 41.64, lon: -4.85 },
  { name: 'Zamora', lat: 41.73, lon: -6.05 },
];

export const COMUNIDADES = {
  andalucia: { name: 'Andalucía', lat: 37.46, lon: -4.58 },
  canarias: { name: 'Canarias', lat: 28.33, lon: -15.75 },
  'castilla-la-mancha': { name: 'Castilla-La Mancha', lat: 39.58, lon: -3.0 },
  'castilla-y-leon': { name: 'Castilla y León', lat: 41.75, lon: -4.78 },
  cataluna: { name: 'Cataluña', lat: 41.8, lon: 1.53 },
  'la-rioja': { name: 'La Rioja', lat: 42.27, lon: -2.52 },
};

/**
 * Sistemas eléctricos aislados con su demanda en tiempo real (Red Eléctrica): cada isla o grupo de
 * islas conectadas de Canarias, Ceuta y Melilla. Baleares no publica su demanda real en tiempo real.
 */
export const SISTEMAS_AISLADOS = [
  { name: 'Gran Canaria', lat: 27.96, lon: -15.6 },
  { name: 'Lanzarote y Fuerteventura', lat: 28.75, lon: -13.85 },
  { name: 'Tenerife', lat: 28.29, lon: -16.62 },
  { name: 'La Palma', lat: 28.68, lon: -17.86 },
  { name: 'La Gomera', lat: 28.11, lon: -17.23 },
  { name: 'El Hierro', lat: 27.74, lon: -18.02 },
  { name: 'Ceuta', lat: 35.889, lon: -5.316 },
  { name: 'Melilla', lat: 35.292, lon: -2.938 },
];
