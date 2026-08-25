const { consumer } = require('../kafka/consumer');
const { evaluateFraudRule } = require('../rules/fraudRule');
const { publishFraudDecision } = require('./fraudDecisionPublisher');

// Tópico definido en CONTRACT.md (Tarea 0): transaction-service lo publica
// inmediatamente después de guardar la transacción como "pending".
const TOPIC = 'transaction.created';

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

async function handleMessage({ message }) {
  const rawValue = message.value ? message.value.toString('utf8') : null;

  // Mensaje mal formado o fuera de contrato: no tiene sentido reintentarlo
  // indefinidamente, se descarta y se deja registro.
  let transaction;
  try {
    transaction = parseEvent(rawValue);
  } catch (err) {
    console.error('Evento de transaction.created inválido, se descarta.', {
      error: err.message,
      rawValue,
    });
    return;
  }

  const status = evaluateFraudRule(transaction.value);

  // No atrapamos errores de publish acá a propósito: si falla, dejamos que
  // se propague para que este mensaje NO se dé por procesado (KafkaJS no
  // confirma el offset) y se reintente más adelante. Como evaluateFraudRule
  // es una función pura, reprocesar el mismo mensaje produce la misma
  // decisión, así que reintentar es seguro.
  await publishFraudDecision({
    transactionExternalId: transaction.transactionExternalId,
    status,
  });

  console.log('Decisión antifraude publicada.', { ...transaction, status });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function startTransactionCreatedConsumer() {
  await connectWithRetry();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });
  await consumer.run({ eachMessage: handleMessage });
}

module.exports = { startTransactionCreatedConsumer, TOPIC, parseEvent, handleMessage };
