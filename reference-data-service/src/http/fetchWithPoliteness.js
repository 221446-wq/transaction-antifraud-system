const { withRetry } = require('./retry');
const { HostRateLimiter } = require('./hostRateLimiter');
const env = require('../config/env');

const hostRateLimiter = new HostRateLimiter(env.minIntervalPerHostMs);

/**
 * "Collection reliability" (extensión opcional del enunciado) en un único
 * lugar: rate limiting por host, timeout, reintentos acotados con backoff
 * ante fallos transitorios, y conditional requests (If-None-Match /
 * If-Modified-Since) para no volver a descargar la página si no cambió.
 *
 * Devuelve `{ notModified: true }` en un 304 (no es un error, es el caso
 * esperado la mayoría de las corridas: la fuente no publicó nada nuevo).
 * Un 4xx se considera un error permanente (URL mal configurada, bloqueo) y
 * no se reintenta; un 5xx o timeout sí, con backoff.
 */
async function fetchWithPoliteness(url, { etag = null, lastModified = null } = {}) {
  const { hostname } = new URL(url);
  await hostRateLimiter.waitForTurn(hostname);

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), env.fetchTimeoutMs);

      try {
        const headers = {};
        if (etag) headers['If-None-Match'] = etag;
        if (lastModified) headers['If-Modified-Since'] = lastModified;

        const res = await fetch(url, { headers, signal: controller.signal });

        if (res.status === 304) {
          return { notModified: true };
        }

        if (res.status >= 500) {
          throw new Error(`La fuente respondió ${res.status} ${res.statusText} (transitorio, se reintenta).`);
        }

        if (!res.ok) {
          const error = new Error(`La fuente respondió ${res.status} ${res.statusText} (no se reintenta).`);
          error.nonRetriable = true;
          throw error;
        }

        const html = await res.text();
        return {
          notModified: false,
          html,
          etag: res.headers.get('etag') || null,
          lastModified: res.headers.get('last-modified') || null,
        };
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      retries: env.fetchRetries,
      initialDelayMs: env.fetchRetryInitialDelayMs,
      factor: 2,
      shouldRetry: (err) => !err.nonRetriable,
    },
  );
}

module.exports = { fetchWithPoliteness };
