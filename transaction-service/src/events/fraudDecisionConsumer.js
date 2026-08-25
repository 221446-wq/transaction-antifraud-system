const { consumer } = require('../kafka/consumer');
const { applyFraudDecision, VALID_DECISION_STATUSES } = require('../services/fraudDecisionService');

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
  // reintentarlo indefinidamente, se descarta y se deja registro.
  let decision;
  try {
    decision = parseEvent(rawValue);
  } catch (err) {
    console.error('Evento de transaction.fraud-decision inválido, se descarta.', {
      error: err.message,
      rawValue,
    });
    return;
  }

  const result = await applyFraudDecision(decision);

  if (!result.applied) {
    if (result.reason === 'not_found') {
      console.error(
        'transaction.fraud-decision referencia una transacción que no existe.',
        decision,
      );
    } else {
      console.log(
        'transaction.fraud-decision ignorado: la transacción ya tenía un estado definitivo (evento duplicado o fuera de orden).',
        { ...decision, currentStatus: result.currentStatus },
      );
    }
    return;
  }

  console.log('Transacción actualizada por decisión antifraude.', decision);
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
      console.error(
        `No se pudo conectar el consumer de ${TOPIC}, reintentando en ${retryDelayMs}ms.`,
        err.message,
      );
      await sleep(retryDelayMs);
    }
  }
}

async function startFraudDecisionConsumer() {
  await connectWithRetry();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({ eachMessage: handleMessage });
}

module.exports = { startFraudDecisionConsumer, TOPIC };
