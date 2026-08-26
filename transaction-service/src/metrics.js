const client = require('prom-client');

/**
 * Métricas Prometheus del servicio, expuestas en GET /metrics (ver app.js).
 * Un registro propio (no el global de prom-client) para no pisarse con el
 * de otro módulo que use la librería en el mismo proceso.
 */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const transactionsCreatedTotal = new client.Counter({
  name: 'transactions_created_total',
  help: 'Cantidad total de transacciones creadas vía POST /transactions.',
  registers: [register],
});

const fraudDecisionsAppliedTotal = new client.Counter({
  name: 'fraud_decisions_applied_total',
  help: 'Decisiones antifraude aplicadas a una transacción (pending -> approved|rejected), por status resultante.',
  labelNames: ['status'],
  registers: [register],
});

const fraudDecisionsIgnoredTotal = new client.Counter({
  name: 'fraud_decisions_ignored_total',
  help: 'Decisiones antifraude recibidas pero no aplicadas (duplicadas, fuera de orden, o transacción inexistente).',
  labelNames: ['reason'],
  registers: [register],
});

// Gauge con `collect` diferido en vez de setearla al vuelo: así el valor
// reportado siempre corresponde al momento del scrape, no a la última vez
// que algo la actualizó manualmente.
// eslint-disable-next-line no-new
new client.Gauge({
  name: 'outbox_pending_events',
  help: 'Eventos en la tabla outbox todavía sin publicar ni enviar a la DLQ (aproximado, al momento del scrape).',
  registers: [register],
  async collect() {
    const prisma = require('./db/prismaClient'); // eslint-disable-line global-require
    try {
      const count = await prisma.outboxEvent.count({ where: { publishedAt: null, deadLetteredAt: null } });
      this.set(count);
    } catch {
      // Si Postgres no responde, /metrics no debería romperse por esto: se
      // deja el último valor conocido.
    }
  },
});

module.exports = {
  register,
  transactionsCreatedTotal,
  fraudDecisionsAppliedTotal,
  fraudDecisionsIgnoredTotal,
};
