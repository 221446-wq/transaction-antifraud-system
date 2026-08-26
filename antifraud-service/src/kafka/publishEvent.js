const { producer, ensureConnected } = require('./producer');

/**
 * Envío genérico a Kafka: conecta el productor si hace falta, serializa el
 * evento y lo publica con la key dada. Ver el equivalente en
 * transaction-service/src/kafka/publishEvent.js.
 */
async function publishEvent({ topic, key, event }) {
  await ensureConnected();
  await producer.send({
    topic,
    messages: [
      {
        key: String(key),
        value: JSON.stringify(event),
      },
    ],
  });
}

module.exports = { publishEvent };
