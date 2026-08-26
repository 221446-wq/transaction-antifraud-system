const { v4: uuidv4 } = require('uuid');

const TOPIC = 'transaction.created';

/**
 * Construye el envelope de transaction.created (ver CONTRACT.md) a partir de
 * la fila recién creada. Es una función pura, sin efectos secundarios: la
 * publicación real a Kafka ya no ocurre acá, sino en el relay del outbox
 * (ver src/outbox/outboxRelay.js) a partir de lo que esta función guarda en
 * la tabla `outbox_events` dentro de la misma transacción de Postgres que el
 * INSERT de negocio — ver DECISIONS.md, sección "Patrón Outbox".
 */
function buildTransactionCreatedEvent(transaction) {
  return {
    eventId: uuidv4(),
    eventType: TOPIC,
    occurredAt: new Date().toISOString(),
    data: {
      transactionExternalId: transaction.externalId,
      value: Number(transaction.value),
    },
  };
}

module.exports = { buildTransactionCreatedEvent, TOPIC };
