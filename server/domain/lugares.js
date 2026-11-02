// Centros aproximados (a unos kilómetros) de islas, provincias y comunidades autónomas, para situar
// en el mapa los avisos oficiales que sólo dicen el territorio afectado. Puro: datos fijos.
// Los avisos de un municipio los sitúa el geocodificador de las fuentes (CartoCiudad), no esta tabla.

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

/** Islas de Baleares, con su nombre en castellano (la sala de prensa del Govern, en catalán, dice «Eivissa»: ver illesIn). */
export const ILLES_BALEARS = [
  { name: 'Mallorca', lat: 39.62, lon: 2.98 },
  { name: 'Menorca', lat: 39.95, lon: 4.08 },
  { name: 'Ibiza', lat: 38.98, lon: 1.43 },
  { name: 'Formentera', lat: 38.7, lon: 1.45 },
];

// Cada provincia lleva la clave de su comunidad en COMUNIDADES (`region`): así un adaptador sabe cuáles
// son las de su comunidad sin repetir la lista.
const enComunidad = (region, places) => places.map((p) => ({ ...p, region }));

/**
 * Provincias de las comunidades con avisos integrados.
 * @type {Array<Place & { region: string }>}
 */
export const PROVINCIAS = [
  ...enComunidad('andalucia', [
    { name: 'Almería', lat: 37.19, lon: -2.34 },
    { name: 'Cádiz', lat: 36.55, lon: -5.76 },
    { name: 'Córdoba', lat: 37.99, lon: -4.78 },
    { name: 'Granada', lat: 37.31, lon: -3.27 },
    { name: 'Huelva', lat: 37.57, lon: -6.83 },
    { name: 'Jaén', lat: 37.99, lon: -3.46 },
    { name: 'Málaga', lat: 36.81, lon: -4.59 },
    { name: 'Sevilla', lat: 37.43, lon: -5.68 },
  ]),
  ...enComunidad('castilla-la-mancha', [
    { name: 'Albacete', lat: 38.82, lon: -1.98 },
    { name: 'Ciudad Real', lat: 38.92, lon: -3.84 },
    { name: 'Cuenca', lat: 39.9, lon: -2.19 },
    { name: 'Guadalajara', lat: 40.81, lon: -2.62 },
    { name: 'Toledo', lat: 39.79, lon: -4.15 },
  ]),
  ...enComunidad('castilla-y-leon', [
    { name: 'Ávila', lat: 40.57, lon: -4.98 },
    { name: 'Burgos', lat: 42.35, lon: -3.58 },
    { name: 'León', lat: 42.62, lon: -5.84 },
    { name: 'Palencia', lat: 42.37, lon: -4.54 },
    { name: 'Salamanca', lat: 40.8, lon: -6.06 },
    { name: 'Segovia', lat: 41.17, lon: -4.05 },
    { name: 'Soria', lat: 41.62, lon: -2.59 },
    { name: 'Valladolid', lat: 41.64, lon: -4.85 },
    { name: 'Zamora', lat: 41.73, lon: -6.05 },
  ]),
  ...enComunidad('galicia', [
    { name: 'A Coruña', lat: 43.13, lon: -8.42 },
    { name: 'Lugo', lat: 43.01, lon: -7.56 },
    { name: 'Ourense', lat: 42.19, lon: -7.62 },
    { name: 'Pontevedra', lat: 42.43, lon: -8.48 },
  ]),
];

export const COMUNIDADES = {
  andalucia: { name: 'Andalucía', lat: 37.46, lon: -4.58 },
  canarias: { name: 'Canarias', lat: 28.33, lon: -15.75 },
  'castilla-la-mancha': { name: 'Castilla-La Mancha', lat: 39.58, lon: -3.0 },
  'castilla-y-leon': { name: 'Castilla y León', lat: 41.75, lon: -4.78 },
  cataluna: { name: 'Cataluña', lat: 41.8, lon: 1.53 },
  'illes-balears': { name: 'Illes Balears', lat: 39.5, lon: 2.75 },
  'la-rioja': { name: 'La Rioja', lat: 42.27, lon: -2.52 },
  madrid: { name: 'Comunidad de Madrid', lat: 40.5, lon: -3.72 },
  murcia: { name: 'Región de Murcia', lat: 38.0, lon: -1.49 },
  cantabria: { name: 'Cantabria', lat: 43.2, lon: -4.03 },
  galicia: { name: 'Galicia', lat: 42.76, lon: -7.87 },
};

/** Una isla de Canarias por su nombre, con sus coordenadas de ISLAS_CANARIAS (sin repetirlas). */
function islaCanaria(name) {
  const isla = ISLAS_CANARIAS.find((p) => p.name === name);
  if (!isla) throw new Error(`lugares: «${name}» no está en ISLAS_CANARIAS`);
  return { name, lat: isla.lat, lon: isla.lon, places: [name] };
}

/**
 * Sistemas eléctricos aislados con su demanda en tiempo real (Red Eléctrica): cada isla o grupo de
 * islas conectadas de Canarias, Ceuta y Melilla. Baleares no publica su demanda real en tiempo real.
 * `id` es la clave con la que el adaptador de la fuente (e·sios) da la demanda de cada uno: el dominio
 * lo sitúa por ella, no por el nombre que traiga la fuente. `places`: los lugares (islas) a los que da
 * luz, con el nombre con el que los citan los avisos oficiales.
 * @type {Array<Place & { id: string, places: string[] }>}
 */
export const SISTEMAS_AISLADOS = [
  { id: 'gran-canaria', ...islaCanaria('Gran Canaria') },
  // Dos islas conectadas entre sí: un solo sistema, situado entre las dos (no es ninguna de ISLAS_CANARIAS).
  // La Graciosa recibe la luz de Lanzarote.
  { id: 'lanzarote-fuerteventura', name: 'Lanzarote y Fuerteventura', lat: 28.75, lon: -13.85, places: ['Lanzarote', 'Fuerteventura', 'La Graciosa'] },
  { id: 'tenerife', ...islaCanaria('Tenerife') },
  { id: 'la-palma', ...islaCanaria('La Palma') },
  { id: 'la-gomera', ...islaCanaria('La Gomera') },
  { id: 'el-hierro', ...islaCanaria('El Hierro') },
  { id: 'ceuta', name: 'Ceuta', lat: 35.889, lon: -5.316, places: ['Ceuta'] },
  { id: 'melilla', name: 'Melilla', lat: 35.292, lon: -2.938, places: ['Melilla'] },
];
