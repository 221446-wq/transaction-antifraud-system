/**
 * Prueba el patrón Outbox de punta a punta contra Postgres real, sin un
 * broker de Kafka real: `t.mock.method` reemplaza
 * `kafkaPublisher.publishEvent`/`dlq.publishToDlq` por un stub durante cada
 * test (y los restaura solo al terminar ese test). Funciona porque
 * outboxRelay.js importa esos módulos como namespace en vez de
 * desestructurarlos — ver el comentario en ese archivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const prisma = require('../src/db/prismaClient');
const transactionService = require('../src/services/transactionService');
const outboxRelay = require('../src/outbox/outboxRelay');
const kafkaPublisher = require('../src/kafka/publishEvent');
const dlq = require('../src/kafka/dlq');

const VALID_TRANSFER_TYPE_ID = 1; // "transfer", sembrado por la migración inicial

async function createTransactionWithOutbox(value = 100) {
  return transactionService.createTransaction({
    accountExternalIdDebit: randomUUID(),
    accountExternalIdCredit: randomUUID(),
    transferTypeId: VALID_TRANSFER_TYPE_ID,
    value,
  });
}

async function cleanup(transaction) {
  await prisma.outboxEvent.deleteMany({ where: { aggregateId: transaction.externalId } });
  await prisma.transaction.delete({ where: { externalId: transaction.externalId } });
}

test.after(async () => {
  await prisma.$disconnect();
});

test('crear una transacción encola su evento transaction.created en el outbox, en la misma escritura', async () => {
  const transaction = await createTransactionWithOutbox();

  const outboxRow = await prisma.outboxEvent.findFirst({ where: { aggregateId: transaction.externalId } });

  assert.ok(outboxRow, 'debería existir una fila de outbox para la transacción recién creada');
  assert.equal(outboxRow.eventType, 'transaction.created');
  assert.equal(outboxRow.publishedAt, null);
  assert.equal(outboxRow.payload.data.transactionExternalId, transaction.externalId);
  assert.equal(outboxRow.payload.data.value, 100);

  await cleanup(transaction);
});

test('el relay publica un evento pendiente y lo marca publicado', async (t) => {
  const transaction = await createTransactionWithOutbox(250);
  const calls = [];

  t.mock.method(kafkaPublisher, 'publishEvent', async (args) => {
    calls.push(args);
  });

  await outboxRelay.publishPendingBatch();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].topic, 'transaction.created');
  assert.equal(calls[0].key, transaction.externalId);

  const outboxRow = await prisma.outboxEvent.findFirst({ where: { aggregateId: transaction.externalId } });
  assert.ok(outboxRow.publishedAt, 'publishedAt debería quedar seteado tras un publish exitoso');

  await cleanup(transaction);
});

test('si Kafka falla, el evento no se marca publicado y queda registrado el intento', async (t) => {
  const transaction = await createTransactionWithOutbox(300);

  t.mock.method(kafkaPublisher, 'publishEvent', async () => {
    throw new Error('broker inalcanzable (simulado)');
  });

  await outboxRelay.publishPendingBatch();

  const outboxRow = await prisma.outboxEvent.findFirst({ where: { aggregateId: transaction.externalId } });
  assert.equal(outboxRow.publishedAt, null);
  assert.equal(outboxRow.attempts, 1);
  assert.equal(outboxRow.lastError, 'broker inalcanzable (simulado)');
  assert.equal(outboxRow.deadLetteredAt, null);

  await cleanup(transaction);
});

test('tras agotar los reintentos, el evento se manda a la DLQ y se deja de reintentar', async (t) => {
  const transaction = await createTransactionWithOutbox(400);

  // Simula que ya fallaron 9 intentos anteriores: el próximo fallo cruza el
  // límite (MAX_ATTEMPTS=10 por defecto) y dispara el envío a la DLQ.
  await prisma.outboxEvent.updateMany({
    where: { aggregateId: transaction.externalId },
    data: { attempts: 9 },
  });

  t.mock.method(kafkaPublisher, 'publishEvent', async () => {
    throw new Error('broker inalcanzable (simulado)');
  });
  const dlqCalls = [];
  t.mock.method(dlq, 'publishToDlq', async (args) => {
    dlqCalls.push(args);
  });

  await outboxRelay.publishPendingBatch();

  assert.equal(dlqCalls.length, 1);
  assert.equal(dlqCalls[0].reason, 'outbox_max_attempts_exceeded');
  assert.equal(dlqCalls[0].originalTopic, 'transaction.created');

  const outboxRow = await prisma.outboxEvent.findFirst({ where: { aggregateId: transaction.externalId } });
  assert.equal(outboxRow.attempts, 10);
  assert.ok(outboxRow.deadLetteredAt, 'deadLetteredAt debería quedar seteado tras agotar los reintentos');

  await cleanup(transaction);
});

test('publishPendingBatch ignora filas ya publicadas o dead-lettered', async (t) => {
  const calls = [];
  t.mock.method(kafkaPublisher, 'publishEvent', async (args) => {
    calls.push(args);
  });

  const processed = await outboxRelay.publishPendingBatch();
  assert.equal(processed, 0);
  assert.equal(calls.length, 0);
});
