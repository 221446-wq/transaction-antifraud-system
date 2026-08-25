const kafka = require('./kafkaClient');

const producer = kafka.producer();

let connectPromise = null;

/**
 * Conecta el productor si aún no lo está. Es seguro llamarla en cada publish:
 * si Kafka no estaba disponible en un intento anterior, el siguiente vuelve a
 * intentar la conexión en vez de quedar bloqueado en un estado fallido.
 */
async function ensureConnected() {
  if (!connectPromise) {
    connectPromise = producer.connect().catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  await connectPromise;
}

async function disconnect() {
  connectPromise = null;
  await producer.disconnect();
}

module.exports = { producer, ensureConnected, disconnect };
