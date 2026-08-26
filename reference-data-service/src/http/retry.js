function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reintenta `fn` con backoff exponencial acotado. Mismo utilitario que en
 * antifraud-service/src/utils/retry.js — se duplica a propósito en vez de
 * compartir un paquete: cada servicio de este proyecto es autocontenido
 * (ver DECISIONS.md).
 */
async function withRetry(fn, { retries = 3, initialDelayMs = 500, factor = 2, shouldRetry = () => true } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(err)) {
        throw err;
      }
      await sleep(delay);
      delay *= factor;
    }
  }
}

module.exports = { withRetry, sleep };
