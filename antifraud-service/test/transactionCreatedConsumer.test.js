/**
 * `t.mock.method` reemplaza `fraudDecisionPublisher.publishFraudDecision` y
 * `dlq.publishToDlq` por stubs durante cada test, sin un broker de Kafka
 * real. Funciona porque transactionCreatedConsumer.js importa esos módulos
 * como namespace en vez de desestructurarlos — ver el comentario en ese
 * archivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { handleMessage } = require('../src/events/transactionCreatedConsumer');
const fraudDecisionPublisher = require('../src/events/fraudDecisionPublisher');
const dlq = require('../src/kafka/dlq');

function transactionCreatedMessage({ transactionExternalId, value }) {
  const event = {
    eventId: randomUUID(),
    eventType: 'transaction.created',
    occurredAt: new Date().toISOString(),
    data: { transactionExternalId, value },
  };
  return { topic: 'transaction.created', partition: 0, message: { value: Buffer.from(JSON.stringify(event), 'utf8'), offset: '0' } };
}

test('un mensaje malformado no lanza error y se envía a la DLQ de transaction.created', async (t) => {
  const dlqCalls = [];
  t.mock.method(dlq, 'publishToDlq', async (args) => {
    dlqCalls.push(args);
  });

  await assert.doesNotReject(handleMessage({ topic: 'transaction.created', partition: 0, message: { value: Buffer.from('{not json', 'utf8'), offset: '0' } }));

  assert.equal(dlqCalls.length, 1);
  assert.equal(dlqCalls[0].originalTopic, 'transaction.created');
  assert.equal(dlqCalls[0].reason, 'invalid_event');
});

test('evalúa la regla y publica la decisión cuando todo funciona', async (t) => {
  const publishCalls = [];
  t.mock.method(fraudDecisionPublisher, 'publishFraudDecision', async (args) => {
    publishCalls.push(args);
  });

  const transactionExternalId = randomUUID();
  await handleMessage(transactionCreatedMessage({ transactionExternalId, value: 5000 }));

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].transactionExternalId, transactionExternalId);
  assert.equal(publishCalls[0].status, 'rejected');
});

test('si publicar la decisión falla siempre, se agotan los reintentos y se envía a la DLQ de transaction.fraud-decision', async (t) => {
  t.mock.method(fraudDecisionPublisher, 'publishFraudDecision', async () => {
    throw new Error('broker inalcanzable (simulado)');
  });
  const dlqCalls = [];
  t.mock.method(dlq, 'publishToDlq', async (args) => {
    dlqCalls.push(args);
  });

  const transactionExternalId = randomUUID();
  await assert.doesNotReject(handleMessage(transactionCreatedMessage({ transactionExternalId, value: 100 })));

  assert.equal(dlqCalls.length, 1);
  assert.equal(dlqCalls[0].originalTopic, 'transaction.fraud-decision');
  assert.equal(dlqCalls[0].reason, 'publish_retries_exhausted');
  assert.equal(dlqCalls[0].event.transactionExternalId, transactionExternalId);
});
