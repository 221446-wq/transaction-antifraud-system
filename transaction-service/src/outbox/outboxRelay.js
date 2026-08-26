const prisma = require('../db/prismaClient');
// Se importan como namespace (no desestructurados) a propósito: los tests
// monkey-patchean `kafkaPublisher.publishEvent`/`dlq.publishToDlq` para
// simular fallos de Kafka sin un broker real (ver test/outbox.test.js). Una
// desestructuración capturaría la referencia original y el monkey-patch no
// tendría efecto.
const kafkaPublisher = require('../kafka/publishEvent');
const dlq = require('../kafka/dlq');
const logger = require('../logger');

const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 500;
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE) || 20;
// Tras esta cantidad de intentos fallidos, el evento se manda a la DLQ y se
// deja de reintentar: un fallo persistente (p.ej. un payload que el broker
// rechaza siempre) no debe trabar el resto de la cola del outbox para
// siempre.
const MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS) || 10;

/**
 * El único componente que lee `outbox_events` y publica a Kafka. Corre en
 * el mismo proceso que el servidor HTTP (ver index.js) por simplicidad de
 * despliegue en el alcance de este proyecto; nada le impide correr como un
 * proceso separado si hiciera falta escalarlo independientemente — ver
 * DECISIONS.md.
 */
async function publishOutboxRow(row) {
  try {
    await kafkaPublisher.publishEvent({ topic: row.eventType, key: row.aggregateId, event: row.payload });
    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: { publishedAt: new Date() },
    });
    logger.info({ eventId: row.eventId, eventType: row.eventType, aggregateId: row.aggregateId }, 'outbox: evento publicado');
  } catch (err) {
    const attempts = row.attempts + 1;
    const shouldDeadLetter = attempts >= MAX_ATTEMPTS;

    await prisma.outboxEvent.update({
      where: { id: row.id },
      data: {
        attempts,
        lastError: err.message,
        ...(shouldDeadLetter ? { deadLetteredAt: new Date() } : {}),
      },
    });

    if (shouldDeadLetter) {
      logger.error(
        { eventId: row.eventId, eventType: row.eventType, attempts, error: err.message },
        'outbox: se agotaron los reintentos, el evento se envía a la DLQ',
      );
      await dlq.publishToDlq({
        originalTopic: row.eventType,
        reason: 'outbox_max_attempts_exceeded',
        error: err.message,
        event: row.payload,
        key: row.aggregateId,
      });
    } else {
      logger.warn(
        { eventId: row.eventId, eventType: row.eventType, attempts, error: err.message },
        'outbox: fallo al publicar, se reintentará en el próximo ciclo',
      );
    }
  }
}

async function publishPendingBatch() {
  const rows = await prisma.outboxEvent.findMany({
    where: { publishedAt: null, deadLetteredAt: null },
    orderBy: { id: 'asc' },
    take: BATCH_SIZE,
  });

  for (const row of rows) {
    // Secuencial, no Promise.all: mantiene el orden de publicación dentro de
    // un mismo ciclo y evita saturar al productor con ráfagas grandes.
    // eslint-disable-next-line no-await-in-loop
    await publishOutboxRow(row);
  }

  return rows.length;
}

let active = false;
let timer = null;

/**
 * `setTimeout` que se reprograma a sí mismo recién cuando el ciclo anterior
 * termina — no `setInterval`. Con Kafka caído o lento, un ciclo puede tardar
 * más que `OUTBOX_POLL_INTERVAL_MS` (la conexión del productor tiene su
 * propio timeout/reintentos); un `setInterval` habría disparado el ciclo
 * siguiente de todas formas, superponiendo dos corridas de
 * `publishPendingBatch()` sobre las mismas filas todavía no marcadas como
 * publicadas — se detectó exactamente así, corriendo el relay en vivo sin
 * Kafka disponible (dos intentos de publish, dos envíos a la DLQ, para el
 * mismo evento). Encadenar el siguiente `setTimeout` solo al terminar el
 * actual elimina la superposición sin necesitar un lock explícito.
 */
async function runCycle() {
  try {
    await publishPendingBatch();
  } catch (err) {
    logger.error({ error: err.message }, 'outbox: error inesperado en el ciclo del relay');
  } finally {
    if (active) {
      timer = setTimeout(runCycle, POLL_INTERVAL_MS);
    }
  }
}

function start() {
  if (active) return;
  active = true;
  logger.info({ pollIntervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE }, 'outbox: relay iniciado');
  runCycle();
}

function stop() {
  active = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

module.exports = { start, stop, publishPendingBatch };
