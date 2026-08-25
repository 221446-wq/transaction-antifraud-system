const { v4: uuidv4 } = require('uuid');
const { producer, ensureConnected } = require('../kafka/producer');

const TOPIC = 'transaction.created';

/**
 * Publica el evento transaction.created respetando el envelope y el payload
 * definidos en CONTRACT.md. La key del mensaje es el transactionExternalId,
 * para que todos los eventos de una misma transacción caigan en la misma
 * partición.
 */
async function publishTransactionCreated(transaction) {
  const event = {
    eventId: uuidv4(),
    eventType: TOPIC,
    occurredAt: new Date().toISOString(),
    data: {
      transactionExternalId: transaction.externalId,
      value: Number(transaction.value),
    },
  };

  await ensureConnected();
  await producer.send({
    topic: TOPIC,
    messages: [
      {
        key: event.data.transactionExternalId,
        value: JSON.stringify(event),
      },
    ],
  });
}

module.exports = { publishTransactionCreated, TOPIC };
