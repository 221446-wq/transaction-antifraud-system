const { consumer } = require('../kafka/consumer');
const { applyFraudDecision, VALID_DECISION_STATUSES } = require('../services/fraudDecisionService');
const { publishToDlq } = require('../kafka/dlq');
const logger = require('../logger');

const TOPIC = 'transaction.fraud-decision';

function parseEvent(rawValue) {
  const event = JSON.parse(rawValue);
  const transactionExternalId = event?.data?.transactionExternalId;
  const status = event?.data?.status;

  if (typeof transactionExternalId !== 'string' || transactionExternalId.length === 0) {
    throw new Error('El evento no trae un data.transactionExternalId válido.');
  }
  if (!VALID_DECISION_STATUSES.includes(status)) {
    throw new Error(`El evento trae un data.status inválido: ${JSON.stringify(status)}.`);
  }

  return { transactionExternalId, status };
}

async function handleMessage({ message }) {
  const rawValue = message.value ? message.value.toString('utf8') : null;

  // Mensaje mal formado o con datos fuera de contrato: no tiene sentido
  // reintentarlo indefinidamente, se descarta a una DLQ y se deja registro.
  let decision;
  try {
    decision = parseEvent(rawValue);
  } catch (err) {
    logger.error({ error: err.message, rawValue }, 'transaction.fraud-decision inválido, se descarta a la DLQ.');
    await publishToDlq({
      originalTopic: TOPIC,
      reason: 'invalid_event',
      error: err.message,
      rawValue,
    });
    return;
  }

  const result = await applyFraudDecision(decision);

  if (!result.applied) {
    if (result.reason === 'not_found') {
      logger.error(decision, 'transaction.fraud-decision referencia una transacción que no existe.');
    } else {
      logger.info(
        { ...decision, currentStatus: result.currentStatus },
        'transaction.fraud-decision ignorado: la transacción ya tenía un estado definitivo (evento duplicado o fuera de orden).',
      );
    }
    return;
  }

  logger.info(decision, 'Transacción actualizada por decisión antifraude.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A diferencia del productor (que reintenta conectar en cada publish, porque
 * hay una petición HTTP nueva cada vez), un consumer de fondo no tiene ese
 * disparador natural: si el intento inicial falla, nadie lo vuelve a llamar.
 * Por eso reintenta indefinidamente con espera fija hasta lograr conectar,
 * sin bloquear el resto del servicio (Express ya está escuchando).
 */
async function connectWithRetry(retryDelayMs = 5000) {
  for (;;) {
    try {
      await consumer.connect();
      return;
    } catch (err) {
      logger.error({ error: err.message, retryDelayMs }, `No se pudo conectar el consumer de ${TOPIC}, reintentando.`);
      await sleep(retryDelayMs);
    }
  }
}

async function startFraudDecisionConsumer() {
  await connectWithRetry();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({ eachMessage: handleMessage });
}

module.exports = { startFraudDecisionConsumer, TOPIC, parseEvent, handleMessage };
