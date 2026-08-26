const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/db/prismaClient');

const VALID_DEBIT = '2b894fb0-09f1-4d46-a610-0c92a5c4e113';
const VALID_CREDIT = '045d5400-e3cf-4e57-9fe4-a9815eeec2c4';
const VALID_TRANSFER_TYPE_ID = 1; // sembrado por la migración inicial ("transfer")

function validPayload(overrides = {}) {
  return {
    accountExternalIdDebit: VALID_DEBIT,
    accountExternalIdCredit: VALID_CREDIT,
    transferTypeId: VALID_TRANSFER_TYPE_ID,
    value: 100,
    ...overrides,
  };
}

test.after(async () => {
  await prisma.$disconnect();
});

test('UUID inválido en accountExternalIdDebit responde 400 con mensaje claro', async () => {
  const res = await request(app)
    .post('/transactions')
    .send(validPayload({ accountExternalIdDebit: 'no-es-un-uuid' }));

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [{ field: 'accountExternalIdDebit', message: 'Debe ser un UUID válido.' }],
  });
});

test('UUID inválido en accountExternalIdCredit responde 400 con mensaje claro', async () => {
  const res = await request(app)
    .post('/transactions')
    .send(validPayload({ accountExternalIdCredit: 'tampoco-es-un-uuid' }));

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [{ field: 'accountExternalIdCredit', message: 'Debe ser un UUID válido.' }],
  });
});

test('value negativo responde 400 con mensaje claro', async () => {
  const res = await request(app)
    .post('/transactions')
    .send(validPayload({ value: -50 }));

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [{ field: 'value', message: 'Debe ser mayor a 0.' }],
  });
});

test('value = 0 responde 400 con mensaje claro', async () => {
  const res = await request(app)
    .post('/transactions')
    .send(validPayload({ value: 0 }));

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [{ field: 'value', message: 'Debe ser mayor a 0.' }],
  });
});

test('body vacío: reporta los 4 campos obligatorios faltantes, con 400', async () => {
  const res = await request(app).post('/transactions').send({});

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [
      { field: 'accountExternalIdDebit', message: 'Es un campo requerido.' },
      { field: 'accountExternalIdCredit', message: 'Es un campo requerido.' },
      { field: 'transferTypeId', message: 'Es un campo requerido.' },
      { field: 'value', message: 'Es un campo requerido.' },
    ],
  });
});

test('falta un único campo obligatorio (accountExternalIdDebit) responde 400', async () => {
  const payload = validPayload();
  delete payload.accountExternalIdDebit;

  const res = await request(app).post('/transactions').send(payload);

  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    errors: [{ field: 'accountExternalIdDebit', message: 'Es un campo requerido.' }],
  });
});

test('control: un payload válido no responde 400 (confirma que los rechazos anteriores son por la razón correcta)', async () => {
  const res = await request(app).post('/transactions').send(validPayload());

  assert.equal(res.status, 201);

  await prisma.outboxEvent.deleteMany({ where: { aggregateId: res.body.transactionExternalId } });
  await prisma.transaction.delete({ where: { externalId: res.body.transactionExternalId } });
});
