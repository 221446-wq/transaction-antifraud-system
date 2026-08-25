const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const prisma = require('../src/db/prismaClient');
const { handleMessage } = require('../src/events/fraudDecisionConsumer');
const { applyFraudDecision } = require('../src/services/fraudDecisionService');

const VALID_TRANSFER_TYPE_ID = 1; // "transfer", sembrado por la migración inicial

async function createPendingTransaction(value = 100) {
  return prisma.transaction.create({
    data: {
      accountExternalIdDebit: randomUUID(),
      accountExternalIdCredit: randomUUID(),
      transferTypeId: VALID_TRANSFER_TYPE_ID,
      value,
    },
  });
}

function fraudDecisionMessage({ transactionExternalId, status }) {
  const event = {
    eventId: randomUUID(),
    eventType: 'transaction.fraud-decision',
    occurredAt: new Date().toISOString(),
    data: { transactionExternalId, status },
  };
  return { message: { value: Buffer.from(JSON.stringify(event), 'utf8') } };
}

async function currentStatus(externalId) {
  const tx = await prisma.transaction.findUnique({ where: { externalId } });
  return tx.status;
}

test.after(async () => {
  await prisma.$disconnect();
});

test('primer procesamiento: pending pasa a approved', async () => {
  const transaction = await createPendingTransaction();

  await assert.doesNotReject(
    handleMessage(fraudDecisionMessage({ transactionExternalId: transaction.externalId, status: 'approved' })),
  );

  assert.equal(await currentStatus(transaction.externalId), 'approved');

  await prisma.transaction.delete({ where: { externalId: transaction.externalId } });
});

test('mismo evento transaction.fraud-decision procesado dos veces: el segundo es un no-op idempotente', async () => {
  const transaction = await createPendingTransaction();
  const rawMessage = fraudDecisionMessage({ transactionExternalId: transaction.externalId, status: 'approved' });

  // 1er procesamiento: aplica la decisión.
  await assert.doesNotReject(handleMessage(rawMessage));
  assert.equal(await currentStatus(transaction.externalId), 'approved');

  // 2do procesamiento del MISMO evento (duplicado exacto, mismos bytes):
  // no debe lanzar, ni cambiar nada.
  await assert.doesNotReject(handleMessage(rawMessage));
  assert.equal(await currentStatus(transaction.externalId), 'approved');

  await prisma.transaction.delete({ where: { externalId: transaction.externalId } });
});

test('una decisión en conflicto llegada tarde no sobrescribe el estado ya resuelto', async () => {
  const transaction = await createPendingTransaction();

  await handleMessage(fraudDecisionMessage({ transactionExternalId: transaction.externalId, status: 'approved' }));
  assert.equal(await currentStatus(transaction.externalId), 'approved');

  // "rejected" llega después (evento duplicado/fuera de orden con un
  // resultado distinto): no debe lanzar ni pisar el approved ya aplicado.
  await assert.doesNotReject(
    handleMessage(fraudDecisionMessage({ transactionExternalId: transaction.externalId, status: 'rejected' })),
  );
  assert.equal(await currentStatus(transaction.externalId), 'approved');

  await prisma.transaction.delete({ where: { externalId: transaction.externalId } });
});

test('una decisión para una transacción inexistente no lanza error', async () => {
  const nonExistentId = randomUUID();

  await assert.doesNotReject(
    handleMessage(fraudDecisionMessage({ transactionExternalId: nonExistentId, status: 'approved' })),
  );

  const tx = await prisma.transaction.findUnique({ where: { externalId: nonExistentId } });
  assert.equal(tx, null);
});

test('un mensaje malformado no lanza error, se descarta', async () => {
  await assert.doesNotReject(
    handleMessage({ message: { value: Buffer.from('{not json', 'utf8') } }),
  );
});

test('dos decisiones concurrentes sobre la misma transacción: gana exactamente una, sin errores', async () => {
  const transaction = await createPendingTransaction();

  const [approvedResult, rejectedResult] = await Promise.all([
    applyFraudDecision({ transactionExternalId: transaction.externalId, status: 'approved' }),
    applyFraudDecision({ transactionExternalId: transaction.externalId, status: 'rejected' }),
  ]);

  // Ninguna de las dos llamadas debe rechazar (ya lo garantiza el await de
  // Promise.all sin catch), y exactamente una debe haber aplicado el
  // cambio: el UPDATE condicional en Postgres serializa la carrera.
  const appliedCount = [approvedResult, rejectedResult].filter((r) => r.applied).length;
  assert.equal(appliedCount, 1, 'exactamente una de las dos decisiones concurrentes debería haberse aplicado');

  const finalStatus = await currentStatus(transaction.externalId);
  assert.ok(['approved', 'rejected'].includes(finalStatus), 'el estado final debe ser uno de los dos, sin corromperse');

  await prisma.transaction.delete({ where: { externalId: transaction.externalId } });
});
