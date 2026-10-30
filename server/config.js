// Configuración a partir de variables de entorno (.env se carga con --env-file-if-exists).
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    // Por defecto sólo escucha en local; HOST=0.0.0.0 para exponerlo en la red.
    host: env.HOST || '127.0.0.1',
    dataDir: new URL('../data/', import.meta.url),
    env,
  };
}
