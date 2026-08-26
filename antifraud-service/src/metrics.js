const client = require('prom-client');

/**
 * Métricas Prometheus del servicio, expuestas en GET /metrics (ver
 * src/http/server.js). Registro propio, igual que en transaction-service.
 */
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const transactionsEvaluatedTotal = new client.Counter({
  name: 'transactions_evaluated_total',
  help: 'Transacciones evaluadas por la regla antifraude, por decisión resultante.',
  labelNames: ['status'],
  registers: [register],
});

const fraudDecisionPublishErrorsTotal = new client.Counter({
  name: 'fraud_decision_publish_errors_total',
  help: 'Veces que se agotaron los reintentos al publicar transaction.fraud-decision (terminó en la DLQ).',
  registers: [register],
});

module.exports = { register, transactionsEvaluatedTotal, fraudDecisionPublishErrorsTotal };
