const { v4: uuidv4 } = require('uuid');
const { publishEvent } = require('../kafka/publishEvent');

// Tópico y estructura definidos en CONTRACT.md (Tarea 0).
const TOPIC = 'transaction.fraud-decision';
const VALID_STATUSES = ['approved', 'rejected'];

/**
 * Publica el evento transaction.fraud-decision respetando el envelope y el
 * payload definidos en CONTRACT.md. La key del mensaje es el
 * transactionExternalId, igual que en transaction.created, para que ambos
 * eventos de una misma transacción caigan en la misma partición.
 */
async function publishFraudDecision({ transactionExternalId, status }) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(
      `Estado de decisión inválido: ${JSON.stringify(status)}. Solo se permite "approved" o "rejected".`,
    );
  }

  const event = {
    eventId: uuidv4(),
    eventType: TOPIC,
    occurredAt: new Date().toISOString(),
    data: { transactionExternalId, status },
  };

  await publishEvent({ topic: TOPIC, key: transactionExternalId, event });
}

module.exports = { publishFraudDecision, TOPIC, VALID_STATUSES };
