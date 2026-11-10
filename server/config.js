// Configuración a partir de variables de entorno (.env se carga con --env-file-if-exists).
import { isBotToken, isBotUsername } from './adapters/outbound/telegram/telegram-api.js';

export function loadConfig(env = process.env) {
  const telegram = telegramConfig(env);
  return {
    port: Number(env.PORT) || 8080,
    // Por defecto sólo escucha en local; HOST=0.0.0.0 para exponerlo en la red.
    host: env.HOST || '127.0.0.1',
    // Métricas para la monitorización (GET /metrics), en otro puerto: sin METRICS_PORT no se abre.
    // compose.yaml lo abre dentro de la red de Docker, sin publicarlo (ver deploy/monitor/).
    metricsPort: Number(env.METRICS_PORT) || null,
    metricsHost: env.METRICS_HOST || '127.0.0.1',
    dataDir: new URL('../data/', import.meta.url),
    // Identificarse con la web y un contacto permite a un operador avisarnos antes de bloquearnos.
    userAgent: `RadarES/0.2 (+${env.PUBLIC_URL || 'https://xn--radarespaa-19a.es'}${env.CONTACT_EMAIL ? `; ${env.CONTACT_EMAIL}` : ''})`,
    // Titular y contacto para el aviso legal: vienen de .env para no guardar datos personales en git.
    about: {
      owner: env.OWNER_NAME || null,
      contact: env.CONTACT_EMAIL || null,
      publicUrl: publicUrl(env.PUBLIC_URL),
      // Contador de visitas sin cookies. Sin esta variable no se carga (así en local no cuenta).
      goatcounter: goatcounterUrl(env.GOATCOUNTER_URL),
      // El usuario del bot de Telegram, para el botón «Avisarme por Telegram» de las fichas (nunca el token).
      telegram: telegram?.username ? { bot: telegram.username } : null,
    },
    telegram,
    env,
  };
}

/**
 * El bot de Telegram «Sigue tu tren» (ver docs/telegram.md): su token y su usuario, de .env. Sin un token con
 * forma de token, no hay bot (null). El usuario (sin la @) sólo hace falta para el botón de la web; sin él, el bot
 * funciona igual. webUrl: la web que citan sus mensajes.
 * @returns {{ token: string, username: string|null, webUrl: string }|null}
 */
export function telegramConfig(env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!isBotToken(token)) return null;
  const username = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  return {
    token,
    username: isBotUsername(username) ? username : null,
    webUrl: publicUrl(env.TELEGRAM_WEB_URL) ?? 'https://radarespana.es',
  };
}

/** Acepta sólo una URL https que acabe en /count, como la de GoatCounter (https://CODIGO.goatcounter.com/count). */
export function goatcounterUrl(value) {
  const url = value?.trim();
  return url && /^https:\/\/[a-z0-9.-]+\/count$/i.test(url) ? url : null;
}

/** URL pública de la web (https://dominio): sólo el origen, o null si no es una URL http(s) válida. */
export function publicUrl(value) {
  try {
    const url = new URL(value?.trim());
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}
