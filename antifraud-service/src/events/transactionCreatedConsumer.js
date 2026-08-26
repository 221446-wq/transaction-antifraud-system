const { consumer } = require('../kafka/consumer');
const { evaluateFraudRule } = require('../rules/fraudRule');
const { withRetry, sleep } = require('../utils/retry');
const logger = require('../logger');
const metrics = require('../metrics');
// Namespace, no desestructurados: los tests monkey-patchean
// `fraudDecisionPublisher.publishFraudDecision`/`dlq.publishToDlq` para
// simular fallos de Kafka sin un broker real (ver
// test/transactionCreatedConsumer.test.js).
const fraudDecisionPublisher = require('./fraudDecisionPublisher');
const dlq = require('../kafka/dlq');

const PUBLISH_RETRY_OPTIONS = { retries: 3, initialDelayMs: 200, factor: 2 };

// Tópico definido en CONTRACT.md (Tarea 0): transaction-service lo publica
// inmediatamente después de guardar la transacción como "pending".
const TOPIC = 'transaction.created';

let consumerConnected = false;

function parseEvent(rawValue) {
  const event = JSON.parse(rawValue);
  const transactionExternalId = event?.data?.transactionExternalId;
  const value = event?.data?.value;

  if (typeof transactionExternalId !== 'string' || transactionExternalId.length === 0) {
    throw new Error('El evento no trae un data.transactionExternalId válido.');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`El evento trae un data.value inválido: ${JSON.stringify(value)}.`);
  }

  return { transactionExternalId, value };
}

async function handleMessage({ topic, partition, message }) {
  const rawValue = message.value ? message.value.toString('utf8') : null;

  logger.debug({ topic, partition, offset: message.offset }, 'Mensaje de transaction.created recibido.');

  // Mensaje mal formado o fuera de contrato: no tiene sentido reintentarlo
  // indefinidamente, se descarta a una DLQ y se deja registro.
  let transaction;
  try {
    transaction = parseEvent(rawValue);
  } catch (err) {
    logger.error({ error: err.message, rawValue }, 'transaction.created inválido, se descarta a la DLQ.');
    await dlq.publishToDlq({ originalTopic: TOPIC, reason: 'invalid_event', error: err.message, rawValue });
    return;
  }

  const status = evaluateFraudRule(transaction.value);
  metrics.transactionsEvaluatedTotal.inc({ status });

  logger.info(
    { transactionExternalId: transaction.transactionExternalId, value: transaction.value, status },
    'Decisión antifraude tomada.',
  );

  // Reintenta la publicación con backoff (fallos temporales de Kafka no
  // deberían perder una decisión). Si aun así se agotan los reintentos, se
  // manda a la DLQ y se sigue con el próximo mensaje: un fallo persistente
  // en una transacción puntual no debe trabar el resto del procesamiento
  // del consumer.
  try {
    await withRetry(
      () => fraudDecisionPublisher.publishFraudDecision({
        transactionExternalId: transaction.transactionExternalId,
        status,
      }),
      PUBLISH_RETRY_OPTIONS,
    );
  } catch (err) {
    metrics.fraudDecisionPublishErrorsTotal.inc();
    logger.error(
      { transactionExternalId: transaction.transactionExternalId, status, retries: PUBLISH_RETRY_OPTIONS.retries, error: err.message },
      'Error definitivo: no se pudo publicar la decisión antifraude tras agotar los reintentos, se envía a la DLQ.',
    );
    await dlq.publishToDlq({
      originalTopic: 'transaction.fraud-decision',
      reason: 'publish_retries_exhausted',
      error: err.message,
      event: { transactionExternalId: transaction.transactionExternalId, status },
      key: transaction.transactionExternalId,
    });
    return;
  }

  logger.info({ transactionExternalId: transaction.transactionExternalId, status }, 'transaction.fraud-decision publicado.');
}

/**
 * Un consumer de fondo no tiene un disparador natural para reintentar (a
 * diferencia de un producer, al que una nueva petición HTTP le da otra
 * oportunidad). Por eso reintenta indefinidamente con espera fija hasta
 * lograr conectar, sin bloquear el resto del servicio.
 */
async function connectWithRetry(retryDelayMs = 5000) {
  for (;;) {
    try {
      await consumer.connect();
      consumerConnected = true;
      return;
    } catch (err) {
      consumerConnected = false;
      logger.error({ error: err.message, retryDelayMs }, `No se pudo conectar el consumer de ${TOPIC}, reintentando.`);
      await sleep(retryDelayMs);
    }
  }
}

async function startTransactionCreatedConsumer() {
  await connectWithRetry();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({ eachMessage: handleMessage });
}

function isConsumerConnected() {
  return consumerConnected;
}

module.exports = {
  startTransactionCreatedConsumer,
  TOPIC,
  parseEvent,
  handleMessage,
  isConsumerConnected,
};
