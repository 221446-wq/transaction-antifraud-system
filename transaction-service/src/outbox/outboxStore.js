const { buildTransactionCreatedEvent } = require('../events/transactionCreatedPublisher');

/**
 * Encola el evento transaction.created en la tabla outbox. Debe llamarse con
 * el `client` de una transacción de Prisma en curso (ver
 * transactionService.js), nunca con el prisma global: la garantía del outbox
 * depende de que este INSERT y el INSERT de la transacción de negocio
 * confirmen (o fallen) juntos, en el mismo commit de Postgres.
 */
async function enqueueTransactionCreated(client, transaction) {
  const event = buildTransactionCreatedEvent(transaction);

  await client.outboxEvent.create({
    data: {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: transaction.externalId,
      payload: event,
    },
  });

  return event;
}

module.exports = { enqueueTransactionCreated };
