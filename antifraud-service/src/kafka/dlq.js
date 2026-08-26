const { v4: uuidv4 } = require('uuid');
const { publishEvent } = require('./publishEvent');
const logger = require('../logger');

/**
 * Publica en el tópico dead-letter correspondiente (`<tópico original>.dlq`)
 * cuando un mensaje se descarta por parseo inválido, o cuando se agotan los
 * reintentos al publicar una decisión antifraude. Ver el equivalente en
 * transaction-service/src/kafka/dlq.js y CONTRACT.md.
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
