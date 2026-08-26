require('dotenv').config();

/**
 * Punto único de lectura de variables de entorno — mismo criterio que en
 * transaction-service/antifraud-service: fail-fast si falta una obligatoria.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

const env = {
  databaseUrl: required('DATABASE_URL'),
  sourceUrl: required('SOURCE_URL'),
  // Servidor HTTP propio: /health, /metrics, y GET /reference-rates (ver
  // src/http/server.js). No comparte puerto con transaction-service (3000)
  // ni antifraud-service (3001).
  port: Number(process.env.PORT) || 3002,
  // Default de 30 min: la fuente (BCE) publica una vez al día, así que no
  // tiene sentido sondear más seguido "por las dudas" — ver
  // docs/WEB_SCRAPING.md.
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 30 * 60 * 1000,
  fetchTimeoutMs: Number(process.env.FETCH_TIMEOUT_MS) || 10_000,
  fetchRetries: Number(process.env.FETCH_RETRIES) || 3,
  fetchRetryInitialDelayMs: Number(process.env.FETCH_RETRY_INITIAL_DELAY_MS) || 500,
  // Rate limiting por host (ver src/http/hostRateLimiter.js) — con una sola
  // fuente configurada, en la práctica ya lo garantiza pollIntervalMs, pero
  // queda expresado igual para no depender de esa coincidencia.
  minIntervalPerHostMs: Number(process.env.MIN_INTERVAL_PER_HOST_MS) || 5000,
};

module.exports = env;
