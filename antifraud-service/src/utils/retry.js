function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reintenta `fn` con backoff exponencial. Si se agotan los reintentos,
 * relanza el último error para que el llamador decida cómo registrarlo.
 */
async function withRetry(fn, { retries = 3, initialDelayMs = 200, factor = 2 } = {}) {
  let attempt = 0;
  let delay = initialDelayMs;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries) {
        throw err;
      }
      await sleep(delay);
      delay *= factor;
    }
  }
}

module.exports = { withRetry, sleep };
