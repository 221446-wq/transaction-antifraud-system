const env = require('./config/env');
const logger = require('./logger');
const { collectOnce } = require('./collector');

let active = false;
let timer = null;

/**
 * `setTimeout` que se reprograma a sí mismo recién cuando termina el ciclo
 * anterior — no `setInterval`. Un `setInterval` dispararía el ciclo
 * siguiente igual aunque el anterior siguiera esperando la fuente (timeout
 * + reintentos con backoff, ver fetchWithPoliteness.js), superponiendo dos
 * recolecciones concurrentes de la misma fuente. Con el default de
 * `POLL_INTERVAL_MS` (30 min) es improbable, pero con un intervalo corto y
 * una fuente lenta sí puede pasar — el mismo bug se encontró y corrigió en
 * transaction-service/src/outbox/outboxRelay.js corriendo en vivo sin
 * Kafka disponible.
 */
async function runCycle() {
  try {
    await collectOnce();
  } catch (err) {
    logger.error({ error: err.message }, 'reference-data: error inesperado en el ciclo de recolección');
  } finally {
    if (active) {
      timer = setTimeout(runCycle, env.pollIntervalMs);
    }
  }
}

function start() {
  if (active) return;
  active = true;
  logger.info({ pollIntervalMs: env.pollIntervalMs, sourceUrl: env.sourceUrl }, 'reference-data: scheduler iniciado');
  runCycle();
}

function stop() {
  active = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { start, stop };
