const { v4: uuidv4 } = require('uuid');
const { publishEvent } = require('./publishEvent');
const logger = require('../logger');

/**
 * Publica en el tópico dead-letter correspondiente (`<tópico original>.dlq`)
 * cuando un mensaje se descarta (parseo inválido) o el outbox agota sus
 * reintentos de publicación. El objetivo es que ese mensaje quede
 * inspeccionable/reprocesable en Kafka en vez de desaparecer solo en un
 * `console.error` — ver LIMITATIONS.md (antes: "no implementado").
 *
 * No relanza si el publish a la DLQ también falla: es un mecanismo de
 * último recurso, y bloquear o tumbar al llamador por esto sería peor que
 * perder el registro en la DLQ (que ya quedó logueado igual).
 */
async function publishToDlq({ originalTopic, reason, error, event = null, rawValue = null, key = 'unknown' }) {
  const dlqTopic = `${originalTopic}.dlq`;
  const dlqEvent = {
    eventId: uuidv4(),
    eventType: dlqTopic,
    occurredAt: new Date().toISOString(),
    data: {
      originalTopic,
      reason,
      error,
      event,
      rawValue,
    },
  };

  try {
    await publishEvent({ topic: dlqTopic, key, event: dlqEvent });
  } catch (dlqError) {
    logger.error(
      { originalTopic, reason, dlqError: dlqError.message },
      `No se pudo publicar en la DLQ ${dlqTopic}; el mensaje solo queda registrado en logs.`,
    );
  }
}

module.exports = { publishToDlq };
