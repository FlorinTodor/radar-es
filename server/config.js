// Configuración a partir de variables de entorno (.env se carga con --env-file-if-exists).
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 8080,
    // Por defecto sólo escucha en local; HOST=0.0.0.0 para exponerlo en la red.
    host: env.HOST || '127.0.0.1',
    dataDir: new URL('../data/', import.meta.url),
    // Identificarse con la web y un contacto permite a un operador avisarnos antes de bloquearnos.
    userAgent: `RadarES/0.2 (+${env.PUBLIC_URL || 'https://xn--radarespaa-19a.es'}${env.CONTACT_EMAIL ? `; ${env.CONTACT_EMAIL}` : ''})`,
    // Titular y contacto para el aviso legal: vienen de .env para no guardar datos personales en git.
    about: {
      owner: env.OWNER_NAME || null,
      contact: env.CONTACT_EMAIL || null,
      publicUrl: env.PUBLIC_URL || null,
    },
    env,
  };
}
