const app = require('./app');
const env = require('./config/env');
const logger = require('./logger');
const prisma = require('./db/prismaClient');
const { ensureConnected: ensureKafkaProducerConnected, disconnect: disconnectProducer } = require('./kafka/producer');
const { consumer: fraudDecisionConsumer } = require('./kafka/consumer');
const { startFraudDecisionConsumer } = require('./events/fraudDecisionConsumer');
const outboxRelay = require('./outbox/outboxRelay');

const server = app.listen(env.port, () => {
  logger.info({ port: env.port }, 'transaction-service escuchando');
});

// Intento de conexión temprana al productor de Kafka: si el broker no está
// disponible al arrancar, el servicio sigue levantando igual (se reintenta
// de forma lazy en cada publish, ver src/kafka/producer.js).
ensureKafkaProducerConnected().catch((err) => {
  logger.error({ error: err.message }, 'No se pudo conectar el productor de Kafka al arrancar');
});

// El consumer de decisiones antifraude corre en segundo plano: si falla acá,
// se loguea pero no se tumba el servicio HTTP.
startFraudDecisionConsumer().catch((err) => {
  logger.error({ error: err.message }, 'El consumer de transaction.fraud-decision se detuvo inesperadamente');
});

// El relay del outbox es quien realmente publica transaction.created a
// Kafka (ver DECISIONS.md, "Patrón Outbox"). También corre en este proceso.
outboxRelay.start();

/**
 * Apagado ordenado: deja de aceptar conexiones HTTP nuevas, detiene el
 * relay del outbox, desconecta el consumer y el productor de Kafka, y por
 * último Prisma — en ese orden, para no cortar una publicación o una query
 * en curso a mitad de camino. Antes no se manejaba ninguna señal (ver
 * LIMITATIONS.md); ahora un `docker stop`/redeploy no debería cortar una
 * request en vuelo de forma abrupta.
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
  outboxRelay.stop();

  await Promise.allSettled([
    fraudDecisionConsumer.disconnect(),
    disconnectProducer(),
  ]);
  await prisma.$disconnect();

  clearTimeout(forceExitTimer);
  logger.info('Apagado ordenado completo');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
