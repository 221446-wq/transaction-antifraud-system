const prisma = require('../db/prismaClient');
const metrics = require('../metrics');

const VALID_DECISION_STATUSES = ['approved', 'rejected'];

/**
 * Aplica una decisión antifraude de forma condicional: el UPDATE solo afecta
 * la fila si su status actual sigue siendo "pending". Esto la hace segura
 * ante entregas duplicadas o fuera de orden (p.ej. dos veces "approved", o
 * "approved" repetido después de que ya llegó "rejected"): la primera
 * decisión que llega gana, y las siguientes son no-ops detectables por
 * `result.count === 0`.
 */
async function applyFraudDecision({ transactionExternalId, status }) {
  const result = await prisma.transaction.updateMany({
    where: { externalId: transactionExternalId, status: 'pending' },
    data: { status },
  });

  if (result.count > 0) {
    metrics.fraudDecisionsAppliedTotal.inc({ status });
    return { applied: true };
  }

  const existing = await prisma.transaction.findUnique({
    where: { externalId: transactionExternalId },
    select: { status: true },
  });

  if (!existing) {
    metrics.fraudDecisionsIgnoredTotal.inc({ reason: 'not_found' });
    return { applied: false, reason: 'not_found' };
  }

  metrics.fraudDecisionsIgnoredTotal.inc({ reason: 'already_resolved' });
  return { applied: false, reason: 'already_resolved', currentStatus: existing.status };
}

module.exports = { applyFraudDecision, VALID_DECISION_STATUSES };
