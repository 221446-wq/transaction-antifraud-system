/**
 * Rate limiting por host: asegura al menos `minIntervalMs` entre dos
 * requests al mismo hostname. Con una sola fuente configurada hoy esto
 * equivale a "no recolectar más seguido que cada POLL_INTERVAL_MS", pero
 * queda expresado por host (no global) para que agregar una segunda fuente
 * en el futuro no viole la política de cortesía de la primera solo porque
 * ambas corren en el mismo proceso.
 */
class HostRateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.lastRequestAtByHost = new Map();
  }

  async waitForTurn(hostname) {
    const lastRequestAt = this.lastRequestAtByHost.get(hostname);
    if (lastRequestAt !== undefined) {
      const elapsed = Date.now() - lastRequestAt;
      const remaining = this.minIntervalMs - elapsed;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
    }
    this.lastRequestAtByHost.set(hostname, Date.now());
  }
}

module.exports = { HostRateLimiter };
