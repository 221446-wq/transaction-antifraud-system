const { producer, ensureConnected } = require('./producer');

/**
 * Envío genérico a Kafka: conecta el productor si hace falta, serializa el
 * evento y lo publica con la key dada. Punto único usado tanto por el relay
 * del outbox como por el publisher de DLQ, para no repetir el mismo
 * ensureConnected/producer.send en cada lugar que necesita mandar un mensaje.
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
