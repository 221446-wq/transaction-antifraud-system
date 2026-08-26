const env = require('./config/env');
const logger = require('./logger');
const { consumer } = require('./kafka/consumer');
const { ensureConnected: ensureKafkaProducerConnected, disconnect: disconnectProducer } = require('./kafka/producer');
const { startTransactionCreatedConsumer } = require('./events/transactionCreatedConsumer');
const httpServer = require('./http/server');

logger.info(
  { clientId: env.kafkaClientId, brokers: env.kafkaBrokers },
  'antifraud-service inicializado',
);

// Intento de conexión temprana al productor de Kafka: si el broker no está
// disponible al arrancar, el servicio sigue levantando igual (se reintenta
// de forma lazy en cada publish, ver src/kafka/producer.js).
ensureKafkaProducerConnected().catch((err) => {
  logger.error({ error: err.message }, 'No se pudo conectar el productor de Kafka al arrancar');
});

startTransactionCreatedConsumer().catch((err) => {
  logger.error({ error: err.message }, 'El consumer de transaction.created se detuvo inesperadamente');
});

const server = httpServer.start(env.port);

/**
 * Apagado ordenado: deja de aceptar conexiones HTTP (health/metrics),
 * desconecta el consumer y el productor de Kafka. Ver el equivalente en
 * transaction-service/src/index.js y LIMITATIONS.md.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Señal recibida, iniciando apagado ordenado');

  const forceExitTimer = setTimeout(() => {
    logger.error('Apagado ordenado no terminó a tiempo, forzando salida');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close();
  await Promise.allSettled([consumer.disconnect(), disconnectProducer()]);

  clearTimeout(forceExitTimer);
  logger.info('Apagado ordenado completo');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
