const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/db/prismaClient');

const VALID_DEBIT = '2b894fb0-09f1-4d46-a610-0c92a5c4e113';
const VALID_CREDIT = '045d5400-e3cf-4e57-9fe4-a9815eeec2c4';
const VALID_TRANSFER_TYPE_ID = 1; // "transfer", sembrado por la migración inicial

function graphqlRequest(query, variables) {
  return request(app).post('/graphql').send({ query, variables });
}

test.after(async () => {
  await prisma.$disconnect();
});

test('mutation createTransaction crea la transacción y encola su outbox, igual que POST /transactions', async () => {
  const mutation = `
    mutation Create($input: CreateTransactionInput!) {
      createTransaction(input: $input) {
        transactionExternalId
        transactionType { name }
        transactionStatus { name }
        value
      }
    }
  `;

  const res = await graphqlRequest(mutation, {
    input: {
      accountExternalIdDebit: VALID_DEBIT,
      accountExternalIdCredit: VALID_CREDIT,
      transferTypeId: VALID_TRANSFER_TYPE_ID,
      value: 150,
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.errors, undefined);
  const created = res.body.data.createTransaction;
  assert.equal(created.transactionType.name, 'transfer');
  assert.equal(created.transactionStatus.name, 'pending');
  assert.equal(created.value, 150);

  const outboxRow = await prisma.outboxEvent.findFirst({
    where: { aggregateId: created.transactionExternalId },
  });
  assert.ok(outboxRow, 'la mutation también debería encolar el evento en el outbox');

  await prisma.outboxEvent.deleteMany({ where: { aggregateId: created.transactionExternalId } });
  await prisma.transaction.delete({ where: { externalId: created.transactionExternalId } });
});

test('mutation createTransaction con value inválido responde un error BAD_USER_INPUT con el detalle por campo', async () => {
  const mutation = `
    mutation Create($input: CreateTransactionInput!) {
      createTransaction(input: $input) { transactionExternalId }
    }
  `;

  const res = await graphqlRequest(mutation, {
    input: {
      accountExternalIdDebit: VALID_DEBIT,
      accountExternalIdCredit: VALID_CREDIT,
      transferTypeId: VALID_TRANSFER_TYPE_ID,
      value: -10,
    },
  });

  assert.equal(res.status, 200); // GraphQL siempre responde 200; el error viaja en el body
  assert.equal(res.body.data, null);
  assert.equal(res.body.errors[0].extensions.code, 'BAD_USER_INPUT');
  assert.deepEqual(res.body.errors[0].extensions.errors, [
    { field: 'value', message: 'Debe ser mayor a 0.' },
  ]);
});

test('query transaction devuelve la transacción creada por REST (comparte la misma capa de servicio)', async () => {
  const created = await request(app)
    .post('/transactions')
    .send({
      accountExternalIdDebit: VALID_DEBIT,
      accountExternalIdCredit: VALID_CREDIT,
      transferTypeId: VALID_TRANSFER_TYPE_ID,
      value: 75,
    });

  const query = `
    query Get($externalId: ID!) {
      transaction(externalId: $externalId) {
        transactionExternalId
        value
        transactionStatus { name }
      }
    }
  `;

  const res = await graphqlRequest(query, { externalId: created.body.transactionExternalId });

  assert.equal(res.status, 200);
  assert.equal(res.body.errors, undefined);
  assert.equal(res.body.data.transaction.transactionExternalId, created.body.transactionExternalId);
  assert.equal(res.body.data.transaction.value, 75);

  await prisma.outboxEvent.deleteMany({ where: { aggregateId: created.body.transactionExternalId } });
  await prisma.transaction.delete({ where: { externalId: created.body.transactionExternalId } });
});

test('query transaction con un id inexistente responde un error NOT_FOUND', async () => {
  const query = `
    query Get($externalId: ID!) {
      transaction(externalId: $externalId) { transactionExternalId }
    }
  `;

  const res = await graphqlRequest(query, { externalId: '00000000-0000-0000-0000-000000000000' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data, null);
  assert.equal(res.body.errors[0].extensions.code, 'NOT_FOUND');
});
