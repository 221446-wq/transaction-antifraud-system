const kafka = require('./kafkaClient');

const producer = kafka.producer();

let connectPromise = null;
let connected = false;

/**
 * Conecta el productor si aún no lo está. Es seguro llamarla en cada publish:
 * si Kafka no estaba disponible en un intento anterior, el siguiente vuelve a
 * intentar la conexión en vez de quedar bloqueado en un estado fallido.
 */
async function ensureConnected() {
  if (!connectPromise) {
    connectPromise = producer.connect()
      .then(() => {
        connected = true;
      })
      .catch((err) => {
        connectPromise = null;
        connected = false;
        throw err;
      });
  }
  await connectPromise;
}

async function disconnect() {
  connectPromise = null;
  connected = false;
  await producer.disconnect();
}

function isConnected() {
  return connected;
}

module.exports = { producer, ensureConnected, disconnect, isConnected };
